import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unreachableOperations } from "@mandate-dev/catalog";
import { loadCeiling, validate, type UserAuthority } from "@mandate-dev/validator";
import {
  compileRules, enforcementReport, githubAppDeps, mintToken, revokeToken,
} from "@mandate-dev/compiler";
import {
  createProxyServer, makeArgumentEnforcer, parseJsonl, pauseRecord, Recorder,
  type Decision,
} from "@mandate-dev/proxy";
import { writeMandate } from "@mandate-dev/writer";
import { renderPermissionDiff, renderRejections } from "./diff.js";

/**
 * The whole loop, once, against real everything: the live model writes the
 * mandate, the real validator proves it, a real GitHub App token is minted for
 * one repository, the real github-mcp-server sits behind the proxy, and the
 * model is handed only the tools the mandate reaches.
 *
 * Spends money and writes to a real repository, so it needs MANDATE_LIVE=1 plus
 * the app's details and an API key.
 */
const env = (n: string): string | undefined => process.env[n];
const live = env("MANDATE_LIVE") === "1"
  && env("ANTHROPIC_API_KEY") !== undefined
  && env("MANDATE_APP_ID") !== undefined
  && env("MANDATE_INSTALLATION_ID") !== undefined
  && env("MANDATE_APP_KEY_PATH") !== undefined
  && env("MANDATE_TEST_REPO") !== undefined;

const fixture = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/ceilings/${n}`, import.meta.url)), "utf8");

const REPO = env("MANDATE_TEST_REPO") ?? "";
const [OWNER = "", NAME = ""] = REPO.split("/");

const ISSUE_BODY = `retry() in src/retry.js returns undefined when every attempt
fails, instead of rethrowing the last error. That makes a total failure
indistinguishable from a function that legitimately resolved with no value.
Expected: the last error is rethrown once the attempts are exhausted. The
existing tests do not catch this, so a regression test should be part of the fix.`;

const TASK = `Fix issue #1 in ${REPO}: ${ISSUE_BODY}\n`
  + `Add a regression test and open a pull request.`;

