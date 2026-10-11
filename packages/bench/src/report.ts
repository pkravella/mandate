import { authorityCut, BASELINE_TOKEN } from "@mandate-dev/cli";
import type { Score } from "@mandate-dev/replay";
import type { Mandate } from "@mandate-dev/schema";
import { CATEGORIES, TARGET_COMPOSITION, type Category } from "./tasks.js";

/**
 * The v0.1 metrics report (Decisions D7, D8).
 *
 * This is the artifact the PRD's claims rest on, so what would make it
 * *misleading* matters more than what would make it incomplete. Three things
 * are therefore printed whether or not they flatter the result: the corpus's
 * size against D8's target, whether its tasks are synthetic, and the fact that
 * completion and under-grant can disagree.
 *
 * D4's instruction is binding here — "a single number would be marketing, not
 * measurement" — and it applies to more than the authority cut.
 */

/**
 * Which tools the proxy offered the agent (Task 6.1). `granted` is the
 * product: an ungranted tool is never offered, so it is never attempted and an
 * under-grant never becomes a denial. `all` offers every tool and refuses on
 * call, which is what makes denials, false pauses and widen requests
 * measurable. Enforcement is the same in both.
 */
export type ToolVisibility = "granted" | "all";

export interface BenchResult {
  readonly taskId: string;
  readonly category: Category;
  readonly visibility: ToolVisibility;
  readonly completed: boolean;
  /** What decided completion, so a disputed result can be rechecked. */
  readonly completionEvidence: string;
  /** Pauses that offered a reviewable widen request. */
  readonly widenRequests: number;
  /** Pauses the refusal list declined to offer one for. */
  readonly widenRefusals: number;
  /**
   * Denials in the mandated run for a call the ground truth also made.
   *
   * The PRD defines a false pause as a run "paused for an action a reviewer
   * judges in scope". A reviewer's judgement is not available to a harness, but
   * ground truth is a defensible stand-in: the unconstrained run needed that
   * call to finish the task, so a mandate refusing it paused something in
   * scope. It will track `score.underGrants` closely — one is observed at
   * runtime, the other predicted by replay — and a divergence between them is
   * itself worth looking at.
   */
  readonly falsePauses: number;
  /**
   * Denials the proxy actually issued during the run.
   *
   * Reported because `falsePauses` being 0 is not evidence a mandate was the
   * right size: the proxy filters `tools/list`, so an ungranted tool is never
   * offered and therefore never attempted. An under-grant then surfaces as a
   * silent workaround or a silent failure rather than as a pause, and a report
   * that printed only the pause count would read as a clean sweep.
   */
  readonly deniedCalls: number;
  /** Whether the agent opened a pull request, for tasks that asked for one. */
  readonly pullRequestOpened: boolean;
  /** The writer's proposal was refused by validate(), so nothing was minted. */
  readonly proposalRejected: boolean;
  readonly score: Score;
  readonly writeLatencyMs: number;
  /**
   * The validated mandate the run was enforced under; absent when validate()
   * refused the proposal and nothing was minted. Kept rather than a cut
   * computed at one baseline, so the report can compute the cut against any
   * baseline and a published figure can be recomputed from the sweep's output.
   */
  readonly mandate?: Mandate;
  readonly cost: number;
}

export interface CorpusMeta {
  readonly repo: string;
  readonly composition: Readonly<Record<Category, number>>;
  readonly shortfall: Readonly<Record<Category, number>>;
  readonly provenance: { readonly synthetic: number; readonly derived: number };
  readonly groundTruthFrom: string;
  /**
   * The PRD's baseline: how many repositories the agent's usual static token
   * reaches, and where that count came from. Omitted, the cut is reported
   * against one repository only, and the report says so.
   */
  readonly baselineRepositories?: { readonly count: number; readonly source: string };
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
};

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

const MODES: readonly ToolVisibility[] = ["granted", "all"];
const MODE_HEADING: Readonly<Record<ToolVisibility, string>> = {
  granted: "Tools filtered (the product: a tool no grant reaches is not offered)",
  all: "Every tool offered (measurement: an ungranted tool is offered, and refused on call)",
};
const MODE_SHORT: Readonly<Record<ToolVisibility, string>> = { granted: "filtered", all: "offered" };

