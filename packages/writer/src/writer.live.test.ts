import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { loadCeiling, runLints, validate, type UserAuthority } from "@mandate-dev/validator";
import { writeMandate, WRITER_TOOLS, type AnthropicLike, type WriteRequest } from "./writer.js";

// The one thing a stub cannot tell us: whether the real model, given the real
// tool schema, calls it with something the real validator accepts. Two
// `claude-opus-5-5` calls at effort `high`, so it costs money and is gated on
// an explicit opt-in as well as on credentials -- `pnpm test` must never bill
// anyone by accident, and CI needs no secret.
//
//   MANDATE_LIVE=1 pnpm --filter @mandate-dev/writer test
const live = process.env["MANDATE_LIVE"] === "1" && process.env["ANTHROPIC_API_KEY"] !== undefined;

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/ceilings/${name}`, import.meta.url)), "utf8");

/** Wraps a real client so the test can report what the two calls actually cost. */
const recordingUsage = (real: Anthropic, into: Anthropic.Usage[]): AnthropicLike => ({
  messages: {
    stream: (params) => {
      const stream = real.messages.stream(params);
      return {
        finalMessage: async () => {
          const message = await stream.finalMessage();
          into.push(message.usage);
          return message;
        },
      };
    },
  },
});

describe.skipIf(!live)("the tool schemas the writer sends", () => {
  // Free: countTokens validates the request shape and runs no model. This is
  // the cheap half of the live suite and it guards a whole class of bug -- a
  // schema the API refuses makes every write fail with a 400, and the first
  // version of these tools carried a `minimum` on an integer, which it does.
  it("are accepted by the API", async () => {
    const client = new Anthropic();
    for (const tool of WRITER_TOOLS) {
      const counted = await client.messages.countTokens({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "probe" }],
        tools: [tool],
      });
      expect(counted.input_tokens).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe.skipIf(!live)("writeMandate against the live API", () => {
  it("writes a mandate the validator accepts, and reports what it cost", async () => {
    const usage: Anthropic.Usage[] = [];
    const client = recordingUsage(new Anthropic(), usage);

    const ceiling = loadCeiling(
      "org-policy@v12", fixture("org-policy-v12.cedar"), fixture("schema.cedarschema"),
    );
    const req: WriteRequest = {
      task: "Fix issue #42: the retry loop in src/retry.ts swallows the last error "
        + "instead of rethrowing it. Add a regression test and open a pull request.",
      repo: "acme/api",
      requestedBy: "user:alice",
      ceiling,
      issueNumber: 42,
    };

    const result = await writeMandate(client, req);

    // Both tool calls happened, or writeMandate would have thrown.
    expect(usage).toHaveLength(2);

    const input = usage.reduce((n, u) => n + u.input_tokens, 0);
    const output = usage.reduce((n, u) => n + u.output_tokens, 0);
    const thinking = usage.reduce((n, u) => n + (u.output_tokens_details?.thinking_tokens ?? 0), 0);
    // Claude API list prices for claude-opus-5-5: $4/MTok in, $20/MTok out.
    const dollars = (input / 1e6) * 4 + (output / 1e6) * 20;
    console.log(
      `live write: ${input} input, ${output} output (${thinking} thinking) tokens `
      + `across ${usage.length} calls, $${dollars.toFixed(4)}, ${result.latencyMs}ms`,
    );
    console.log(`covered: ${result.covered.join(", ")}`);
    console.log(`pruned:  ${result.pruned.join(", ") || "(nothing)"}`);
    console.log(JSON.stringify(result.proposed, null, 2));

    // R2's whole point: the proposal has to survive the validator.
    expect(runLints(result.proposed)).toEqual([]);

    const authority: UserAuthority = { login: "alice", level: "push" };
    const decision = validate(result.proposed, { ceiling, authority });
    if (!decision.ok) {
      throw new Error(`the live writer was rejected: ${JSON.stringify(decision.rejections, null, 2)}`);
    }

    // The task cannot finish without these, whatever else the model chose.
    const actions = result.proposed.grants.map((g) => g.action);
    expect(actions).toContain("contents.write");
    expect(actions).toContain("pull_request.create");

    // PRD success metric: write latency under 10s.
    console.log(`write latency ${result.latencyMs}ms against a 10s target`);
  }, 300_000);
});
