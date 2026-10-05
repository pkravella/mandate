import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { loadCeiling, runLints, validate, type UserAuthority } from "@mandate-dev/validator";
import { WriterError } from "./errors.js";
import { writeMandate, type AnthropicLike, type WriteRequest } from "./writer.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/ceilings/${name}`, import.meta.url)), "utf8");

interface Reply {
  readonly stop_reason: Anthropic.StopReason | null;
  readonly content: Anthropic.ContentBlock[];
  readonly stop_details?: Anthropic.RefusalStopDetails | null;
}

interface Recorder {
  readonly client: AnthropicLike;
  readonly sent: Anthropic.MessageStreamParams[];
}

/**
 * A client seam the tests can satisfy with a plain object literal and no cast.
 * That is the point of the narrow `AnthropicLike`: the writer reads three
 * fields off a response, so a stub only has to supply three fields.
 */
const replying = (replies: readonly Reply[]): Recorder => {
  const sent: Anthropic.MessageStreamParams[] = [];
  let call = 0;
  return {
    sent,
    client: {
      messages: {
        stream: (params) => {
          sent.push(params);
          const reply = replies[call++];
          if (reply === undefined) throw new Error("stub: unexpected extra call");
          return {
            finalMessage: async () => ({
              stop_reason: reply.stop_reason,
              stop_details: reply.stop_details ?? null,
              content: reply.content,
            }),
          };
        },
      },
    },
  };
};

const toolUse = (name: string, input: unknown): Anthropic.ContentBlock =>
  ({ type: "tool_use", id: "tu", name, input, caller: { type: "direct" } });

/** The happy path: a propose call, then a keep call. */
const stub = (toolInputs: readonly unknown[]): Recorder =>
  replying(toolInputs.map((input, i) => ({
    stop_reason: "tool_use",
    content: [toolUse(i === 0 ? "propose_grants" : "keep_grants", input)],
  })));

const ceiling = loadCeiling(
  "org-policy@v12", fixture("org-policy-v12.cedar"), fixture("schema.cedarschema"),
  fixture("org-policy-v12.destinations"),
);

const req: WriteRequest = {
  task: "Fix issue #42 and open a PR", repo: "acme/api",
  requestedBy: "user:alice", ceiling, issueNumber: 42,
};

const FIX_42 = [
  {
    grants: [
      { action: "contents.write", resources: ["acme/api"], branches: ["agent/42-fix"], paths: ["**"] },
      { action: "pull_request.create", resources: ["acme/api"], branches: ["agent/42-fix"], base: "main", max: 1 },
      { action: "actions.read", resources: ["acme/api"] },
    ],
    destinations: ["github.com/acme/api"],
  },
  { keep: ["contents.write", "pull_request.create"] },
];

