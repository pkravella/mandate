import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { githubAppDeps } from "@mandate-dev/compiler";
import { Recorder, parseJsonl } from "@mandate-dev/proxy";
import { taskPrompt } from "./prompt.js";
import { seededIssues } from "./seed.js";
import { loadCorpus } from "./tasks.js";

/**
 * The unconstrained pass (Decision D8): each task run with the recorder on and
 * **no enforcement at all**, producing the ground-truth trace the replay
 * evaluator scores candidate mandates against.
 *
 * Why there is no proxy here. The recorder is wired into the proxy for the
 * mandated pass, but a proxy needs `ProxyRules`, and rules come from a mandate —
 * so routing the unconstrained pass through it would mean inventing a permissive
 * mandate, which is precisely what "unconstrained" is not. `Recorder` is
 * usable on its own, and the trace it writes declares `mode: "unconstrained"`,
 * so nothing downstream can mistake one of these for an enforced run.
 *
 * Nodes carry no `action`, because no rule attributed the call. That is what
 * `ActionNode.action` being optional is for, and the scorer keys on `tool`.
 *
 * Gated on `MANDATE_GROUND_TRUTH`, **not** on `MANDATE_BENCH`. Two reasons, and
 * both were nearly paid for: this pass costs 2.4x the mandated one, because the
 * agent is shown all 46 of the server's tools rather than the handful a mandate
 * grants; and it **overwrites the committed ground-truth traces**, which every
 * later score is measured against. Sharing a gate with the mandated sweep meant
 * running the bench package re-recorded ground truth and spent an extra ~$3 as a
 * side effect of asking for something else.
 *
 * Re-record only when the corpus or the task prompt changes, because a trace
 * recorded against a different question is not ground truth for this one.
 *
 *   MANDATE_GROUND_TRUTH=1 pnpm --filter @mandate-dev/bench exec vitest run src/unconstrained
 */
const env = (n: string): string | undefined => process.env[n];
const enabled = env("MANDATE_GROUND_TRUTH") === "1"
  && env("ANTHROPIC_API_KEY") !== undefined
  && env("MANDATE_APP_ID") !== undefined
  && env("MANDATE_INSTALLATION_ID") !== undefined
  && env("MANDATE_APP_KEY_PATH") !== undefined;

const CORPUS = fileURLToPath(new URL("../../../fixtures/bench", import.meta.url));
const TRACES = join(CORPUS, "traces");

/** Dollars this run may spend in total. Measured per task at roughly $0.63. */
const BUDGET = Number(env("MANDATE_GROUND_TRUTH_BUDGET") ?? "5.00");
/** Charged against the budget before a task starts, so the stop is predictive. */
const ESTIMATE_PER_TASK = 0.75;

const IN_PER_M = 4;
const OUT_PER_M = 20;
const MAX_TURNS = 18;

const dollars = (inTok: number, outTok: number): number =>
  (inTok / 1e6) * IN_PER_M + (outTok / 1e6) * OUT_PER_M;

interface TaskRun {
  readonly taskId: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly nodes: number;
  readonly tracePath: string;
}