const sum = (r: Readonly<Record<Category, number>>): number =>
  CATEGORIES.reduce((a, c) => a + r[c], 0);

export function renderReport(
  results: readonly BenchResult[], meta: CorpusMeta,
): string {
  const n = results.length;
  const have = sum(meta.composition);
  const target = sum(TARGET_COMPOSITION);
  const lines: string[] = [];
  const say = (s = ""): void => { lines.push(s); };
  // Each task's agent may run in several modes under one mandate. A figure
  // that is a property of the mandate -- its score, its authority -- is read
  // from one result per task, or a task that ran twice counts twice.
  const perTask = results.filter((r, i) => results.findIndex((x) => x.taskId === r.taskId) === i);
  // A rejected proposal minted nothing, so it has no authority to cut.
  const minted = perTask.flatMap((r) => (r.mandate === undefined ? [] : [r.mandate]));
  const modesRun = MODES.filter((m) => results.some((r) => r.visibility === m));
  const multi = modesRun.length > 1;

  say("# Mandate v0.1 benchmark report");
  say();

  // ---- what this report is, before any number ------------------------
  say("## What this measures, and what it does not");
  say();
  say(`**${have} of a target ${target} tasks.** Decision D8 fixes the corpus at `
    + `${target} tasks (${CATEGORIES.map((c) => `${TARGET_COMPOSITION[c]} ${c}`).join(", ")}). `
    + `This corpus is ${have}, leaving a shortfall of `
    + `${CATEGORIES.filter((c) => meta.shortfall[c] > 0)
      .map((c) => `${meta.shortfall[c]} ${c}`).join(", ") || "none"}. `
    + `Every figure below is over ${n} run${n === 1 ? "" : "s"} `
    + `(${perTask.length} task${perTask.length === 1 ? "" : "s"} × ${modesRun.length} `
    + `mode${modesRun.length === 1 ? "" : "s"}) and is not the `
    + `${target}-task result D8 asks for.`);
  say();

  if (meta.provenance.synthetic > 0) {
    say(`**${meta.provenance.synthetic} of the tasks are synthetic`
      + `${meta.provenance.derived > 0 ? ` and ${meta.provenance.derived} derived` : ""}.** `
      + `A synthetic bug is easier than one found in the wild, and each seeded suite `
      + `already contains a failing test, so the agent is told what is wrong rather than `
      + `having to find it. Completion rate here is therefore **optimistic**, and it does `
      + `not inherit the credibility of a corpus drawn from real repositories.`);
  } else {
    say(`**${meta.provenance.derived} derived tasks**, each carrying its source `
      + `repository, commit and license.`);
  }
  say();
  say(`Ground truth: ${meta.groundTruthFrom}, against \`${meta.repo}\`. Over- and `
    + `under-grant are scored by replaying those traces through the production `
    + `argument enforcer, so a score is the decision the proxy would have made.`);
  say();

  // ---- the headline table --------------------------------------------
  say("## Metrics");
  say();
  const wide = meta.baselineRepositories;
  const baselines = [1, ...(wide === undefined || wide.count <= 1 ? [] : [wide.count])];
  const repos = (r: number): string => `${r} repositor${r === 1 ? "y" : "ies"}`;
  say(`Baseline for the authority cut (D7): a token holding the permissions the GitHub `
    + `MCP server's default toolsets require `
    + `(${Object.entries(BASELINE_TOKEN).map(([k, v]) => `${k}: ${v}`).join(", ")}), `
    + `counted as reachable (operation × repository) pairs, and reported against two `
    + `repository counts. **One repository** is the conservative figure: it is reproducible `
    + `and credits Mandate with nothing for choosing the repository. `
    + (wide === undefined || wide.count <= 1
      ? `No repository count was given for the PRD's baseline, the agent's usual static `
        + `token, so only the one-repository figure is reported.`
      : `**${repos(wide.count)}** is the PRD's baseline, the agent's usual static token: `
        + `${wide.source}. Neither is the authority cut; each is labelled.`));
  say();
  const row = (name: string, value: string, targetText: string, met: boolean | undefined): void => {
    say(`| ${name} | ${value} | ${targetText} | ${met === undefined ? "—" : met ? "yes" : "**NO**"} |`);
  };

  if (n === 0) {
    say("| Metric | Result | v0.1 target | Met |");
    say("| --- | --- | --- | --- |");
    say("| (no tasks ran) | — | — | — |");
    say();
  }

  // One table per mode, each named: the plan's instruction that the report say
  // which mode produced which figure, and the denial figures mean different
  // things in each.
  for (const mode of modesRun) {
    const rs = results.filter((r) => r.visibility === mode);
    const k = rs.length;
    say(`### ${MODE_HEADING[mode]}`);
    say();
    say("| Metric | Result | v0.1 target | Met |");
    say("| --- | --- | --- | --- |");

    const completion = rs.filter((r) => r.completed).length / k;
    row("Task completion", pct(completion), "at least 90%", completion >= 0.9);

    // From the counts, not cutPercent: a whole percent reads 99.8% as 100%.
    const modeMinted = rs.flatMap((r) => (r.mandate === undefined ? [] : [r.mandate]));
    for (const b of baselines) {
      const cuts = modeMinted.map((m) => authorityCut(m, { repositories: b }));
      for (const layer of ["token", "proxy"] as const) {
        const c = median(cuts.map((x) => 1 - x[layer].reachable / x.baseline));
        row(`Authority cut, ${layer} layer, against ${repos(b)}`,
          cuts.length === 0 ? "—" : pct(c), "at least 80%",
          cuts.length === 0 ? undefined : c >= 0.8);
      }
    }

    // A run with no mandate -- refused by validate(), or the writer produced
    // none -- has no over-grant; counting it as 0% flatters the median.
    const scored = rs.filter((r) => r.mandate !== undefined);
    const over = median(scored.map((r) => r.score.overGrantRate));
    const unscored = k - scored.length;
    row("Over-grant",
      scored.length === 0 ? "—" : `${pct(over)}${unscored === 0 ? ""
        : ` (${unscored} run${unscored === 1 ? "" : "s"} without a mandate not counted)`}`,
      "under 10%", scored.length === 0 ? undefined : over < 0.1);

    const widen = mean(rs.map((r) => r.widenRequests));
    row("Widen requests", widen.toFixed(2), "under 0.3 per task", widen < 0.3);

    const falsePause = rs.filter((r) => r.falsePauses > 0).length / k;
    row("False pauses", pct(falsePause), "under 5%", falsePause < 0.05);

    const denied = rs.reduce((a, r) => a + r.deniedCalls, 0);
    const widenable = rs.reduce((a, r) => a + r.widenRequests, 0);
    row("Denials", `${denied} (${widenable} a widen could satisfy)`, "—", undefined);

    const latency = median(rs.map((r) => r.writeLatencyMs));
    row("Write latency", `${latency} ms`, "under 10 s", latency < 10_000);

    // Not a measurement. A grant outside the ceiling cannot reach the compiler,
    // because only validate() mints a ValidatedMandate and the brand's
    // constructor is private to it. Printing a measured 0 would claim a test
    // that was not run.
    const rejected = rs.filter((r) => r.proposalRejected).length;
    row("Ceiling breaches", "0 by construction", "0", undefined);
    row("Proposals rejected by validate()", String(rejected), "—", undefined);
    say();

    const predicted = rs.reduce((a, r) => a + r.score.underGrants.length, 0);
    if (mode === "granted" && denied === 0 && predicted > 0) {
      // The finding the first sweep produced, and the reason a 0 in the
      // false-pause row must not be read as a pass.
      say(`**The false-pause figure is 0 because nothing paused, not because the mandates `
        + `were the right size.** Across ${k} run${k === 1 ? "" : "s"} the proxy issued `
        + `**${denied} denials**, while replay predicts **${predicted} under-granted calls**. `
        + `The proxy filters \`tools/list\`, so a tool no grant reaches is never offered and `
        + `therefore never attempted: the agent works around it or quietly fails. R10's promise `
        + `that every pause names the clause it hit holds, and is vacuous where there is no `
        + `pause. Under-grant, not false pauses, is the metric that sees this.`);
      say();
    }
    if (mode === "all") {
      const needNew = rs.reduce((a, r) => a + r.widenRefusals, 0);
      const paused = rs.filter((r) => r.falsePauses > 0);
      const stillDone = paused.filter((r) => r.completed).length;
      say(`With every tool offered, the proxy issued **${denied} denials** across ${k} `
        + `run${k === 1 ? "" : "s"}, against **${predicted}** under-granted calls replay predicts. `
        + `${widenable} a widen could satisfy; ${needNew} need a new mandate, because a widen `
        + `may not add an operation, nor touch a deny path, an expiry or a destination. `
        + (paused.length === 0
          ? "No run had a false pause."
          : `${paused.length} run${paused.length === 1 ? "" : "s"} had a false pause, and `
            + `${stillDone} of them still completed: a refused call the ground truth made is `
            + `not always one the task needed, since both passes are given the issue text.`));
      say();
    }
  }

  say("Over-grant counts granted operations; the authority cut counts (operation × repository) "
    + "pairs. Each is right for its own definition, and the two do not compare.");
  say();

  say("Ceiling breaches are 0 **by construction**, not by measurement: nothing but "
    + "`validate()` can produce a `ValidatedMandate`, and nothing downstream accepts "
    + "anything else. The adversarial suite is what tests that claim under attack; this "
    + "report does not.");
  say();
  say("The authority cut is two numbers because a GitHub App token cannot express branch "
    + "or path scope. The token-layer figure is what holds if the agent escapes the proxy; "
    + "the proxy-layer figure is what holds while it does not. See "
    + "`docs/enforced-where.md`.");
  say();

  if (minted.length > 0) {
    const b = baselines.at(-1) ?? 1;
    const cuts = minted.map((m) => authorityCut(m, { repositories: b }));
    const base = cuts[0]?.baselineOperations ?? 0;
    const mRepos = median(cuts.map((c) => c.mandateRepositories));
    const tokenOps = median(cuts.map((c) => c.token.operations));
    const proxyOps = median(cuts.map((c) => c.proxy.operations));
    say("## Where the authority cut comes from");
    say();
    say(`The baseline reaches ${base} operations × ${repos(b)} = ${base * b} pairs. `
      + `Medians across the ${minted.length} minted mandate${minted.length === 1 ? "" : "s"}, `
      + `three things narrow it:`);
    say();
    if (b > 1) {
      say(`1. **Repository scoping**, ${repos(b)} to ${mRepos}. Any installation token `
        + `limited to the task's repository gets this without Mandate; what Mandate adds is `
        + `choosing that repository per task. It is most of the cut against ${repos(b)}.`);
    } else {
      say(`1. **Repository scoping** is not measured against a one-repository baseline.`);
    }
    say(`2. **Permission narrowing**, the token layer: ${base} to ${tokenOps} operations per `
      + `repository, from the permissions the mandate's grants need.`);
    say(`3. **Operation narrowing**, the proxy layer: ${tokenOps} to ${proxyOps} operations per `
      + `repository, the ones the mandate actually granted.`);
    say();
    say("The gap between the layers is not all of what GitHub cannot enforce: it counts "
      + "operations, and branch and path limits, which a token cannot express either, are "
      + "invisible to an (operation × repository) count. It understates what only the proxy "
      + "holds.");
    say();
    say("The baseline's permission set understates a personal access token's. A classic token "
      + "with `repo` scope also carries `administration` on every repository its owner "
      + "administers, which this baseline leaves out, so against such a token both layers' "
      + "cuts are larger than reported here.");
    say();
  }

  if (multi) {
    say("## What filtering hides");
    say();
    say("Each task ran under one mandate in each mode, so a difference between the columns is "
      + "the mode, not the mandate. It is one run per mode per task, and an agent does not do "
      + "the same thing twice, so a difference of one task is noise until it repeats.");
    say();
    say("| Task | Completed, filtered | Completed, offered | Denials, filtered | Denials, offered "
      + "| False pauses, offered |");
    say("| --- | --- | --- | --- | --- | --- |");
    for (const t of perTask) {
      const g = results.find((r) => r.taskId === t.taskId && r.visibility === "granted");
      const o = results.find((r) => r.taskId === t.taskId && r.visibility === "all");
      if (g === undefined || o === undefined) continue;
      const yes = (r: BenchResult): string => (r.completed ? "yes" : "**no**");
      say(`| ${t.taskId} | ${yes(g)} | ${yes(o)} | ${g.deniedCalls} | ${o.deniedCalls} `
        + `| ${o.falsePauses} |`);
    }
    say();
  }

  // ---- the disagreement that a single headline would hide -------------
  const completedWithUnderGrant = results.filter(
    (r) => r.completed && r.score.underGrants.length > 0,
  );
  if (completedWithUnderGrant.length > 0) {
    say("## Completion and under-grant disagree");
    say();
    const unit = multi ? "run" : "task";
    say(`${completedWithUnderGrant.length} ${unit}${completedWithUnderGrant.length === 1 ? "" : "s"} `
      + `completed while the replay scored an under-grant. That is not a contradiction: a `
      + `blocked call can be one the task could finish without — the agent worked around it, `
      + `or the task text already carried what the call would have fetched. It does mean a `
      + `completion rate alone would hide a mandate that is too narrow, so both are reported `
      + `and neither is the headline.`);
    say();
    for (const r of completedWithUnderGrant) {
      const missing = r.score.missingActions.join(", ");
      say(`- \`${r.taskId}\` completed${multi ? ` with ${MODE_SHORT[r.visibility]} tools` : ""}, blocked on `
        + `${r.score.underGrants.length} call(s)`
        + `${missing.length > 0 ? `; needed ${missing}` : ""}`);
    }
    say();
  }

  // ---- detail ---------------------------------------------------------
  if (n > 0) {
    say("## Per task");
    say();
    say("| Task | Tools | Category | Completed | PR | Denials | Under-grants | Over-grant | Latency | Cost |");
    say("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of results) {
      say(`| ${r.taskId} | ${MODE_SHORT[r.visibility]} | ${r.category} | ${r.completed ? "yes" : "**no**"} `
        + `| ${r.category === "triage" ? "n/a" : r.pullRequestOpened ? "yes" : "**no**"} `
        + `| ${r.deniedCalls} | ${r.score.underGrants.length} | ${pct(r.score.overGrantRate)} `
        + `| ${r.writeLatencyMs} ms | $${r.cost.toFixed(4)} |`);
    }
    say();

    say("## By category");
    say();
    say("| Category | Tools | Tasks | Completed | In D8's target |");
    say("| --- | --- | --- | --- | --- |");
    for (const c of CATEGORIES) {
      for (const mode of modesRun) {
        const mine = results.filter((r) => r.category === c && r.visibility === mode);
        if (mine.length === 0) continue;
        say(`| ${c} | ${MODE_SHORT[mode]} | ${mine.length} | ${mine.filter((r) => r.completed).length} `
          + `| ${TARGET_COMPOSITION[c]} |`);
      }
    }
    say();
  }

  say("## Under-grants by clause");
  say();
  const byClause = new Map<string, number>();
  for (const r of perTask) {
    for (const u of r.score.underGrants) {
      byClause.set(u.clause, (byClause.get(u.clause) ?? 0) + 1);
    }
  }
  if (byClause.size === 0) {
    say("None.");
  } else {
    for (const [clause, count] of [...byClause].sort((a, b) => b[1] - a[1])) {
      say(`- \`${clause}\`: ${count}`);
    }
  }
  say();

  const missing = [...new Set(perTask.flatMap((r) => r.score.missingActions))].sort();
  say("## Operations the corpus needed and mandates lacked");
  say();
  say(missing.length === 0 ? "None." : missing.map((a) => `- \`${a}\``).join("\n"));
  say();

  const unused = [...new Set(perTask.flatMap((r) => r.score.unusedActions))].sort();
  say("## Granted operations no task exercised");
  say();
  say(unused.length === 0 ? "None." : unused.map((a) => `- \`${a}\``).join("\n"));
  say();

  say("## Cost");
  say();
  say(`$${results.reduce((a, r) => a + r.cost, 0).toFixed(4)} across ${n} `
    + `mandated run${n === 1 ? "" : "s"}, excluding the one-time ground-truth pass.`
    + (multi ? " The writer ran once per task; its cost is in the first mode's run." : ""));
  say();

  return lines.join("\n");
}