describe("writeMandate", () => {
  it("covers, prunes and emits a schema-valid ProposedMandate", async () => {
    const r = await writeMandate(stub(FIX_42).client, req);
    const actions = r.proposed.grants.map((g) => g.action);
    expect(actions).toContain("contents.write");
    expect(actions).toContain("pull_request.create");
    // Prerequisites survive pruning.
    expect(actions).toContain("repo.read");
    expect(actions).toContain("branch.create");
    // What the task did not need is gone.
    expect(actions).not.toContain("actions.read");
    expect(r.pruned).toContain("actions.read");
    expect(r.covered).toContain("actions.read");
  });

  it("marks branch- and path-limited grants as proxy-enforced (D4)", async () => {
    const r = await writeMandate(stub(FIX_42).client, req);
    expect(r.proposed.grants.find((g) => g.action === "contents.write")?.enforcedBy).toBe("proxy");
    expect(r.proposed.grants.find((g) => g.action === "repo.read")?.enforcedBy).toBe("token");
  });

  it("fails loudly when the model does not call the tool", async () => {
    const client = replying([{ stop_reason: "end_turn", content: [{ type: "text", text: "hello", citations: null }] }]).client;
    await expect(writeMandate(client, req)).rejects.toThrow("did not call propose_grants");
  });

  it("fails loudly on a refusal", async () => {
    const client = replying([{
      stop_reason: "refusal", content: [],
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    }]).client;
    await expect(writeMandate(client, req)).rejects.toThrow("writer refused");
  });

  // A truncated tool input can still parse: a `grants` array cut short is
  // valid JSON and valid against the schema, just not what the model meant.
  // Minting authority from a partial response is the fail-open case.
  it("refuses to mint from a truncated response", async () => {
    const client = replying([{
      stop_reason: "max_tokens",
      content: [toolUse("propose_grants", { grants: [{ action: "repo.read", resources: ["acme/api"] }], destinations: ["github.com/acme/api"] })],
    }]).client;
    await expect(writeMandate(client, req)).rejects.toThrow(/truncated/i);
  });

  it("refuses to mint when the context window was exceeded", async () => {
    const client = replying([{
      stop_reason: "model_context_window_exceeded",
      content: [toolUse("propose_grants", { grants: [{ action: "repo.read", resources: ["acme/api"] }], destinations: ["github.com/acme/api"] })],
    }]).client;
    await expect(writeMandate(client, req)).rejects.toThrow(WriterError);
  });

  it("refuses a stop reason it does not understand, rather than reading on", async () => {
    const client = replying([{
      stop_reason: "pause_turn",
      content: [toolUse("propose_grants", { grants: [{ action: "repo.read", resources: ["acme/api"] }], destinations: ["github.com/acme/api"] })],
    }]).client;
    await expect(writeMandate(client, req)).rejects.toThrow(WriterError);
  });

  it("refuses a proposal that names the same action twice", async () => {
    const client = stub([
      { grants: [
        { action: "issue.read", resources: ["acme/api"] },
        { action: "issue.read", resources: ["acme/other"] },
      ], destinations: ["github.com/acme/api"] },
      { keep: ["issue.read"] },
    ]).client;
    await expect(writeMandate(client, req)).rejects.toThrow(WriterError);
  });

  it("refuses a tool input that does not match the tool's schema", async () => {
    const client = replying([{
      stop_reason: "tool_use",
      content: [toolUse("propose_grants", { grants: "all of them" })],
    }]).client;
    await expect(writeMandate(client, req)).rejects.toThrow(WriterError);
  });

  it("refuses a repository that is not owner/name", async () => {
    await expect(writeMandate(stub(FIX_42).client, { ...req, repo: "acme/api/extra" }))
      .rejects.toThrow(/repository/i);
  });

  // The id is what an audit entry and a runtime pause name, and the live
  // writer produced `fix-issue-42-the-retry-loop-in-src-retry-ts-swal`.
  it("cuts a long mandate id at a word boundary", async () => {
    const r = await writeMandate(stub(FIX_42).client, {
      ...req,
      task: "Fix issue #42: the retry loop in src/retry.ts swallows the last error "
        + "instead of rethrowing it. Add a regression test and open a pull request.",
    });
    expect(r.proposed.mandate).toBe("fix-issue-42-the-retry-loop-in-src-retry-ts");
    expect(r.proposed.mandate).not.toMatch(/-$/);
  });

  it("falls back to a usable id when the task has no alphanumerics", async () => {
    const r = await writeMandate(stub(FIX_42).client, { ...req, task: "!!! ???" });
    expect(r.proposed.mandate).toBe("task");
  });

  it("records latency so the <10s write-latency metric is measurable", async () => {
    const client = stub([
      { grants: [{ action: "repo.read", resources: ["acme/api"] }], destinations: ["github.com/acme/api"] },
      { keep: ["repo.read"] },
    ]).client;
    expect((await writeMandate(client, req)).latencyMs).toBeGreaterThanOrEqual(0);
  });

  // The plan hardcoded the schema's 60-minute maximum, which hands every task
  // the longest authority lifetime the contract permits.
  it("defaults to a TTL well inside the 60-minute cap", async () => {
    const r = await writeMandate(stub(FIX_42).client, req);
    expect(r.proposed.expiresInMinutes).toBe(30);
  });

  it("honours a shorter TTL the request asks for", async () => {
    const r = await writeMandate(stub(FIX_42).client, { ...req, expiresInMinutes: 15 });
    expect(r.proposed.expiresInMinutes).toBe(15);
  });

  it("refuses a TTL above the cap rather than silently clamping it", async () => {
    await expect(writeMandate(stub(FIX_42).client, { ...req, expiresInMinutes: 90 }))
      .rejects.toThrow(WriterError);
  });

  it("asks Opus 5.5 with adaptive thinking, explicit effort and unforced tool choice", async () => {
    const rec = stub(FIX_42);
    await writeMandate(rec.client, req);
    expect(rec.sent).toHaveLength(2);
    for (const params of rec.sent) {
      expect(params.model).toBe("claude-opus-5-5");
      // Opus 5.5 defaults to `medium`; mandate writing is correctness-sensitive.
      expect(params.output_config?.effort).toBe("high");
      expect(params.thinking).toEqual({ type: "adaptive" });
      // Forced tool_choice is a 400 on this model.
      expect(params.tool_choice).toEqual({ type: "auto" });
      expect(params.tools?.every((t) => "strict" in t && t.strict === true)).toBe(true);
    }
  });

  // The test that would have caught the plan's central bug. Nothing the writer
  // proposes is worth anything if the validator rejects it.
  it("emits a mandate the validator accepts against the example ceiling", async () => {
    const r = await writeMandate(stub(FIX_42).client, req);
    expect(runLints(r.proposed)).toEqual([]);

    const authority: UserAuthority = { login: "alice", level: "push" };
    const result = validate(r.proposed, { ceiling, authority });
    if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.rejections, null, 2)}`);
    expect(result.ok).toBe(true);
  });

  // Not dropped and not sanitised: the validator says no, loudly, and that
  // rejection is what the adversarial suite is built to observe.
  it("passes a forbidden-risk proposal through for the validator to reject", async () => {
    const client = stub([
      { grants: [
        { action: "pull_request.read", resources: ["acme/api"] },
        { action: "pull_request.merge", resources: ["acme/api"], max: 1 },
      ], destinations: ["github.com/acme/api"] },
      { keep: ["pull_request.merge"] },
    ]).client;
    const r = await writeMandate(client, req);
    expect(r.proposed.grants.map((g) => g.action)).toContain("pull_request.merge");
    expect(runLints(r.proposed).map((f) => f.rule)).toContain("no-forbidden-risk-op");
  });
});
