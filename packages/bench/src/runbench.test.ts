import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MintDeps } from "@mandate-dev/compiler";
import { loadCeiling, type UserAuthority } from "@mandate-dev/validator";
import { parseJsonl } from "@mandate-dev/proxy";
import { runBench, loadGroundTruth, type BenchDeps } from "./harness.js";
import { loadCorpus } from "./tasks.js";

/**
 * `runBench` offline.
 *
 * It had no test. The function that produces every number in
 * `docs/benchmark-report.md` was verified only by the $1.15 live gate, which
 * means a refactor of it could not be checked without paying for a sweep — and
 * the one thing that made it untestable was a hardcoded `docker run` for the
 * upstream. With that injected, every dependency is a fake and the whole loop
 * runs for nothing.
 *
 * This is not a substitute for the live sweep: a fake agent cannot tell you
 * whether a real model finishes a real task. It is the guard that the loop
 * still mints, enforces, records, scores and accounts for cost in the right
 * order, which is what a refactor can break silently.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const CORPUS = root("fixtures/bench");

const ceiling = loadCeiling(
  "sandbox@v1",
  readFileSync(root("fixtures/ceilings/sandbox-v1.cedar"), "utf8"),
  readFileSync(root("fixtures/ceilings/schema.cedarschema"), "utf8"),
  readFileSync(root("fixtures/ceilings/sandbox-v1.destinations"), "utf8"),
);

const AUTHORITY: UserAuthority = { login: "bench", level: "admin" };

/**
 * `tools` is a union, and only some members carry a name — a server tool does
 * not. Narrowing rather than casting keeps the stub honest about what it reads.
 */
const toolNames = (params: Anthropic.MessageStreamParams): string[] =>
  (params.tools ?? []).flatMap((t) => ("name" in t && typeof t.name === "string" ? [t.name] : []));

/** Enough of a GitHub to mint, read a file, find a PR and run acceptance. */
const fakeGithub = (opts: { prNumber?: number; acceptance?: boolean } = {}): {
  deps: MintDeps; revokes: () => number;
} => {
  let revokes = 0;
  return {
    revokes: () => revokes,
    deps: {
      installationId: 1,
      asApp: async () => ({
        status: 201,
        data: {
          token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          // metadata:read included because mintToken refuses a token narrower
          // than requested -- leaving it out is what surfaced the leaked-token
          // bug this fake first tripped over.
          permissions: {
            contents: "write", issues: "write", pull_requests: "write", metadata: "read",
          },
          repositories: [{ name: "mandate-sandbox" }],
        },
      }),
      asInstallation: async (route: string) => {
        if (route === "DELETE /installation/token") {
          revokes += 1;
          return { status: 204, data: null };
        }
        if (route.includes("/pulls")) {
          return opts.prNumber === undefined
            ? { status: 200, data: [] }
            : {
              status: 200,
              data: [{
                number: opts.prNumber,
                head: { ref: "agent/x" },
                base: { ref: "main" },
              }],
            };
        }
        if (route.includes("/files")) {
          return { status: 200, data: [{ filename: "src/retry.js" }] };
        }
        if (route.includes("/contents/")) {
          return {
            status: 200,
            data: { content: Buffer.from("module.exports = {};\n").toString("base64") },
          };
        }
        return { status: 200, data: {} };
      },
    },
  };
};