describe.skipIf(!live)("the whole loop, live", () => {
  it("fixes a real issue under a mandate, and the merge is blocked", async () => {
    const deps = githubAppDeps({
      appId: env("MANDATE_APP_ID") ?? "",
      installationId: Number(env("MANDATE_INSTALLATION_ID") ?? "0"),
      privateKeyPath: env("MANDATE_APP_KEY_PATH") ?? "",
    });

    // ---- 1. write -------------------------------------------------------
    const ceiling = loadCeiling(
      "sandbox@v1", fixture("sandbox-v1.cedar"), fixture("schema.cedarschema"),
      fixture("sandbox-v1.destinations"),
    );
    const written = await writeMandate(new Anthropic(), {
      task: TASK, repo: REPO, requestedBy: "user:pkravella", ceiling, issueNumber: 1,
    });
    console.log(`\n--- written in ${written.latencyMs}ms`);
    console.log(`covered: ${written.covered.join(", ")}`);
    console.log(`pruned:  ${written.pruned.join(", ") || "(nothing)"}`);
    if (written.droppedFacets.length > 0) {
      console.log(`dropped: ${written.droppedFacets.join(" | ")}`);
    }

    // ---- 2. validate ----------------------------------------------------
    // The requester owns the repository. fetchUserAuthority has its own tests;
    // this run is about the chain, not that one call.
    const authority: UserAuthority = { login: "pkravella", level: "admin" };
    const decision = validate(written.proposed, { ceiling, authority });
    if (!decision.ok) {
      console.log(renderRejections(decision.rejections, written.proposed));
      throw new Error("the live writer was rejected");
    }
    const mandate = decision.mandate;
    console.log(`\n${renderPermissionDiff(written.proposed, { color: false })}`);

    for (const row of enforcementReport(mandate)) {
      if (row.gaps.length > 0) console.log(`GAP  ${row.action}: ${row.gaps.join(" | ")}`);
    }

    // ---- 3. mint --------------------------------------------------------
    const minted = await mintToken(deps, mandate);
    console.log(`\n--- minted sha256 ${minted.fingerprint}, expires ${minted.expiresAt}`);
    console.log(`    permissions ${JSON.stringify(minted.permissions)}`);

    const rules = compileRules(mandate);
    const decisions: Decision[] = [];
    // R8. The recorder has only ever seen a fake upstream; this is the first
    // time it meets real github-mcp-server results.
    const recorder = new Recorder({
      mode: "enforced", mandateId: rules.mandateId, mandateHash: rules.mandateHash,
    });
    /** Which real results carry which result shape — the open question in Task 14. */
    const shapes = { structured: 0, textOnly: 0, emptyContent: 0, legacy: 0 };
    let upstream: Client | undefined;

    try {
      // ---- 4. the real github-mcp-server behind the proxy ---------------
      const transport = new StdioClientTransport({
        command: "docker",
        args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
          "ghcr.io/github/github-mcp-server:latest"],
        env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: minted.token } as Record<string, string>,
      });
      upstream = new Client({ name: "mandate-upstream", version: "0.1.0" });
      await upstream.connect(transport);

      const exposed = (await upstream.listTools()).tools.map((t) => t.name);
      const unreachable = unreachableOperations(
        mandate.grants.map((g) => g.action), exposed,
      );
      if (unreachable.length > 0) {
        console.log(`\n!!! granted but unreachable on this server: ${unreachable.join(", ")}`);
      }

      const proxy = createProxyServer({
        rules, upstream, enforceArguments: makeArgumentEnforcer(rules),
        onDecision: (d) => decisions.push(d),
        recorder,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const agentSide = new Client({ name: "agent", version: "0.1.0" });
      await Promise.all([proxy.connect(a), agentSide.connect(b)]);

      const offered = (await agentSide.listTools()).tools;
      console.log(`\n--- tools offered to the agent: ${offered.map((t) => t.name).join(", ")}`);
      expect(offered.map((t) => t.name)).not.toContain("merge_pull_request");

      // ---- 5. let the model do the work -------------------------------
      const tools: Anthropic.Tool[] = offered.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));

      const client = new Anthropic();
      const messages: Anthropic.MessageParam[] = [{
        role: "user",
        content: `${TASK}\n\nRepository: ${REPO}. You are working under a Mandate, so you `
          + `only have the tools listed and only within the limits in their descriptions. `
          + `Read a file before updating it, because an update needs its sha. When you are `
          + `done, say DONE.`,
      }];

      let turns = 0;
      let totalIn = 0;
      let totalOut = 0;
      for (; turns < 18; turns += 1) {
        const stream = client.messages.stream({
          model: "claude-opus-5-5",
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          tools,
          tool_choice: { type: "auto" },
          messages,
        });
        const reply = await stream.finalMessage();
        totalIn += reply.usage.input_tokens;
        totalOut += reply.usage.output_tokens;
        messages.push({ role: "assistant", content: reply.content });

        const calls = reply.content.filter((c) => c.type === "tool_use");
        if (calls.length === 0) break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of calls) {
          if (call.type !== "tool_use") continue;
          const args = call.input !== null && typeof call.input === "object"
            ? (call.input as Record<string, unknown>)
            : {};
          const out = await agentSide.callTool({ name: call.name, arguments: args });
          if (out.structuredContent !== undefined) shapes.structured += 1;
          else if (out["toolResult"] !== undefined) shapes.legacy += 1;
          else if (Array.isArray(out.content) && out.content.length > 0) shapes.textOnly += 1;
          else shapes.emptyContent += 1;
          console.log(`    ${out.isError === true ? "DENY " : "allow"} ${call.name} `
            + `${JSON.stringify(args).slice(0, 110)}`);
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify(out.content).slice(0, 4000),
            ...(out.isError === true ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });
      }

      const dollars = (totalIn / 1e6) * 4 + (totalOut / 1e6) * 20;
      console.log(`\n--- agent ran ${turns} turns, ${totalIn} in / ${totalOut} out, `
        + `$${dollars.toFixed(4)}`);

      // ---- 6. the exit criterion: the merge is blocked -----------------
      const merge = await agentSide.callTool({
        name: "merge_pull_request",
        arguments: { owner: OWNER, repo: NAME, pullNumber: 1 },
      });
      expect(merge.isError).toBe(true);
      console.log(`\n--- merge attempt: ${JSON.stringify(merge.content).slice(0, 200)}`);

      // ---- 7. what actually happened on GitHub ------------------------
      const prs = await deps.asInstallation(
        "GET /repos/{owner}/{repo}/pulls", minted.token, { owner: OWNER, repo: NAME },
      );
      const openPrs = Array.isArray(prs.data) ? prs.data : [];
      console.log(`--- open pull requests: ${openPrs.length}`);
      expect(openPrs.length).toBeGreaterThan(0);

      const denials = decisions.filter((d) => d.kind === "deny");
      console.log(`--- decisions: ${decisions.length} total, ${denials.length} denied`);
      for (const d of denials) {
        if (d.kind !== "deny") continue;
        const record = pauseRecord({ mandateId: rules.mandateId, decision: d, observed: {} });
        console.log(`    ${d.clause}  widen=${record.widenRequest === undefined ? "no" : "yes"}`);
      }

      // ---- 8. the action graph (R8) ------------------------------------
      const graph = recorder.graph();
      console.log(`\n--- result shapes from the real server: ${JSON.stringify(shapes)}`);
      console.log(`--- recorded ${graph.nodes.length} nodes`);
      for (const n of graph.nodes) {
        console.log(`    ${String(n.seq).padStart(2)} ${n.decision === "deny" ? "DENY " : "allow"} `
          + `${n.tool} ${n.action ?? "(no action)"} ${n.resource ?? ""} `
          + `${n.branch ?? ""} ${n.paths.join(",")} `
          + `${n.outcome ?? n.clause ?? ""} ${n.outputBytes}b ${n.durationMs}ms`);
      }

      // The recorder and onDecision must see the same number of events. A path
      // that reports a decision but records no node is how a denial disappears
      // from the trace Task 17 scores against, and only a real run exercises
      // every path at once.
      expect(graph.nodes.length).toBe(decisions.length);
      expect(graph.nodes.map((n) => n.decision))
        .toEqual(decisions.map((d) => (d.kind === "deny" ? "deny" : "allow")));

      // The format has to survive real data: real tool names, real paths, real
      // digests, real timestamps. parseJsonl is strict and fails closed, so a
      // trace the proxy wrote that it will not read back is a format bug.
      const jsonl = recorder.toJsonl();
      const traceFile = join(tmpdir(), `mandate-${rules.mandateId}.jsonl`);
      writeFileSync(traceFile, jsonl, "utf8");
      console.log(`--- trace written to ${traceFile}`);
      const reread = parseJsonl(jsonl);
      expect(reread).toEqual(graph);
      expect(reread.mandateHash).toBe(rules.mandateHash);

      // Nothing the agent read may sit in the trace in the clear. The task
      // reads src/retry.js, so its contents are the thing to look for.
      expect(jsonl).not.toContain("lastError");
      expect(jsonl).not.toContain(minted.token);
    } finally {
      if (upstream !== undefined) await upstream.close().catch(() => undefined);
      await revokeToken(deps, minted.token).catch(() => undefined);
      console.log(`--- token sha256 ${minted.fingerprint} revoked`);
    }
  }, 900_000);
});
