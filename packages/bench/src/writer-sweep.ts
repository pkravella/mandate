import type Anthropic from "@anthropic-ai/sdk";
import type { Mandate } from "@leastpilot/schema";
import type { ActionGraph } from "@leastpilot/proxy";
import { scoreMandate, type Score } from "@leastpilot/replay";
import { validate, type Ceiling, type UserAuthority } from "@leastpilot/validator";
import { WriterError, writeMandate, type WriterEffort } from "@leastpilot/writer";
import { costOf, recordingUsage } from "./harness.js";
import type { BenchResult } from "./report.js";
import type { Corpus } from "./tasks.js";

/**
 * Task 6.2: what lowering the writer's effort costs in quality and buys in
 * latency.
 *
 * The plan's quality gate -- 21/21 over-grants rejected, zero adversarial
 * breaches -- cannot see the writer: those suites feed fixed mandates to the
 * validator, or a stub standing in for a compromised model. So each task's
 * mandate is written again at each setting and compared with the one the
 * published sweep wrote at `high`, from that mandate's own task text: same
 * input, different effort. Identical, or the difference is printed.
 */

export interface WriterSetting { readonly cover: WriterEffort; readonly prune: WriterEffort }

export interface WriterSweepDeps {
  readonly anthropic: Anthropic;
  readonly ceiling: Ceiling;
  readonly authority: UserAuthority;
  readonly groundTruth: Readonly<Record<string, ActionGraph>>;
  /** The published sweep's results; each task's mandate there is the baseline. */
  readonly baseline: readonly BenchResult[];
  readonly settings: readonly WriterSetting[];
  readonly budget?: number;
  readonly log?: (s: string) => void;
}

export interface WriterSweepRecord {
  readonly taskId: string;
  readonly setting: WriterSetting;
  readonly latencyMs: number;
  readonly callLatencyMs: { readonly cover: number; readonly prune: number };
  readonly cost: number;
  /** validate() accepted it. */
  readonly accepted: boolean;
  readonly identical: boolean;
  /** How it differs from the baseline, or why nothing was written. */
  readonly differences: readonly string[];
  /** Against the ground truth, when it was accepted. */
  readonly score: Score | undefined;
}

/** Reserved ahead of each write; a write at `high` measured ~$0.03. */
const ESTIMATED_COST_PER_WRITE = 0.05;

const EFFORTS: readonly string[] = ["low", "medium", "high"];

/** `LEASTPILOT_WRITER_SETTINGS`, as `cover/prune` pairs. */
export function parseSettings(raw: string | undefined): readonly WriterSetting[] {
  if (raw === undefined) {
    return [
      { cover: "high", prune: "high" }, { cover: "high", prune: "low" },
      { cover: "medium", prune: "medium" },
    ];
  }
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error("LEASTPILOT_WRITER_SETTINGS names no setting");
  return parts.map((p) => {
    const [cover, prune, rest] = p.split("/");
    if (rest !== undefined || cover === undefined || prune === undefined
      || !EFFORTS.includes(cover) || !EFFORTS.includes(prune)) {
      throw new Error(`cannot read writer setting ${JSON.stringify(p)}; use cover/prune, e.g. high/low`);
    }
    return { cover: cover as WriterEffort, prune: prune as WriterEffort };
  });
}

const sorted = (xs: readonly string[] | undefined): string | undefined =>
  xs === undefined ? undefined : JSON.stringify([...xs].sort());

/**
 * How `candidate` differs from `baseline`, grant by grant. Pattern order means
 * nothing and is ignored; everything a grant decides is compared.
 */
export function compareMandates(baseline: Mandate, candidate: Mandate): readonly string[] {
  const out: string[] = [];
  const byAction = (m: Mandate) => new Map(m.grants.map((g) => [g.action, g]));
  const a = byAction(baseline);
  const b = byAction(candidate);
  for (const [action, g] of a) {
    const h = b.get(action);
    if (h === undefined) { out.push(`${action}: missing`); continue; }
    const facets: [string, string | undefined, string | undefined][] = [
      ["resources", sorted(g.resources), sorted(h.resources)],
      ["branches", sorted(g.branches), sorted(h.branches)],
      ["paths", sorted(g.paths), sorted(h.paths)],
      ["denyPaths", sorted(g.denyPaths), sorted(h.denyPaths)],
      ["base", g.base === undefined ? undefined : JSON.stringify(g.base), h.base === undefined ? undefined : JSON.stringify(h.base)],
      ["max", g.max?.toString(), h.max?.toString()],
      ["enforcedBy", g.enforcedBy, h.enforcedBy],
    ];
    for (const [facet, x, y] of facets) {
      if (x !== y) out.push(`${action}.${facet}: ${x ?? "none"} -> ${y ?? "none"}`);
    }
  }
  for (const action of b.keys()) if (!a.has(action)) out.push(`${action}: extra`);
  const da = sorted(baseline.destinations.allow);
  const db = sorted(candidate.destinations.allow);
  if (da !== db) out.push(`destinations: ${da} -> ${db}`);
  return out;
}

const key = (s: WriterSetting): string => `${s.cover}/${s.prune}`;

