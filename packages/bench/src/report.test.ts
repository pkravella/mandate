import { describe, expect, it } from "vitest";
import { MandateSchema, type Mandate } from "@mandate-dev/schema";
import { TARGET_COMPOSITION } from "./tasks.js";
import { renderReport, type BenchResult, type CorpusMeta } from "./report.js";

const REPO = "pkravella/mandate-sandbox";

/**
 * The token reaches 21 of the baseline's 31 operations (contents: write,
 * pull_requests: write, metadata: read), the proxy `ops` of them, in one
 * repository.
 */
const mandateWith = (ops = 3): Mandate => MandateSchema.parse({
  mandate: "fix-issue-12", task: "Fix issue #12 and open a PR",
  requestedBy: "user:pkravella", expiresInMinutes: 30, ceiling: "org-policy@v12",
  grants: [
    { action: "repo.read", enforcedBy: "token", resources: [REPO] },
    {
      action: "contents.write", enforcedBy: "proxy", resources: [REPO],
      branches: ["agent/12-*"], paths: ["**"], denyPaths: [".github/workflows/**"],
    },
    {
      action: "pull_request.create", enforcedBy: "proxy", resources: [REPO],
      branches: ["agent/12-*"], base: "main", max: 1,
    },
    { action: "pull_request.read", enforcedBy: "token", resources: [REPO] },
  ].slice(0, ops),
  destinations: { allow: [`github.com/${REPO}`] },
});

const result = (over: Partial<BenchResult> = {}): BenchResult => ({
  taskId: "t1",
  category: "single-file-fix",
  visibility: "granted",
  completed: true,
  completionEvidence: "node --test test/t1.test.js passed on agent/t1",
  widenRequests: 0,
  widenRefusals: 0,
  falsePauses: 0,
  deniedCalls: 0,
  pullRequestOpened: true,
  proposalRejected: false,
  score: {
    granted: 4, exercised: 4, overGrantRate: 0, unusedActions: [],
    underGrants: [], underGrantRate: 0, consideredCalls: 6, missingActions: [],
  },
  writeLatencyMs: 4200,
  mandate: mandateWith(),
  cost: 0.27,
  ...over,
});

const meta = (over: Partial<CorpusMeta> = {}): CorpusMeta => ({
  repo: "pkravella/mandate-sandbox",
  composition: { "single-file-fix": 3, "multi-file-fix": 1, "dependency-bump": 1, triage: 1 },
  shortfall: { "single-file-fix": 27, "multi-file-fix": 9, "dependency-bump": 4, triage: 4 },
  provenance: { synthetic: 6, derived: 0 },
  groundTruthFrom: "unconstrained runs recorded 2026-10-06",
  baselineRepositories: { count: 63, source: "what the developer's own token reaches" },
  ...over,
});

describe("renderReport metrics", () => {
  const out = renderReport([result(), result({ taskId: "t2" })], meta());

  it("reports every PRD success metric by name", () => {
    for (const m of ["Task completion", "Authority cut", "Over-grant",
      "Widen requests", "False pauses", "Write latency", "Ceiling breaches"]) {
      expect(out, m).toContain(m);
    }
  });

  it("reports authority cut at both layers (D4)", () => {
    expect(out).toContain("token layer");
    expect(out).toContain("proxy layer");
  });

  it("prints the baseline denominator so the figure is reproducible (D7)", () => {
    expect(out).toMatch(/baseline/i);
    expect(out).toContain("contents");
  });

  it("marks each metric met or not, not just the target column", () => {
    const fail = renderReport([result(), result({ taskId: "t2", completed: false })], meta());
    // 50% completion against a 90% target has to read as a failure.
    expect(fail).toMatch(/\| Task completion \| 50\.0% \| at least 90% \| \*\*NO\*\* \|/);
    const pass = renderReport([result()], meta());
    expect(pass).toMatch(/\| Task completion \| 100\.0% \| at least 90% \| yes \|/);
  });

  it("uses the median for latency, not the mean", () => {
    const out3 = renderReport([
      result({ writeLatencyMs: 1000 }),
      result({ taskId: "t2", writeLatencyMs: 2000 }),
      result({ taskId: "t3", writeLatencyMs: 90000 }),
    ], meta());
    expect(out3).toContain("2000 ms");
    expect(out3).not.toContain("31000");
  });
});

