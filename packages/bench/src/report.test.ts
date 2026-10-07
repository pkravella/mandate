import { describe, expect, it } from "vitest";
import { TARGET_COMPOSITION } from "./tasks.js";
import { renderReport, type BenchResult, type CorpusMeta } from "./report.js";

const result = (over: Partial<BenchResult> = {}): BenchResult => ({
  taskId: "t1",
  category: "single-file-fix",
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
  authorityCut: { token: 0.72, proxy: 0.94 },
  cost: 0.27,
  ...over,
});

const meta = (over: Partial<CorpusMeta> = {}): CorpusMeta => ({
  repo: "pkravella/mandate-sandbox",
  composition: { "single-file-fix": 3, "multi-file-fix": 1, "dependency-bump": 1, triage: 1 },
  shortfall: { "single-file-fix": 27, "multi-file-fix": 9, "dependency-bump": 4, triage: 4 },
  provenance: { synthetic: 6, derived: 0 },
  groundTruthFrom: "unconstrained runs recorded 2026-10-06",
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
    expect(out).toMatch(/\| t1 \| single-file-fix \| yes \|/);
    expect(out).toMatch(/\| second \| single-file-fix \| yes \|/);
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
