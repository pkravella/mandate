import { describe, expect, it } from "vitest";
import { MandateSchema, markValidated, type ValidatedMandate } from "@mandate-dev/schema";
import type { ActionGraph, ActionNode } from "@mandate-dev/proxy";
import { scoreMandate } from "./score.js";

const mandate = (grants: unknown[]): ValidatedMandate =>
  markValidated(MandateSchema.parse({
    mandate: "m", task: "t", requestedBy: "user:a", expiresInMinutes: 60, ceiling: "c@v1",
    grants, destinations: { allow: ["github.com/acme/api"] },
  }), {
    ceilingId: "c@v1", ceilingSha256: "0".repeat(64), userLevel: "push",
    checkedAt: "2026-10-03T00:00:00.000Z", grantProofs: [],
  });

let seq = 0;
const node = (tool: string, over: Partial<ActionNode> = {}): ActionNode => ({
  seq: ++seq,
  at: "2026-10-03T00:00:00.000Z",
  tool,
  paths: [],
  destinations: [],
  decision: "allow",
  outcome: "ok",
  outputBytes: 1,
  outputDigest: "0".repeat(12),
  durationMs: 1,
  resource: "acme/api",
  ...over,
});

/** An unconstrained trace, which is what ground truth actually looks like. */
const trace = (nodes: ActionNode[]): ActionGraph => {
  seq = 0;
  return { mode: "unconstrained", nodes: nodes.map((n, i) => ({ ...n, seq: i + 1 })) };
};

const READ = { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] };
const WRITE = {
  action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
  branches: ["agent/42-*"], paths: ["**"],
  denyPaths: [".github/workflows/**", "**.env**"],
};
const PR = {
  action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
  branches: ["agent/42-*"], base: "main", max: 1,
};

describe("scoreMandate over-grant", () => {
  it("counts a granted operation the trace never used", () => {
    const s = scoreMandate(
      mandate([READ, { action: "issue.comment", enforcedBy: "proxy", resources: ["acme/api"], max: 1 }]),
      trace([node("get_file_contents", { paths: ["src/a.ts"] })]),
    );
    expect(s.granted).toBe(2);
    expect(s.exercised).toBe(1);
    expect(s.overGrantRate).toBeCloseTo(0.5);
    expect(s.unusedActions).toEqual(["issue.comment"]);
  });

  it("reports zero over-grant when every grant was used", () => {
    const s = scoreMandate(
      mandate([READ]),
      trace([node("get_file_contents", { paths: ["src/a.ts"] })]),
    );
    expect(s.overGrantRate).toBe(0);
    expect(s.unusedActions).toEqual([]);
  });

  it("treats an empty trace as everything being over-granted", () => {
    const s = scoreMandate(mandate([READ]), trace([]));
    expect(s.overGrantRate).toBe(1);
    expect(s.underGrantRate).toBe(0);
  });
});