// The report is the artifact the PRD's claims rest on, so the things that
// would make it misleading matter more than the things that would make it
// incomplete.
describe("renderReport refuses to overstate", () => {
  it("states the corpus size and its shortfall against D8's target", () => {
    const out = renderReport([result()], meta());
    expect(out).toContain("6 of");
    expect(out).toMatch(/shortfall|44 short|incomplete/i);
    const target = Object.values(TARGET_COMPOSITION).reduce((a, b) => a + b, 0);
    expect(out).toContain(String(target));
  });

  // Asserted positively rather than by forbidding a phrase: a
  // forbidden-substring test flags the report's own legitimate mention of the
  // target and still would not prove the disclaimer is present.
  it("says in words that its figures are not D8's 50-task result", () => {
    const out = renderReport([result()], meta());
    expect(out).toMatch(/is not the 50-task result/i);
  });

  it("states the shortfall per category, not just a total", () => {
    const out = renderReport([result()], meta());
    expect(out).toMatch(/27 single-file-fix/);
    expect(out).toMatch(/shortfall of/);
  });

  it("puts the corpus size before any metric", () => {
    const out = renderReport([result()], meta());
    expect(out.indexOf("6 of")).toBeLessThan(out.indexOf("Task completion"));
  });

  it("says the corpus is synthetic when it is", () => {
    const out = renderReport([result()], meta());
    expect(out).toMatch(/synthetic/i);
    expect(out).toMatch(/optimistic/i);
  });

  it("says so when the corpus is not synthetic", () => {
    const out = renderReport([result()], meta({ provenance: { synthetic: 0, derived: 6 } }));
    expect(out).toContain("6 derived");
  });

  // Hardcoding "0 / met" is a claim the harness did not measure. A breach is
  // prevented by construction, and the report has to say which it is.
  it("attributes zero ceiling breaches to the validator in the table row itself", () => {
    const out = renderReport([result()], meta());
    // Asserted on the row, not on the prose: the paragraph below the table also
    // says "by construction", so matching the whole document proves nothing
    // about what the table claims.
    expect(out).toMatch(/\| Ceiling breaches \| 0 by construction \|/);
    // And it must not be marked "met", because nothing measured it.
    expect(out).not.toMatch(/\| Ceiling breaches \|[^\n]*\| yes \|/);
    expect(out).toMatch(/by construction[^\n]*not by measurement|validate\(\)/);
  });

  it("counts proposals the validator rejected, in its own row", () => {
    const out = renderReport([
      result(), result({ taskId: "t2", proposalRejected: true, completed: false }),
    ], meta());
    // The row, not a bare "1" — digits appear throughout the report, so
    // toContain("1") would pass whatever this counted.
    expect(out).toMatch(/\| Proposals rejected by validate\(\) \| 1 \|/);
    const none = renderReport([result()], meta());
    expect(none).toMatch(/\| Proposals rejected by validate\(\) \| 0 \|/);
  });

  // The issue.read case: a task can complete while the replay scores an
  // under-grant, because the task text happened to carry what the blocked call
  // would have fetched. Collapsing them into one headline hides it.
  it("shows completion and under-grant separately, and flags a disagreement", () => {
    const out = renderReport([result({
      completed: true,
      score: {
        granted: 4, exercised: 4, overGrantRate: 0, unusedActions: [],
        underGrants: [{ seq: 1, tool: "issue_read", clause: "mandate.grants", reason: "no" }],
        underGrantRate: 0.16, consideredCalls: 6, missingActions: ["issue.read"],
      },
    })], meta());
    expect(out).toContain("## Completion and under-grant disagree");
    expect(out).toMatch(/1 task completed while the replay scored an under-grant/);
    expect(out).toMatch(/- `t1` completed, blocked on 1 call\(s\); needed issue\.read/);
  });
});