describe.skipIf(!enabled)("the unconstrained pass", () => {
  it("records a ground-truth trace for every task the budget allows", async () => {
    const corpus = loadCorpus(CORPUS);
    const name = corpus.repo.split("/")[1] ?? "";
    const deps = githubAppDeps({
      appId: env("MANDATE_APP_ID") ?? "",
      installationId: Number(env("MANDATE_INSTALLATION_ID") ?? "0"),
      privateKeyPath: env("MANDATE_APP_KEY_PATH") ?? "",
    });

    // The issue number per task, read from the marker the seeder wrote. The
    // record does not carry it: an issue number is a fact about the repository,
    // not about the task, and hard-coding one would silently point a run at the
    // wrong issue after a re-seed.
    const tokenRes = await deps.asApp(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: Number(env("MANDATE_INSTALLATION_ID") ?? "0"),
        repositories: [name],
        permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
      },
    );
    expect(tokenRes.status, JSON.stringify(tokenRes.data)).toBe(201);
    const token = String((tokenRes.data as { token?: unknown }).token);

    const issueFor = await seededIssues(deps, token, corpus.repo);
    for (const task of corpus.tasks) {
      expect(issueFor[task.id], `${task.id} has no seeded issue`).toBeDefined();
    }

    const client = new Anthropic();
    const runs: TaskRun[] = [];
    const skipped: string[] = [];
    let spent = 0;

    for (const task of corpus.tasks) {
      // Predictive, not retrospective: stopping after the overspend is not a
      // budget stop.
      if (spent + ESTIMATE_PER_TASK > BUDGET) {
        skipped.push(task.id);
        continue;
      }

      const transport = new StdioClientTransport({
        command: "docker",
        args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
          "ghcr.io/github/github-mcp-server:latest"],
        env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: token } as Record<string, string>,
      });
      const upstream = new Client({ name: "bench-unconstrained", version: "0.1.0" });
      await upstream.connect(transport);

      try {
        const offered = (await upstream.listTools()).tools;
        const tools: Anthropic.Tool[] = offered.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        }));

        const recorder = new Recorder({ mode: "unconstrained" });
        const messages: Anthropic.MessageParam[] = [{
          role: "user",
          content: taskPrompt(task, corpus.repo, issueFor[task.id] ?? 0),
        }];

        let turns = 0;
        let inTok = 0;
        let outTok = 0;

        for (; turns < MAX_TURNS; turns += 1) {
          const reply = await client.messages.stream({
            model: "claude-opus-5-5",
            max_tokens: 16000,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
            tools,
            tool_choice: { type: "auto" },
            messages,
          }).finalMessage();
          inTok += reply.usage.input_tokens;
          outTok += reply.usage.output_tokens;
          messages.push({ role: "assistant", content: reply.content });

          const calls = reply.content.filter((c) => c.type === "tool_use");
          if (calls.length === 0) break;

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const call of calls) {
            if (call.type !== "tool_use") continue;
            const args = call.input !== null && typeof call.input === "object"
              ? (call.input as Record<string, unknown>)
              : {};
            const handle = recorder.recordCall({ tool: call.name, args });
            let out;
            try {
              out = await upstream.callTool({ name: call.name, arguments: args });
              handle.completed(out);
            } catch (e) {
              const detail = e instanceof Error ? e.message : String(e);
              handle.upstreamFailed(detail);
              out = { isError: true, content: [{ type: "text" as const, text: detail }] };
            }
            console.log(`    ${task.id}  ${out.isError === true ? "err " : "ok  "} ${call.name} `
              + `${JSON.stringify(args).slice(0, 90)}`);
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: JSON.stringify(out.content).slice(0, 4000),
              ...(out.isError === true ? { is_error: true } : {}),
            });
          }
          messages.push({ role: "user", content: results });
        }

        const cost = dollars(inTok, outTok);
        spent += cost;

        const jsonl = recorder.toJsonl();
        const tracePath = join(TRACES, `${task.id}.unconstrained.jsonl`);
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(tracePath, jsonl, "utf8");

        // A trace the recorder wrote that parseJsonl will not read back is a
        // format bug, and this is the first time the format meets a run with
        // every tool available rather than a mandate's handful.
        const reread = parseJsonl(jsonl);
        expect(reread.mode).toBe("unconstrained");
        expect(reread.mandateId).toBeUndefined();
        expect(reread.nodes.length).toBe(recorder.graph().nodes.length);

        runs.push({
          taskId: task.id, turns, inputTokens: inTok, outputTokens: outTok,
          cost, nodes: reread.nodes.length, tracePath,
        });
        console.log(
          `--- ${task.id}: ${turns} turns, ${inTok} in / ${outTok} out, `
          + `$${cost.toFixed(4)}, ${reread.nodes.length} nodes  (spent $${spent.toFixed(4)})`,
        );
      } finally {
        await upstream.close().catch(() => undefined);
      }
    }

    console.log(`\n=== unconstrained pass: ${runs.length} of ${corpus.tasks.length} tasks`);
    for (const r of runs) {
      console.log(`    ${r.taskId.padEnd(32)} ${String(r.turns).padStart(2)} turns  `
        + `${String(r.nodes).padStart(3)} nodes  $${r.cost.toFixed(4)}`);
    }
    console.log(`=== total $${spent.toFixed(4)} of a $${BUDGET.toFixed(2)} budget`);
    if (skipped.length > 0) {
      console.log(`=== skipped for budget: ${skipped.join(", ")}`);
    }

    expect(runs.length).toBeGreaterThan(0);
    // Every run must have recorded something, or the trace is not ground truth
    // about anything.
    for (const r of runs) expect(r.nodes, r.taskId).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(BUDGET);
  }, 3_600_000);
});
