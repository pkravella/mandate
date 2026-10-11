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
import { mandateHash, MandateSchema } from "@mandate-dev/schema";
import {
  applyPrior, costOf, inCorpusOrder, parseModes, runBench, loadGroundTruth, selectTasks,
  type BenchDeps,
} from "./harness.js";
import type { BenchResult } from "./report.js";
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

interface GithubCall { readonly route: string; readonly token: string; readonly params: Record<string, unknown> }

/**
 * Enough of a GitHub to mint, read a file, find a PR and run acceptance.
 *
 * `pulls` and `comments` are called on every listing, so a test can say what
 * existed before a run and what the run added. Every call is recorded with the
 * token it carried, and each mint hands out a distinct token.
 */
const fakeGithub = (opts: {
  pulls?: (listing: number) => readonly { number: number; head: { ref: string } }[];
  comments?: (listing: number) => readonly { id: number; body: string }[];
} = {}): {
  deps: MintDeps; revokes: () => number; calls: GithubCall[]; mints: Record<string, unknown>[];
} => {
  let revokes = 0;
  let minted = 0;
  let pullListings = 0;
  let commentListings = 0;
  const calls: GithubCall[] = [];
  const mints: Record<string, unknown>[] = [];
  return {
    revokes: () => revokes,
    calls,
    mints,
    deps: {
      installationId: 1,
      asApp: async (_route: string, params: Record<string, unknown> = {}) => {
        minted += 1;
        mints.push(params);
        return {
          status: 201,
          data: {
            token: `ghs_fake${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            // metadata:read included because mintToken refuses a token narrower
            // than requested -- leaving it out is what surfaced the leaked-token
            // bug this fake first tripped over.
            permissions: {
              contents: "write", issues: "write", pull_requests: "write", metadata: "read",
            },
            repositories: [{ name: "mandate-sandbox" }],
          },
        };
      },
      asInstallation: async (route: string, token: string, params: Record<string, unknown> = {}) => {
        calls.push({ route, token, params });
        if (route === "DELETE /installation/token") {
          revokes += 1;
          return { status: 204, data: null };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls") {
          pullListings += 1;
          return { status: 200, data: opts.pulls?.(pullListings) ?? [] };
        }
        if (route.startsWith("PATCH ") || route.startsWith("DELETE ")) {
          return { status: route.startsWith("DELETE ") ? 204 : 200, data: {} };
        }
        if (route.includes("/comments")) {
          commentListings += 1;
          return { status: 200, data: opts.comments?.(commentListings) ?? [] };
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
const fakeAnthropic = (opts: {
  agentCalls?: string[];
  /** Every request the agent loop made, in order. */
  agentRequests?: Anthropic.MessageStreamParams[];
  usage?: Partial<Anthropic.Usage>;
  /** Writer requests, counted. */
  writerRequests?: { n: number };
} = {}): Anthropic => {
  const toolUse = (name: string, input: unknown): Anthropic.ContentBlock =>
    ({ type: "tool_use", id: `tu-${name}`, name, input, caller: { type: "direct" } });

  let agentTurn = 0;
  return {
    messages: {
      stream: (params: Anthropic.MessageStreamParams) => {
        const names = toolNames(params);
        const content: Anthropic.ContentBlock[] = [];

        if (names.includes("propose_grants") && opts.writerRequests !== undefined) {
          opts.writerRequests.n += 1;
        }
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
          // The agent loop. One granted call, then stop. A conversation of
          // one message is a new run, which starts the script again.
          if (params.messages.length === 1) agentTurn = 0;
          // A copy: the harness appends to the same messages array afterwards.
          opts.agentRequests?.push({ ...params, messages: [...params.messages] });
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
            usage: { ...usage, ...opts.usage },
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
    // Every token minted -- the mandate's, and the one the harness grades
    // with -- is given back, though the session never opened.
    const revoked = gh.calls.filter((c) => c.route === "DELETE /installation/token").map((c) => c.token);
    expect(revoked.sort()).toEqual(gh.mints.map((_, i) => `ghs_fake${i + 1}`).sort());
    expect(gh.revokes()).toBe(2);
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

  // Task 6.4. The published cut could not be recomputed: the sweep kept
  // neither its mandates nor its results, and a trace header carries only the
  // mandate's id and hash. The result now carries the mandate that was
  // enforced, and the sweep writes its results beside its traces.
  it("keeps the mandate it enforced, and writes its results beside the traces", async () => {
    const deps = depsFor();
    const results = await runBench(oneTask(), deps);
    const kept = JSON.parse(readFileSync(join(deps.outDir, "results.json"), "utf8")) as unknown[];
    expect(kept).toHaveLength(1);
    const mandate = MandateSchema.parse((kept[0] as { mandate: unknown }).mandate);
    // The one the session was enforced under, not merely one the writer proposed.
    const files = readdirSync(deps.outDir).filter((f) => f.endsWith(".mandated.jsonl"));
    const trace = parseJsonl(readFileSync(join(deps.outDir, files[0] ?? ""), "utf8"));
    expect(trace.mode === "enforced" ? trace.mandateHash : "").toBe(mandateHash(mandate));
    expect(results[0]?.mandate).toBeDefined();
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
    // No mandate exists, so there is no authority for the report to cut.
    expect(results[0]?.mandate).toBeUndefined();
  });
});

const taskOf = (category: string) => {
  const corpus = loadCorpus(CORPUS);
  const task = corpus.tasks.find((t) => t.category === category);
  expect(task, `the corpus has no ${category} task`).toBeDefined();
  return { ...corpus, tasks: task === undefined ? [] : [task] };
};

/** The tool names the agent loop was offered, per run. */
const offeredPerRun = (requests: Anthropic.MessageStreamParams[]): string[][] =>
  requests.filter((r) => r.messages.length === 1).map(toolNames);

// Task 6.1. One mandate per task, run in each tool-visibility mode, so the
// difference between the modes is the mode and not a different mandate.
describe("runBench, in both tool-visibility modes", () => {
  it("writes one mandate per task and runs the agent once per mode under it", async () => {
    const writerRequests = { n: 0 };
    const results = await runBench(oneTask(), depsFor({
      anthropic: fakeAnthropic({ writerRequests }), modes: ["granted", "all"],
    }));
    expect(results.map((r) => r.visibility)).toEqual(["granted", "all"]);
    expect(writerRequests.n).toBe(1);
    expect(mandateHash(results[0]!.mandate!)).toBe(mandateHash(results[1]!.mandate!));
  });

  it("offers the agent only the granted tools in one mode and every tool in the other", async () => {
    const agentRequests: Anthropic.MessageStreamParams[] = [];
    await runBench(oneTask(), depsFor({
      anthropic: fakeAnthropic({ agentRequests }), modes: ["granted", "all"],
    }));
    const [granted, all] = offeredPerRun(agentRequests);
    expect(granted).not.toContain("merge_pull_request");
    expect(all).toContain("merge_pull_request");
  });

  // "You only have the tools listed" is false when every tool is listed, and a
  // prompt that differs between the modes would be what the comparison measured.
  it("gives the agent the same instructions in both modes, true in each", async () => {
    const agentRequests: Anthropic.MessageStreamParams[] = [];
    await runBench(oneTask(), depsFor({
      anthropic: fakeAnthropic({ agentRequests }), modes: ["granted", "all"],
    }));
    const first = agentRequests.filter((r) => r.messages.length === 1).map((r) => r.messages[0]);
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual(first[1]);
    expect(JSON.stringify(first[0])).not.toMatch(/only have the tools listed/);
  });

  // The first sweep's instruction said a tool carrying "Mandate limits" was
  // granted and any other refused -- which told the agent how to rule out an
  // ungranted tool without calling it. The offer-all triage run then never
  // attempted the comment its task needed. The instruction may say that a
  // call outside the mandate is refused; it must not say how to tell which.
  it("does not tell the agent how to recognise a granted tool", async () => {
    const agentRequests: Anthropic.MessageStreamParams[] = [];
    await runBench(oneTask(), depsFor({ anthropic: fakeAnthropic({ agentRequests }), modes: ["all"] }));
    const prompt = JSON.stringify(agentRequests[0]?.messages[0]);
    expect(prompt).toMatch(/refused/);
    expect(prompt).not.toMatch(/Mandate limits|granted within|description/i);
  });

  it("keeps each mode's trace, rather than the second overwriting the first", async () => {
    const deps = depsFor({ modes: ["granted", "all"] });
    await runBench(oneTask(), deps);
    const traces = readdirSync(deps.outDir).filter((f) => f.endsWith(".mandated.jsonl")).sort();
    expect(traces).toEqual([
      "retry-swallows-last-error.all.mandated.jsonl",
      "retry-swallows-last-error.granted.mandated.jsonl",
    ]);
  });

  it("charges the writer once, to the first mode's result", async () => {
    const results = await runBench(oneTask(), depsFor({ modes: ["granted", "all"] }));
    // The fake bills every call alike, so the first run carries the writer's
    // calls on top of the same agent run the second one made.
    expect(results[0]!.cost).toBeGreaterThan(results[1]!.cost);
  });

  it("records a rejected proposal once per mode, so each mode's completion counts it", async () => {
    const overAsking = fakeAnthropic();
    const stream = overAsking.messages.stream.bind(overAsking.messages);
    (overAsking.messages as { stream: unknown }).stream = (params: Anthropic.MessageStreamParams) => {
      const names = toolNames(params);
      if (!names.includes("propose_grants") && !names.includes("keep_grants")) return stream(params);
      const input = names.includes("propose_grants")
        ? {
          grants: [{ action: "pull_request.merge", resources: ["pkravella/mandate-sandbox"], max: 1 }],
          destinations: ["github.com/pkravella/mandate-sandbox"],
        }
        : { keep: ["pull_request.merge"] };
      return {
        finalMessage: async () => ({
          stop_reason: "tool_use", stop_details: null, usage,
          content: [{
            type: "tool_use", id: "tu", input, caller: { type: "direct" },
            name: names.includes("propose_grants") ? "propose_grants" : "keep_grants",
          }],
        }),
      };
    };
    const results = await runBench(oneTask(), depsFor({ anthropic: overAsking, modes: ["granted", "all"] }));
    expect(results.map((r) => [r.visibility, r.proposalRejected])).toEqual([["granted", true], ["all", true]]);
    expect(results[0]!.cost).toBeGreaterThan(0);
    expect(results[1]!.cost).toBe(0);
  });

  it("stops before a task whose runs across every mode would exceed the budget", async () => {
    // One mode fits under $0.50; two do not.
    expect(await runBench(oneTask(), depsFor({ budget: 0.5 }))).toHaveLength(1);
    expect(await runBench(oneTask(), depsFor({ budget: 0.5, modes: ["granted", "all"] }))).toHaveLength(0);
  });
});

// A pull request or a comment left by an earlier run -- an earlier sweep, or
// the other mode a moment ago -- was credited to whichever run looked next:
// the lookups searched every PR on the branch, closed ones included, and every
// comment on the issue.
describe("runBench grades only what the run itself did", () => {
  it("does not credit a pull request that existed before the run", async () => {
    const gh = fakeGithub({ pulls: () => [{ number: 3, head: { ref: "agent/retry-swallows-last-error" } }] });
    const results = await runBench(oneTask(), depsFor({ github: gh.deps }));
    expect(results[0]?.pullRequestOpened).toBe(false);
  });

  it("credits a pull request the run opened", async () => {
    const ref = { ref: "agent/retry-swallows-last-error" };
    const gh = fakeGithub({ pulls: (n) => (n === 1 ? [] : [{ number: 7, head: ref }]) });
    const results = await runBench(oneTask(), depsFor({ github: gh.deps }));
    expect(results[0]?.pullRequestOpened).toBe(true);
  });

  it("does not credit a triage comment left before the run", async () => {
    const gh = fakeGithub({ comments: () => [{ id: 1, body: "the timer leaks" }] });
    const results = await runBench(taskOf("triage"), depsFor({ github: gh.deps }));
    expect(results[0]?.completed).toBe(false);
  });

  it("credits a triage comment the run left", async () => {
    const gh = fakeGithub({ comments: (n) => (n === 1 ? [] : [{ id: 2, body: "the timer leaks" }]) });
    const results = await runBench(taskOf("triage"), depsFor({ github: gh.deps }));
    expect(results[0]?.completed).toBe(true);
  });

  it("closes the task's open pull requests and deletes its branch before each run", async () => {
    const ref = { ref: "agent/retry-swallows-last-error" };
    const gh = fakeGithub({ pulls: () => [{ number: 3, head: ref }] });
    await runBench(oneTask(), depsFor({ github: gh.deps, modes: ["granted", "all"] }));
    const closes = gh.calls.filter((c) => c.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    const deletes = gh.calls.filter((c) => c.route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}");
    expect(closes.map((c) => [c.params.pull_number, c.params.state])).toEqual([[3, "closed"], [3, "closed"]]);
    expect(deletes.map((c) => c.params.ref)).toEqual([
      "heads/agent/retry-swallows-last-error", "heads/agent/retry-swallows-last-error",
    ]);
  });

  // Grading with the mandate's token made the grade depend on the mandate: a
  // triage mandate without issues access could not read the comment it was
  // graded on.
  it("grades and resets with its own token, not the mandate's, and revokes it", async () => {
    const gh = fakeGithub();
    await runBench(oneTask(), depsFor({ github: gh.deps }));
    const housekeeping = gh.calls.filter((c) =>
      c.route.includes("/pulls") || c.route.includes("/contents/") || c.route.includes("/git/refs"));
    expect(housekeeping.length).toBeGreaterThan(0);
    const harnessMint = gh.mints.findIndex((m) =>
      (m.permissions as Record<string, string> | undefined)?.pull_requests === "write"
      && (m.permissions as Record<string, string> | undefined)?.issues === "read");
    expect(harnessMint, "no harness token was minted").toBeGreaterThanOrEqual(0);
    const harnessToken = `ghs_fake${harnessMint + 1}`;
    expect(new Set(housekeeping.map((c) => c.token))).toEqual(new Set([harnessToken]));
    expect(gh.calls.some((c) => c.route === "DELETE /installation/token" && c.token === harnessToken)).toBe(true);
  });
});

describe("runBench cost", () => {
  it("asks for prompt caching on every agent turn", async () => {
    const agentRequests: Anthropic.MessageStreamParams[] = [];
    await runBench(oneTask(), depsFor({ anthropic: fakeAnthropic({ agentRequests }) }));
    expect(agentRequests.length).toBeGreaterThan(0);
    for (const r of agentRequests) expect(r.cache_control).toEqual({ type: "ephemeral" });
  });

  // usage.input_tokens excludes cached tokens, so a formula reading only it
  // reports a cached run as nearly free.
  it("bills cache writes and cache reads, not only uncached input", () => {
    // Opus 5.5: $4 input, $20 output, cache writes 1.25x, cache reads $0.20.
    expect(costOf({
      input_tokens: 1_000_000, output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
    })).toBeCloseTo(4 + 20 + 5 + 0.2, 6);
    expect(costOf({
      input_tokens: 1_000_000, output_tokens: 0,
      cache_creation_input_tokens: null, cache_read_input_tokens: null,
    })).toBeCloseTo(4, 6);
  });
});

// The live sweep's switches, read from the environment. A typo must stop the
// sweep before it spends anything, not run something else.
describe("sweep options", () => {
  it("runs both modes by default, and reads a list", () => {
    expect(parseModes(undefined)).toEqual(["granted", "all"]);
    expect(parseModes("all")).toEqual(["all"]);
    expect(parseModes(" granted , all ")).toEqual(["granted", "all"]);
  });

  it("refuses a mode it does not know, or none", () => {
    expect(() => parseModes("offered")).toThrow(/offered/);
    expect(() => parseModes("")).toThrow();
  });

  it("selects the named tasks, in corpus order, or all of them", () => {
    const corpus = loadCorpus(CORPUS);
    const [first, second] = corpus.tasks;
    expect(selectTasks(corpus, undefined).subset).toBe(false);
    expect(selectTasks(corpus, undefined).corpus.tasks).toHaveLength(corpus.tasks.length);
    const picked = selectTasks(corpus, `${second?.id},${first?.id}`);
    expect(picked.subset).toBe(true);
    expect(picked.corpus.tasks.map((t) => t.id)).toEqual([first?.id, second?.id]);
  });

  it("refuses a task id it does not know", () => {
    expect(() => selectTasks(loadCorpus(CORPUS), "no-such-task")).toThrow(/no-such-task/);
  });
});

// Stage 2 of the 6.1 sweep reuses stage 1's paid-for run instead of buying it
// again. A task counts as done only if the earlier results cover it in every
// mode this sweep runs; anything partial is run again rather than mixed.
describe("reusing an earlier sweep's results", () => {
  const corpus = loadCorpus(CORPUS);
  const [first, second] = corpus.tasks;
  const prior = (taskId: string, visibility: "granted" | "all"): BenchResult =>
    ({ taskId, visibility, category: "single-file-fix" } as unknown as BenchResult);

  it("skips a task the earlier results cover in every mode, and keeps those results", () => {
    const earlier = [prior(first!.id, "granted"), prior(first!.id, "all")];
    const { corpus: rest, kept } = applyPrior(corpus, earlier, ["granted", "all"]);
    expect(rest.tasks.map((t) => t.id)).not.toContain(first!.id);
    expect(rest.tasks).toHaveLength(corpus.tasks.length - 1);
    expect(kept).toEqual(earlier);
  });

  it("runs a task again when the earlier results lack one of its modes, and drops them", () => {
    const { corpus: rest, kept } = applyPrior(corpus, [prior(first!.id, "granted")], ["granted", "all"]);
    expect(rest.tasks.map((t) => t.id)).toContain(first!.id);
    expect(kept).toEqual([]);
  });

  it("refuses results for a task the corpus does not have", () => {
    expect(() => applyPrior(corpus, [prior("no-such-task", "granted")], ["granted"])).toThrow(/no-such-task/);
  });

  it("puts merged results in corpus order, then mode order", () => {
    const merged = inCorpusOrder(corpus, [
      prior(second!.id, "all"), prior(first!.id, "all"), prior(second!.id, "granted"), prior(first!.id, "granted"),
    ], ["granted", "all"]);
    expect(merged.map((r) => `${r.taskId}:${r.visibility}`)).toEqual([
      `${first!.id}:granted`, `${first!.id}:all`, `${second!.id}:granted`, `${second!.id}:all`,
    ]);
  });
});