export async function runWriterSweep(
  corpus: Corpus, deps: WriterSweepDeps,
): Promise<readonly WriterSweepRecord[]> {
  const log = deps.log ?? ((): void => undefined);
  const budget = deps.budget ?? Number.POSITIVE_INFINITY;
  const records: WriterSweepRecord[] = [];
  let spent = 0;

  for (const [i, task] of corpus.tasks.entries()) {
    const base = deps.baseline.find((r) => r.taskId === task.id && r.mandate !== undefined)?.mandate;
    if (base === undefined) { log(`skip ${task.id}: no baseline mandate`); continue; }
    // The issue number the baseline was written with is in its task text.
    const issue = /#(\d+)/.exec(base.task)?.[1];
    // Rotated, so no setting always runs first and API drift through the
    // session does not fall on one setting.
    const order = deps.settings.map((_, j) => deps.settings[(i + j) % deps.settings.length]!);

    for (const setting of order) {
      if (spent + ESTIMATED_COST_PER_WRITE > budget) {
        log(`stop: the next write would exceed the $${budget.toFixed(2)} budget`);
        return records;
      }
      const usage: Anthropic.Usage[] = [];
      const started = Date.now();
      try {
        const written = await writeMandate(recordingUsage(deps.anthropic, usage), {
          task: base.task, repo: corpus.repo, requestedBy: base.requestedBy,
          ceiling: deps.ceiling, issueNumber: issue === undefined ? undefined : Number(issue),
          effort: setting,
        });
        const cost = usage.reduce((a, u) => a + costOf(u), 0);
        spent += cost;
        const decision = validate(written.proposed, { ceiling: deps.ceiling, authority: deps.authority });
        const differences = compareMandates(base, written.proposed);
        const truth = deps.groundTruth[task.id];
        records.push({
          taskId: task.id, setting, latencyMs: written.latencyMs,
          callLatencyMs: written.callLatencyMs, cost,
          accepted: decision.ok, identical: differences.length === 0, differences,
          score: decision.ok && truth !== undefined ? scoreMandate(decision.mandate, truth) : undefined,
        });
        log(`${task.id} [${key(setting)}]: ${written.latencyMs} ms `
          + `(cover ${written.callLatencyMs.cover}, prune ${written.callLatencyMs.prune}), `
          + `${differences.length === 0 ? "identical" : `${differences.length} difference(s)`}, `
          + `$${cost.toFixed(4)}`);
      } catch (e) {
        if (!(e instanceof WriterError)) throw e;
        const cost = usage.reduce((a, u) => a + costOf(u), 0);
        spent += cost;
        records.push({
          taskId: task.id, setting, latencyMs: Date.now() - started,
          callLatencyMs: { cover: 0, prune: 0 }, cost,
          accepted: false, identical: false, differences: [`no mandate: ${e.message}`], score: undefined,
        });
      }
    }
  }
  return records;
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
};

/** The table and the differences, per setting in the order first run. */
export function summarizeWriterSweep(records: readonly WriterSweepRecord[]): string {
  const keys = [...new Set(records.map((r) => key(r.setting)))];
  const lines = [
    "| Setting (cover/prune) | Median latency | Median cover | Median prune | Identical | Accepted | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const k of keys) {
    const rs = records.filter((r) => key(r.setting) === k);
    lines.push(`| ${k} | ${median(rs.map((r) => r.latencyMs))} ms `
      + `| ${median(rs.map((r) => r.callLatencyMs.cover))} ms `
      + `| ${median(rs.map((r) => r.callLatencyMs.prune))} ms `
      + `| ${rs.filter((r) => r.identical).length}/${rs.length} `
      + `| ${rs.filter((r) => r.accepted).length}/${rs.length} `
      + `| $${rs.reduce((a, r) => a + r.cost, 0).toFixed(4)} |`);
  }
  const diffs = records.flatMap((r) => r.differences.map((d) => `- ${r.taskId} (${key(r.setting)}): ${d}`));
  lines.push("", diffs.length === 0 ? "Every mandate matched its baseline." : diffs.join("\n"));
  return lines.join("\n");
}

/**
 * The figures a setting comparison rests on, paired by task: a candidate
 * against the control on the tasks both ran, so a missing write at one setting
 * cannot make the other look faster or slower.
 */
export function effortFindings(
  records: readonly WriterSweepRecord[], control: WriterSetting, candidate: WriterSetting,
): {
  readonly paired: number;
  readonly candidateFasterOnAll: boolean;
  readonly candidatePairedMedianMs: number;
  readonly controlPairedMedianMs: number;
  readonly candidateAllMedianMs: number;
  readonly fastestGainMs: number;
  readonly largestGainMs: number;
  readonly candidateIdentical: readonly [number, number];
  readonly controlIdentical: readonly [number, number];
} {
  const of = (s: WriterSetting) => records.filter((r) => key(r.setting) === key(s));
  const c = of(candidate);
  const k = of(control);
  const pairs = c.flatMap((r) => {
    const m = k.find((x) => x.taskId === r.taskId);
    return m === undefined ? [] : [{ cand: r.latencyMs, ctrl: m.latencyMs }];
  });
  const gains = pairs.map((p) => p.ctrl - p.cand);
  const identical = (rs: readonly WriterSweepRecord[]): readonly [number, number] =>
    [rs.filter((r) => r.identical).length, rs.length];
  return {
    paired: pairs.length,
    candidateFasterOnAll: pairs.length > 0 && gains.every((g) => g > 0),
    candidatePairedMedianMs: median(pairs.map((p) => p.cand)),
    controlPairedMedianMs: median(pairs.map((p) => p.ctrl)),
    candidateAllMedianMs: median(c.map((r) => r.latencyMs)),
    fastestGainMs: gains.length === 0 ? 0 : Math.min(...gains),
    largestGainMs: gains.length === 0 ? 0 : Math.max(...gains),
    candidateIdentical: identical(c),
    controlIdentical: identical(k),
  };
}