describe("scoreMandate under-grant", () => {
  it("counts a tool no grant reaches, with the clause", () => {
    const s = scoreMandate(
      mandate([READ]),
      trace([node("get_file_contents"), node("create_pull_request", { base: "main", branch: "agent/1" })]),
    );
    expect(s.underGrants).toHaveLength(1);
    expect(s.underGrants[0]).toMatchObject({ seq: 2, tool: "create_pull_request" });
    expect(s.underGrants[0]?.clause).toContain("grants");
  });

  it("counts a branch violation as an under-grant, not an over-grant", () => {
    const s = scoreMandate(
      mandate([WRITE]),
      trace([node("create_or_update_file", { branch: "main", paths: ["src/a.ts"] })]),
    );
    expect(s.underGrants).toHaveLength(1);
    expect(s.underGrants[0]?.clause).toContain("branches");
    expect(s.overGrantRate).toBe(0);
  });

  it("counts a max violation on the call that exceeded the cap", () => {
    const s = scoreMandate(
      mandate([PR]),
      trace([
        node("create_pull_request", { branch: "agent/42-x", base: "main" }),
        node("create_pull_request", { branch: "agent/42-x", base: "main" }),
      ]),
    );
    expect(s.underGrants.map((u) => u.seq)).toEqual([2]);
  });

  it("names the operations the trace needed and the mandate lacked", () => {
    const s = scoreMandate(
      mandate([READ]),
      trace([node("get_file_contents"), node("issue_write", { resource: "acme/api" })]),
    );
    // The actionable output: a writer that forgot an operation should be told
    // which one, not just that some call was blocked.
    expect(s.missingActions).toContain("issue.create");
  });

  it("ignores calls the original trace itself had denied", () => {
    // Built without `outcome` or `outputDigest` rather than with them set to
    // undefined: the node type forbids an explicit undefined, and a denied node
    // that carried either would be rejected by parseJsonl anyway.
    const denied: ActionNode = {
      seq: 1, at: "2026-10-03T00:00:00.000Z", tool: "merge_pull_request",
      paths: [], destinations: [], decision: "deny",
      clause: "mandate.grants", reason: "not granted",
      outputBytes: 0, durationMs: 0, resource: "acme/api",
    };
    const s = scoreMandate(
      mandate([READ]),
      { mode: "unconstrained", nodes: [denied] },
    );
    expect(s.underGrants).toHaveLength(0);
    expect(s.consideredCalls).toBe(0);
  });
});