// Task 6.4. The cut against one repository was published under a sentence
// describing an org-wide baseline. The PRD's baseline is the agent's usual
// static token, which reaches every repository its developer can see; one
// repository is the conservative, reproducible figure. Both are printed, each
// labelled, and neither is the figure.
describe("renderReport authority cut", () => {
  const out = renderReport([result()], meta());

  it("prints a row per layer for each baseline, labelled by its repository count", () => {
    // token 21 of 31; proxy 3 of 31; at 63 repositories 21 and 3 of 1953.
    expect(out).toMatch(/\| Authority cut, token layer, against 1 repository \| 32\.3% \|/);
    expect(out).toMatch(/\| Authority cut, proxy layer, against 1 repository \| 90\.3% \|/);
    expect(out).toMatch(/\| Authority cut, token layer, against 63 repositories \| 98\.9% \|/);
    expect(out).toMatch(/\| Authority cut, proxy layer, against 63 repositories \| 99\.8% \|/);
  });

  // cutPercent is rounded to a whole percent, which reads 99.8% as 100.0%.
  it("computes from the counts, not from a rounded percentage", () => {
    expect(out).not.toMatch(/\| Authority cut[^|]*\| 100\.0% \|/);
  });

  it("says where the larger repository count came from", () => {
    expect(out).toContain("what the developer's own token reaches");
  });

  it("does not describe the one-repository figure as an org-wide baseline", () => {
    expect(out).not.toMatch(/installed org-wide/);
  });

  it("says only one baseline was measured when no repository count was given", () => {
    const { baselineRepositories: _wide, ...narrow } = meta();
    const one = renderReport([result()], narrow);
    expect(one).toMatch(/against 1 repository/);
    expect(one).not.toMatch(/against 63 repositories/);
    expect(one).toMatch(/no repository count was given/i);
  });

  // Most of the cut against 63 repositories is repository scoping, which any
  // installation token limited to one repository gets without Mandate.
  it("breaks the larger cut into repository scoping, permission and operation narrowing", () => {
    expect(out).toContain("## Where the authority cut comes from");
    expect(out).toMatch(/31 operations × 63 repositories = 1953/);
    expect(out).toMatch(/63 repositories to 1/);
    expect(out).toMatch(/31 to 21 operations/);
    expect(out).toMatch(/21 to 3 operations/);
    expect(out).toMatch(/without Mandate/);
  });

  it("says the gap between layers cannot see branch and path limits", () => {
    expect(out).toMatch(/counts operations[^\n]*branch and path/);
  });

  it("says the baseline omits the administration a personal access token carries", () => {
    expect(out).toMatch(/administration/);
  });

  // A rejected proposal minted nothing, so there is no authority to cut. It
  // used to enter the median as a 0% cut.
  it("leaves rejected proposals out of the cut", () => {
    const { mandate: _none, ...rejected } =
      result({ taskId: "t2", proposalRejected: true, completed: false });
    const mixed = renderReport([
      result(),
      rejected,
    ], meta());
    expect(mixed).toMatch(/\| Authority cut, proxy layer, against 1 repository \| 90\.3% \|/);
  });

  it("takes the median across tasks", () => {
    const three = renderReport([
      result({ mandate: mandateWith(2) }),
      result({ taskId: "t2", mandate: mandateWith(3) }),
      result({ taskId: "t3", mandate: mandateWith(4) }),
    ], meta());
    expect(three).toMatch(/\| Authority cut, proxy layer, against 1 repository \| 90\.3% \|/);
  });
});

describe("renderReport detail sections", () => {
  it("groups under-grants by clause", () => {
    const out = renderReport([result({
      score: {
        granted: 4, exercised: 3, overGrantRate: 0.25, unusedActions: ["issue.comment"],
        underGrants: [
          { seq: 1, tool: "a", clause: "contents.write.branches", reason: "r" },
          { seq: 2, tool: "b", clause: "contents.write.branches", reason: "r" },
          { seq: 3, tool: "c", clause: "mandate.grants", reason: "r" },
        ],
        underGrantRate: 0.5, consideredCalls: 6, missingActions: ["issue.read"],
      },
    })], meta());
    expect(out).toContain("contents.write.branches");
    expect(out).toMatch(/contents\.write\.branches[^\n]*2/);
  });

  it("names the operations the corpus needed that mandates lacked", () => {
    const out = renderReport([result({
      score: { ...result().score, missingActions: ["issue.read", "issue.comment"] },
    })], meta());
    expect(out).toContain("issue.read");
    expect(out).toContain("issue.comment");
  });

  it("names the granted operations no task exercised", () => {
    const out = renderReport([result({
      score: { ...result().score, unusedActions: ["actions.write"] },
    })], meta());
    expect(out).toContain("actions.write");
  });

  it("breaks results down per task, so a single figure can be checked", () => {
    const out = renderReport([result(), result({ taskId: "second" })], meta());
    expect(out).toContain("## Per task");
    // The row, so dropping the table is caught rather than just its heading.
    expect(out).toMatch(/\| t1 \| filtered \| single-file-fix \| yes \|/);
    expect(out).toMatch(/\| second \| filtered \| single-file-fix \| yes \|/);
  });

  it("reports what the sweep cost", () => {
    expect(renderReport([result({ cost: 0.3 }), result({ taskId: "t2", cost: 0.2 })], meta()))
      .toContain("0.50");
  });

  it("reports per category, because D8's mix is the point", () => {
    const out = renderReport([
      result({ category: "triage", completed: false }),
      result({ taskId: "t2", category: "single-file-fix" }),
    ], meta());
    expect(out).toContain("triage");
    expect(out).toContain("single-file-fix");
  });

  it("renders with no results rather than dividing by zero", () => {
    const out = renderReport([], meta({ composition: { "single-file-fix": 0, "multi-file-fix": 0, "dependency-bump": 0, triage: 0 } }));
    expect(out).not.toContain("NaN");
    expect(out).toMatch(/no tasks|0 of/i);
  });
});

