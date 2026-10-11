import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { MandateSchema, type Mandate } from "@mandate-dev/schema";
import { loadCeiling, type UserAuthority } from "@mandate-dev/validator";
import { loadGroundTruth } from "./harness.js";
import type { BenchResult } from "./report.js";
import { loadCorpus } from "./tasks.js";
import {
  compareMandates, parseSettings, runWriterSweep, summarizeWriterSweep,
  type WriterSweepDeps, type WriterSweepRecord,
} from "./writer-sweep.js";

/**
 * Task 6.2's measurement: the same tasks' mandates written at several effort
 * settings, each compared with the mandate the published sweep wrote at
 * `high`. The over-grant and adversarial suites cannot judge this -- neither
 * calls the model -- so the comparison is the quality gate.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const CORPUS = root("fixtures/bench");
const ceiling = loadCeiling(
  "sandbox@v1",
  readFileSync(root("fixtures/ceilings/sandbox-v1.cedar"), "utf8"),
  readFileSync(root("fixtures/ceilings/schema.cedarschema"), "utf8"),
  readFileSync(root("fixtures/ceilings/sandbox-v1.destinations"), "utf8"),
);
const AUTHORITY: UserAuthority = { login: "pkravella", level: "admin" };
const REPO = "pkravella/mandate-sandbox";

const mandate = (over: Partial<Mandate> = {}): Mandate => MandateSchema.parse({
  mandate: "fix-issue-7", task: "Fix issue #7 in pkravella/mandate-sandbox.",
  requestedBy: "user:pkravella", expiresInMinutes: 30, ceiling: "sandbox@v1",
  grants: [
    { action: "repo.read", enforcedBy: "token", resources: [REPO] },
    {
      action: "contents.write", enforcedBy: "proxy", resources: [REPO],
      branches: ["agent/x"], paths: ["**"], denyPaths: [".github/workflows/**"],
    },
  ],
  destinations: { allow: [`github.com/${REPO}`] },
  ...over,
});

describe("compareMandates", () => {
  it("finds nothing between a mandate and itself", () => {
    expect(compareMandates(mandate(), mandate())).toEqual([]);
  });

  it("names a grant one has and the other lacks", () => {
    const fewer = mandate({ grants: [mandate().grants[0]!] });
    expect(compareMandates(mandate(), fewer)).toEqual(["contents.write: missing"]);
    expect(compareMandates(fewer, mandate())).toEqual(["contents.write: extra"]);
  });

  it("names a facet that differs on a grant both have", () => {
    const g = mandate().grants;
    const wider = mandate({ grants: [g[0]!, { ...g[1]!, branches: ["agent/*"] }] });
    expect(compareMandates(mandate(), wider)).toEqual(['contents.write.branches: ["agent/x"] -> ["agent/*"]']);
  });

  it("ignores the order of patterns, which means nothing", () => {
    const g = mandate().grants;
    const a = mandate({ grants: [g[0]!, { ...g[1]!, denyPaths: [".github/workflows/**", "**/.env*"] }] });
    const b = mandate({ grants: [g[0]!, { ...g[1]!, denyPaths: ["**/.env*", ".github/workflows/**"] }] });
    expect(compareMandates(a, b)).toEqual([]);
  });

  it("names a destination difference", () => {
    expect(compareMandates(mandate(), mandate({ destinations: { allow: ["github.com/other/repo"] } })))
      .toEqual([`destinations: ["github.com/${REPO}"] -> ["github.com/other/repo"]`]);
  });
});

describe("parseSettings", () => {
  it("defaults to the control and the two candidates", () => {
    expect(parseSettings(undefined)).toEqual([
      { cover: "high", prune: "high" }, { cover: "high", prune: "low" }, { cover: "medium", prune: "medium" },
    ]);
  });

  it("reads cover/prune pairs", () => {
    expect(parseSettings("low/low, high/medium")).toEqual([
      { cover: "low", prune: "low" }, { cover: "high", prune: "medium" },
    ]);
  });

  it("refuses a setting it cannot read", () => {
    expect(() => parseSettings("high")).toThrow(/high/);
    expect(() => parseSettings("max/low")).toThrow(/max/);
    expect(() => parseSettings("")).toThrow();
  });
});