// Nine tools are reached by more than one operation and a call is allowed if it
// satisfies AT LEAST ONE rule. Taking the first rule for a tool reimplements
// exactly the bug Task 11 and 13 fixed in the proxy, and would report
// under-grants the proxy would never have produced.
describe("scoreMandate with a tool several grants reach", () => {
  // create_or_update_file is reached by both contents.write and
  // workflows.write, and both constrain paths — so this is a pair where the
  // rule that decides is genuinely not the first one.
  const twoGrants = mandate([
    {
      action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], paths: ["src/**"],
    },
    {
      action: "workflows.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], paths: [".github/workflows/**"],
    },
  ]);
  const write = (paths: string[]) =>
    trace([node("create_or_update_file", { branch: "agent/42-x", paths })]);

  it("allows a call the first rule accepts", () => {
    const s = scoreMandate(twoGrants, write(["src/a.ts"]));
    expect(s.underGrants).toEqual([]);
    expect(s.unusedActions).toEqual(["workflows.write"]);
  });

  it("allows a call only the second rule accepts", () => {
    const s = scoreMandate(twoGrants, write([".github/workflows/ci.yml"]));
    expect(s.underGrants).toEqual([]);
    expect(s.unusedActions).toEqual(["contents.write"]);
  });

  it("denies a call neither rule accepts", () => {
    const s = scoreMandate(twoGrants, write(["etc/a"]));
    expect(s.underGrants).toHaveLength(1);
    expect(s.underGrants[0]?.clause).toContain("paths");
  });

  // The documented consequence of "any rule may allow": a grant that leaves a
  // facet unconstrained makes every other grant's limit on that facet useless
  // for the tools they share. The scorer has to show that, not hide it.
  it("allows anything once one rule leaves the facet unconstrained", () => {
    const loose = mandate([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      { action: "contents.read", enforcedBy: "proxy", resources: ["acme/api"], paths: ["src/**"] },
    ]);
    const s = scoreMandate(loose, trace([node("get_file_contents", { paths: ["etc/secrets"] })]));
    expect(s.underGrants).toEqual([]);
  });
});

// The facets are replayed as recorded rather than rebuilt into arguments. A
// rebuild loses a root path (`""` becomes no path) and loses destinations (they
// re-expand into a field the extractor does not recognise), so a replay would
// check fewer facets than the run did.
describe("scoreMandate replays the recorded facets exactly", () => {
  it("checks a destination the node recorded", () => {
    const s = scoreMandate(
      mandate([READ]),
      trace([node("get_file_contents", { destinations: ["evil.example.com"] })]),
    );
    expect(s.underGrants).toHaveLength(1);
    expect(s.underGrants[0]?.clause).toBe("destinations.allow");
  });

  it("refuses a destination value the node recorded as unreadable, as the proxy would", () => {
    const s = scoreMandate(
      mandate([READ]),
      trace([node("get_file_contents", {
        unreadableDestinations: [{ field: "url", value: "//evil.example.com/x" }],
      })]),
    );
    expect(s.underGrants).toHaveLength(1);
    expect(s.underGrants[0]?.clause).toBe("destinations.allow");
  });

  // Replay takes the decision the proxy would: an issue_write create is decided
  // only by issue.create, so its max holds even with issue.update granted.
  it("holds a create's max against creates, whatever else is granted on issue_write", () => {
    const m = mandate([
      { action: "issue.create", enforcedBy: "proxy", resources: ["acme/api"], max: 1 },
      { action: "issue.update", enforcedBy: "proxy", resources: ["acme/api"], max: 5 },
    ]);
    const s = scoreMandate(m, trace([
      node("issue_write", { method: "create" }),
      node("issue_write", { method: "create" }),
    ]));
    expect(s.underGrants).toHaveLength(1);
    expect(s.underGrants[0]?.clause).toBe("issue.create.max");
  });

  // Found reviewing Phase 5: a refused attribution added every operation the
  // tool serves to missingActions, so a mandate granting issue.update and
  // issue.close was told it lacked them.
  it("names only the operation the call actually needed when attribution refuses it", () => {
    const m = mandate([
      { action: "issue.update", enforcedBy: "proxy", resources: ["acme/api"], max: 5 },
      { action: "issue.close", enforcedBy: "proxy", resources: ["acme/api"], max: 1 },
    ]);
    const s = scoreMandate(m, trace([node("issue_write", { method: "create" })]));
    expect(s.missingActions).toEqual(["issue.create"]);
  });

  // A trace recorded before the method was, says nothing about it. Replay
  // cannot know what such a call was, so it keeps the old union.
  it("keeps the old reading for an issue_write node recorded without a method", () => {
    const m = mandate([
      { action: "issue.create", enforcedBy: "proxy", resources: ["acme/api"], max: 1 },
      { action: "issue.update", enforcedBy: "proxy", resources: ["acme/api"], max: 5 },
    ]);
    const s = scoreMandate(m, trace([node("issue_write"), node("issue_write")]));
    expect(s.underGrants).toEqual([]);
  });

  it("allows a destination the mandate permits", () => {
    const s = scoreMandate(
      mandate([READ]),
      trace([node("get_file_contents", { destinations: ["github.com/acme/api"] })]),
    );
    expect(s.underGrants).toEqual([]);
  });

  it("checks a recorded root path against the granted paths", () => {
    const s = scoreMandate(
      mandate([{ ...WRITE, paths: ["src/**"] }]),
      trace([node("create_or_update_file", { branch: "agent/42-x", paths: [""] })]),
    );
    expect(s.underGrants).toHaveLength(1);
    expect(s.underGrants[0]?.clause).toContain("paths");
  });

  it("checks a deny path the node recorded", () => {
    const s = scoreMandate(
      mandate([WRITE]),
      trace([node("create_or_update_file", {
        branch: "agent/42-x", paths: [".github/workflows/ci.yml"],
      })]),
    );
    expect(s.underGrants[0]?.clause).toContain("denyPaths");
  });
});

describe("scoreMandate accepts either kind of trace", () => {
  it("scores an unconstrained trace, which carries no mandate", () => {
    const s = scoreMandate(mandate([READ]), trace([node("get_file_contents")]));
    expect(s.consideredCalls).toBe(1);
  });

  it("scores an enforced trace from a different mandate", () => {
    const s = scoreMandate(mandate([READ]), {
      mode: "enforced", mandateId: "other", mandateHash: "a".repeat(64),
      nodes: [node("get_file_contents")],
    });
    expect(s.consideredCalls).toBe(1);
  });
});