/** An upstream that accepts everything and records what reached it. */
const fakeUpstream = (seen: { tool: string }[]) => async (): Promise<Client> => {
  const server = new Server({ name: "fake", version: "0" }, { capabilities: { tools: {} } });
  const TOOLS = [
    "get_file_contents", "create_branch", "create_or_update_file",
    "create_pull_request", "merge_pull_request", "add_issue_comment",
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((name) => ({
      name, description: `does ${name}`, inputSchema: { type: "object" as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.push({ tool: req.params.name });
    return { content: [{ type: "text" as const, text: "ok" }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fake-up", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const usage = { input_tokens: 1000, output_tokens: 200 };

/**
 * A model that proposes a sound mandate, then makes one granted call and stops.
 *
 * Replies are matched on what the writer and the agent loop each ask for rather
 * than counted, because the number of writer calls is the writer's business and
 * a positional stub breaks the moment cover-then-prune changes shape.
 */
const fakeAnthropic = (opts: { agentCalls?: string[] } = {}): Anthropic => {
  const toolUse = (name: string, input: unknown): Anthropic.ContentBlock =>
    ({ type: "tool_use", id: `tu-${name}`, name, input, caller: { type: "direct" } });

  let agentTurn = 0;
  return {
    messages: {
      stream: (params: Anthropic.MessageStreamParams) => {
        const names = toolNames(params);
        const content: Anthropic.ContentBlock[] = [];

        if (names.includes("propose_grants")) {
          content.push(toolUse("propose_grants", {
            grants: [
              {
                action: "contents.write", resources: ["pkravella/mandate-sandbox"],
                branches: ["agent/*"], paths: ["**"],
              },
              {
                action: "pull_request.create", resources: ["pkravella/mandate-sandbox"],
                branches: ["agent/*"], base: "main", max: 1,
              },
            ],
            destinations: ["github.com/pkravella/mandate-sandbox"],
          }));
        } else if (names.includes("keep_grants")) {
          content.push(toolUse("keep_grants", {
            keep: ["contents.write", "pull_request.create"],
          }));
        } else {
          // The agent loop. One granted call, then stop.
          const want = opts.agentCalls ?? ["get_file_contents"];
          const next = want[agentTurn];
          agentTurn += 1;
          if (next !== undefined) {
            content.push(toolUse(next, {
              owner: "pkravella", repo: "mandate-sandbox", path: "src/retry.js",
              branch: "agent/x", message: "m", content: "x", title: "t", head: "agent/x",
              base: "main",
            }));
          }
        }

        return {
          finalMessage: async () => ({
            stop_reason: content.length > 0 ? "tool_use" : "end_turn",
            stop_details: null,
            content,
            usage,
          }),
        };
      },
    },
  } as unknown as Anthropic;
};

const depsFor = (over: Partial<BenchDeps> = {}): BenchDeps => {
  const corpus = loadCorpus(CORPUS);
  const outDir = mkdtempSync(join(tmpdir(), "mandate-bench-out-"));
  mkdirSync(dirname(join(outDir, "x")), { recursive: true });
  return {
    anthropic: fakeAnthropic(),
    github: fakeGithub().deps,
    installationId: 1,
    ceiling,
    authority: AUTHORITY,
    groundTruth: loadGroundTruth(CORPUS, corpus),
    issues: Object.fromEntries(corpus.tasks.map((t, i) => [t.id, i + 7])),
    outDir,
    upstream: fakeUpstream([]),
    log: (m: string) => { if (process.env.BENCH_DEBUG) console.log('LOG:', m); },
    ...over,
  };
};

const oneTask = () => {
  const corpus = loadCorpus(CORPUS);
  const first = corpus.tasks[0];
  expect(first, "the corpus is empty").toBeDefined();
  return { ...corpus, tasks: first === undefined ? [] : [first] };
};

describe("runBench, offline", () => {
  it("runs a task end to end and returns a scored result", async () => {
    const results = await runBench(oneTask(), depsFor());
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r?.proposalRejected).toBe(false);
    // The score is a property of the mandate and the committed ground truth,
    // so it is computed even though no real agent ran.
    expect(r?.score.granted).toBeGreaterThan(0);
    expect(r?.writeLatencyMs).toBeGreaterThanOrEqual(0);
    expect(r?.cost).toBeGreaterThan(0);
  });

  // The harness hard-coded `requestedBy: user:bench` while the live sweep
  // validated as pkravella, so every benchmark mandate named a requester whose
  // authority nobody checked. With the requester now checked, a hard-coded
  // label would refuse every task run as anyone but "bench".
  it("names the identity it validates as, so a run as another login is not refused", async () => {
    const results = await runBench(oneTask(), depsFor({ authority: { login: "pkravella", level: "admin" } }));
    expect(results[0]?.proposalRejected).toBe(false);
  });

  it("revokes the token for every task, including when the run fails", async () => {
    const gh = fakeGithub();
    await runBench(oneTask(), depsFor({
      github: gh.deps,
      upstream: async () => { throw new Error("docker is not running"); },
    }));
    expect(gh.revokes(), "a session that could not open still minted a token").toBe(1);
  });

  it("writes a trace the strict parser reads back", async () => {
    const deps = depsFor();
    await runBench(oneTask(), deps);
    const files = readdirSync(deps.outDir).filter((f) => f.endsWith(".mandated.jsonl"));
    expect(files).toHaveLength(1);
    const trace = parseJsonl(readFileSync(join(deps.outDir, files[0] ?? ""), "utf8"));
    // A mandated trace must claim the mandate it was enforced under. An
    // unconstrained trace cannot, by construction of RecorderMeta.
    expect(trace.mode).toBe("enforced");
    if (trace.mode === "enforced") expect(trace.mandateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the proxy's denial rather than forwarding an ungranted call", async () => {
    const seen: { tool: string }[] = [];
    const results = await runBench(oneTask(), depsFor({
      anthropic: fakeAnthropic({ agentCalls: ["merge_pull_request"] }),
      upstream: fakeUpstream(seen),
    }));
    // The mandate grants no merge, so the proxy refuses and nothing reaches the
    // upstream. This is the property the whole project exists for, asserted at
    // the level of the loop rather than the enforcer.
    expect(seen.map((s) => s.tool)).not.toContain("merge_pull_request");
    expect(results[0]?.deniedCalls).toBeGreaterThan(0);
  });

  it("stops before a task that would exceed the budget rather than after", async () => {
    const results = await runBench(oneTask(), depsFor({ budget: 0 }));
    expect(results).toHaveLength(0);
  });

  it("skips a task with no ground truth instead of scoring it against nothing", async () => {
    const results = await runBench(oneTask(), depsFor({ groundTruth: {} }));
    expect(results).toHaveLength(0);
  });

  it("records a rejected proposal as a failed task and still charges the writer", async () => {
    // A writer that proposes a merge. The validator refuses it, nothing is
    // minted, and the cost of asking is still real.
    const overAsking = {
      messages: {
        stream: (params: Anthropic.MessageStreamParams) => {
          const names = toolNames(params);
          const input = names.includes("propose_grants")
            ? {
              grants: [{ action: "pull_request.merge", resources: ["pkravella/mandate-sandbox"], max: 1 }],
              destinations: ["github.com/pkravella/mandate-sandbox"],
            }
            : { keep: ["pull_request.merge"] };
          return {
            finalMessage: async () => ({
              stop_reason: "tool_use" as const,
              stop_details: null,
              content: [{
                type: "tool_use" as const, id: "tu",
                name: names.includes("propose_grants") ? "propose_grants" : "keep_grants",
                input, caller: { type: "direct" as const },
              }],
              usage,
            }),
          };
        },
      },
    } as unknown as Anthropic;

    const gh = fakeGithub();
    const results = await runBench(oneTask(), depsFor({ anthropic: overAsking, github: gh.deps }));
    expect(results).toHaveLength(1);
    expect(results[0]?.proposalRejected).toBe(true);
    expect(results[0]?.completed).toBe(false);
    expect(results[0]?.cost).toBeGreaterThan(0);
    expect(gh.revokes(), "nothing was minted, so nothing is revoked").toBe(0);
  });
});