/** The published sweep's results stand in for the baseline mandates. */
const baseline = JSON.parse(readFileSync(root("docs/benchmark-results.json"), "utf8")) as BenchResult[];
const baselineMandate = (taskId: string): Mandate => baseline.find((r) => r.taskId === taskId)!.mandate!;

const toolNames = (params: Anthropic.MessageStreamParams): string[] =>
  (params.tools ?? []).flatMap((t) => ("name" in t && typeof t.name === "string" ? [t.name] : []));

/**
 * A model that re-proposes exactly the baseline mandate for whatever task it is
 * asked about -- or, when `widen` is set at the given effort, adds a grant.
 */
const fakeWriter = (opts: { widenAt?: string; sent?: Anthropic.MessageStreamParams[] } = {}): Anthropic => ({
  messages: {
    stream: (params: Anthropic.MessageStreamParams) => {
      opts.sent?.push(params);
      const first = params.messages[0]?.content;
      const prompt = typeof first === "string" ? first : JSON.stringify(first);
      const hit = baseline.find((r) => prompt.includes(r.mandate!.task.slice(0, 60)));
      const m = hit!.mandate!;
      const extra = params.output_config?.effort === opts.widenAt
        ? [{ action: "issue.comment", resources: [REPO], branches: null, paths: null, denyPaths: null, base: null, max: 1 }]
        : [];
      const input = toolNames(params).includes("propose_grants")
        ? {
          grants: [...m.grants.map((g) => ({
            action: g.action, resources: g.resources, branches: g.branches ?? null,
            paths: g.paths ?? null, denyPaths: g.denyPaths ?? null, base: g.base ?? null, max: g.max ?? null,
          })), ...extra],
          destinations: m.destinations.allow,
        }
        : { keep: [...m.grants.map((g) => g.action), ...extra.map((g) => g.action)] };
      return {
        finalMessage: async () => ({
          stop_reason: "tool_use", stop_details: null,
          usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          content: [{
            type: "tool_use", id: "tu", input, caller: { type: "direct" },
            name: toolNames(params).includes("propose_grants") ? "propose_grants" : "keep_grants",
          }],
        }),
      };
    },
  },
} as unknown as Anthropic);

const corpus = loadCorpus(CORPUS);
const depsFor = (over: Partial<WriterSweepDeps> = {}): WriterSweepDeps => ({
  anthropic: fakeWriter(), ceiling, authority: AUTHORITY,
  groundTruth: loadGroundTruth(CORPUS, corpus), baseline,
  settings: [{ cover: "high", prune: "high" }, { cover: "medium", prune: "medium" }],
  ...over,
});