const underGranted = {
  granted: 4, exercised: 4, overGrantRate: 0, unusedActions: [],
  underGrants: [{ seq: 1, tool: "issue_read", clause: "mandate.grants", reason: "no" }],
  underGrantRate: 0.16, consideredCalls: 6, missingActions: ["issue.read"],
};

// Task 6.1. Each task ran under one mandate in two modes; the report has to
// say which mode produced which figure, and must not count a task's mandate
// twice because it ran twice.
describe("renderReport across tool-visibility modes", () => {
  const filtered = result({ score: underGranted });
  const offered = result({
    visibility: "all", completed: false, score: underGranted,
    deniedCalls: 3, falsePauses: 1, widenRequests: 1, widenRefusals: 2,
  });
  const both = renderReport([filtered, offered], meta());

  it("renders one metrics table per mode, each named", () => {
    expect(both).toContain("### Tools filtered");
    expect(both).toContain("### Every tool offered");
    const [, afterFiltered = ""] = both.split("### Tools filtered");
    const [filteredTable = "", afterOffered = ""] = afterFiltered.split("### Every tool offered");
    expect(filteredTable).toMatch(/\| Task completion \| 100\.0% \|/);
    expect(afterOffered).toMatch(/\| Task completion \| 0\.0% \|/);
  });

  it("names the mode even when only one ran", () => {
    expect(renderReport([filtered], meta())).toContain("### Tools filtered");
  });

  it("counts denials, and how many of them a widen could satisfy", () => {
    expect(both).toMatch(/\| Denials \| 3 \(1 a widen could satisfy\) \|/);
  });

  it("says only of the filtered mode that its zero false pauses are vacuous", () => {
    const filteredOnly = renderReport([filtered], meta());
    expect(filteredOnly).toMatch(/0 because nothing paused/);
    expect(renderReport([offered], meta())).not.toMatch(/0 because nothing paused/);
  });

  it("says, with every tool offered, how many denials needed a new mandate rather than a widen", () => {
    expect(both).toMatch(/With every tool offered[^\n]*3 denials/);
    expect(both).toMatch(/2 need a new mandate/);
  });

  // A refused call the ground truth made can still leave the task finishable:
  // both passes are given the issue text, so a refused issue_read costs little.
  it("says how many runs with a false pause still completed", () => {
    const stillDone = result({ visibility: "all", completed: true, deniedCalls: 1, falsePauses: 1 });
    const out = renderReport([offered, { ...stillDone, taskId: "t2" }], meta());
    expect(out).toMatch(/2 runs? had a false pause, and 1 of them still completed/);
  });

  it("compares the modes task by task, and says one run per mode is noisy", () => {
    expect(both).toContain("## What filtering hides");
    expect(both).toMatch(/\| t1 \| yes \| \*\*no\*\* \| 0 \| 3 \| 1 \|/);
    expect(both).toMatch(/one run per mode/i);
    expect(renderReport([filtered], meta())).not.toContain("## What filtering hides");
  });

  it("counts each task's predicted under-grants once, however many modes ran", () => {
    expect(both).toMatch(/- `mandate\.grants`: 1$/m);
  });

  it("counts each task's mandate once in the authority-cut breakdown", () => {
    expect(both).toMatch(/Medians across the 1 minted mandate,/);
  });

  // The plan asked for this next to the tables rather than in a source comment.
  it("says beside the tables that over-grant and the authority cut count different things", () => {
    expect(both).toMatch(/Over-grant counts granted operations[^\n]*\(operation × repository\) pairs/);
  });
});

describe("renderReport after the Phase 6 review", () => {
  // A run with no mandate -- validate() refused it, or the writer produced
  // none -- has no over-grant. It entered the median as 0%, the flattering
  // direction, the same mistake 6.4 fixed for the authority cut.
  it("leaves runs without a mandate out of the over-grant median, and says how many", () => {
    const half = { ...result().score, granted: 4, exercised: 2, overGrantRate: 0.5 };
    const { mandate: _none, ...rejected } =
      result({ taskId: "t2", proposalRejected: true, completed: false });
    const out = renderReport([result({ score: half }), rejected], meta());
    expect(out).toMatch(/\| Over-grant \| 50\.0% \(1 run without a mandate not counted\) \|/);
  });

  it("says how many runs the figures are over, not that they all completed", () => {
    const out = renderReport([
      result(), result({ visibility: "all", completed: false }),
    ], meta());
    expect(out).toMatch(/Every figure below is over 2 runs \(1 task × 2 modes\)/);
    expect(out).not.toMatch(/completed runs/);
  });
});