describe("runWriterSweep", () => {
  it("writes every task once per setting, from the baseline's own task text", async () => {
    const sent: Anthropic.MessageStreamParams[] = [];
    const records = await runWriterSweep(corpus, depsFor({ anthropic: fakeWriter({ sent }) }));
    expect(records).toHaveLength(corpus.tasks.length * 2);
    const prompts = sent.map((p) => String(p.messages[0]?.content));
    for (const t of corpus.tasks) {
      expect(prompts.some((p) => p.includes(baselineMandate(t.id).task))).toBe(true);
    }
  });

  // The baseline was written with the issue number in its request, which the
  // cover prompt carries as its own line; without it the input differs and the
  // comparison measures that too.
  it("gives the writer the issue number the baseline was written with", async () => {
    const sent: Anthropic.MessageStreamParams[] = [];
    const task = corpus.tasks[0]!;
    await runWriterSweep({ ...corpus, tasks: [task] }, depsFor({
      anthropic: fakeWriter({ sent }), settings: [{ cover: "high", prune: "high" }],
    }));
    const issue = /#(\d+)/.exec(baselineMandate(task.id).task)?.[1];
    expect(issue).toBeDefined();
    expect(String(sent[0]?.messages[0]?.content)).toContain(`Issue: #${issue}`);
  });

  it("asks each call at the setting's effort", async () => {
    const sent: Anthropic.MessageStreamParams[] = [];
    await runWriterSweep({ ...corpus, tasks: corpus.tasks.slice(0, 1) }, depsFor({
      anthropic: fakeWriter({ sent }), settings: [{ cover: "high", prune: "low" }],
    }));
    expect(sent.map((p) => p.output_config?.effort)).toEqual(["high", "low"]);
  });

  // Write latency drifts with API load; a setting measured an hour after
  // another is partly measuring the hour. Each task starts at a different
  // setting, so no setting always runs first.
  it("rotates which setting runs first from task to task", async () => {
    const records = await runWriterSweep({ ...corpus, tasks: corpus.tasks.slice(0, 2) }, depsFor());
    expect(records.map((r) => `${r.taskId === corpus.tasks[0]!.id ? 0 : 1}:${r.setting.cover}`))
      .toEqual(["0:high", "0:medium", "1:medium", "1:high"]);
  });

  it("marks a mandate identical to the baseline, accepted, and scored", async () => {
    const records = await runWriterSweep({ ...corpus, tasks: corpus.tasks.slice(0, 1) }, depsFor());
    for (const r of records) {
      expect(r.identical).toBe(true);
      expect(r.differences).toEqual([]);
      expect(r.accepted).toBe(true);
      expect(r.cost).toBeGreaterThan(0);
      expect(r.score?.underGrants.length).toBe(1);
    }
  });

  it("reports the difference when a setting writes a wider mandate", async () => {
    const records = await runWriterSweep({ ...corpus, tasks: corpus.tasks.slice(0, 1) }, depsFor({
      anthropic: fakeWriter({ widenAt: "medium" }),
    }));
    const medium = records.find((r) => r.setting.cover === "medium")!;
    expect(medium.identical).toBe(false);
    expect(medium.differences).toContain("issue.comment: extra");
    expect(records.find((r) => r.setting.cover === "high")!.identical).toBe(true);
  });

  it("stops before a write that would exceed the budget", async () => {
    // $0.05 is reserved ahead of each write, on top of what has been spent;
    // the fake costs $0.012 a write, so a third would start at $0.024 + $0.05.
    const records = await runWriterSweep(corpus, depsFor({ budget: 0.07 }));
    expect(records).toHaveLength(2);
  });
});

describe("summarizeWriterSweep", () => {
  const rec = (cover: "high" | "medium", latencyMs: number, identical: boolean): WriterSweepRecord => ({
    taskId: `t${latencyMs}`, setting: { cover, prune: cover }, latencyMs,
    callLatencyMs: { cover: latencyMs - 1000, prune: 1000 }, cost: 0.02,
    accepted: true, identical, differences: identical ? [] : ["x: extra"], score: undefined,
  });

  it("reports per setting the median latency, identical mandates and cost", () => {
    const out = summarizeWriterSweep([
      rec("high", 12000, true), rec("high", 14000, true), rec("high", 13000, true),
      rec("medium", 8000, true), rec("medium", 9000, false), rec("medium", 7000, true),
    ]);
    expect(out).toMatch(/\| high\/high \| 13000 ms \| 12000 ms \| 1000 ms \| 3\/3 \| 3\/3 \| \$0\.0600 \|/);
    expect(out).toMatch(/\| medium\/medium \| 8000 ms \| 7000 ms \| 1000 ms \| 2\/3 \| 3\/3 \| \$0\.0600 \|/);
  });

  it("lists every difference, so a non-identical mandate can be judged", () => {
    expect(summarizeWriterSweep([rec("medium", 9000, false)])).toContain("t9000 (medium/medium): x: extra");
  });
});
