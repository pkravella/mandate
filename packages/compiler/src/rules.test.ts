import { describe, expect, it } from "vitest";
import {
  MandateSchema, mandateHash, markValidated, unwrap, type ValidatedMandate,
} from "@mandate-dev/schema";
import { compileRules, enforcementReport, rulesForTool } from "./rules.js";

const validated = (grants: unknown[], over: Record<string, unknown> = {}): ValidatedMandate =>
  markValidated(MandateSchema.parse({
    mandate: "fix-issue-42", task: "t", requestedBy: "user:alice", expiresInMinutes: 60,
    ceiling: "org-policy@v12", grants,
    destinations: { allow: ["github.com/acme/api"] },
    ...over,
  }), {
    ceilingId: "org-policy@v12", ceilingSha256: "0".repeat(64), userLevel: "push",
    checkedAt: "2026-10-03T00:00:00.000Z", grantProofs: [],
  });

const FIX_42 = validated([
  { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
  { action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"], branches: ["agent/42-*"] },
  {
    action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
    branches: ["agent/42-*"], paths: ["**"],
    denyPaths: [".github/workflows/**", "**.env**"],
  },
  {
    action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
    branches: ["agent/42-*"], base: "main", max: 1,
  },
]);

describe("compileRules", () => {
  const rules = compileRules(FIX_42, new Date("2026-10-03T00:00:00.000Z"));

  it("allows exactly the MCP tools the grants reach", () => {
    expect(rules.allowedTools).toContain("create_or_update_file");
    expect(rules.allowedTools).toContain("create_branch");
    expect(rules.allowedTools).toContain("create_pull_request");
    expect(rules.allowedTools).toContain("get_file_contents");
  });

  // The action graph's header names the mandate the proxy enforced. `mandateId`
  // alone cannot: slug() truncates the task text, so two tasks opening with the
  // same words share an id.
  it("carries the mandate's canonical hash, so a trace names one exact mandate", () => {
    expect(rules.mandateHash).toBe(mandateHash(unwrap(FIX_42)));
    expect(rules.mandateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives two mandates differing only in a grant different hashes", () => {
    const narrower = validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    ]);
    expect(compileRules(narrower).mandateHash).not.toBe(rules.mandateHash);
  });

  it("does not allow a tool no grant reaches — merge is the exit-criterion case", () => {
    expect(rules.allowedTools).not.toContain("merge_pull_request");
    expect(rules.allowedTools).not.toContain("delete_file");
  });

  it("carries the grant's constraints onto every tool that reaches it", () => {
    const write = rules.rules.filter((r) => r.action === "contents.write");
    expect(write.map((r) => r.tool).sort()).toEqual(["create_or_update_file", "push_files"]);
    for (const r of write) {
      expect(r.branches).toEqual(["agent/42-*"]);
      expect(r.denyPaths).toEqual([".github/workflows/**", "**.env**"]);
    }
  });

  it("sets expiry from the mandate, not from the token", () => {
    expect(rules.expiresAt).toBe("2026-10-03T01:00:00.000Z");
  });

  it("passes the destination allow list through", () => {
    expect(rules.destinations).toEqual(["github.com/acme/api"]);
  });

  it("keeps max on the side-effecting rule", () => {
    expect(rules.rules.find((r) => r.tool === "create_pull_request")?.max).toBe(1);
  });

  it("lists no tool twice, however many grants reach it", () => {
    expect(new Set(rules.allowedTools).size).toBe(rules.allowedTools.length);
  });
});

// Nine MCP tools in the catalog are reached by more than one operation, and the
// plan never said how their rules combine. Task 13 enforces against this data,
// so the semantics are pinned here rather than invented there.
describe("rulesForTool", () => {
  const twoReaders = validated([
    { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    {
      action: "contents.read", enforcedBy: "proxy", resources: ["acme/api"],
      paths: ["src/**"],
    },
  ]);

  it("returns every rule for a tool two grants both reach", () => {
    const rules = compileRules(twoReaders);
    const forTool = rulesForTool(rules, "get_file_contents");
    expect(forTool.map((r) => r.action).sort()).toEqual(["contents.read", "repo.read"]);
  });

  it("returns nothing for a tool no grant reaches", () => {
    expect(rulesForTool(compileRules(twoReaders), "merge_pull_request")).toEqual([]);
  });
});

describe("enforcementReport", () => {
  const rows = enforcementReport(FIX_42);

  it("covers every grant", () => {
    expect(rows).toHaveLength(4);
  });

  it("says the token enforces only repository and permission scope for a proxy grant", () => {
    const row = rows.find((r) => r.action === "contents.write");
    expect(row?.tokenEnforces).toContain("repository");
    expect(row?.tokenEnforces).not.toContain("branch");
    expect(row?.proxyEnforces).toContain("branch");
    expect(row?.proxyEnforces).toContain("path");
  });

  // The token is minted once for the union of every grant's repositories, so a
  // per-grant claim that the token bounds *this* grant to *its* repository is
  // exactly the kind of overclaim this report exists to prevent.
  it("states the token's repository scope as the mandate-wide set, not per grant", () => {
    const rows2 = enforcementReport(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      { action: "issue.read", enforcedBy: "token", resources: ["acme/web"] },
    ]));
    for (const row of rows2) {
      expect(row.tokenEnforces).toContain("acme/api");
      expect(row.tokenEnforces).toContain("acme/web");
    }
  });

  it("reports no gaps for a mandate whose limits are all enforceable", () => {
    expect(rows.flatMap((r) => r.gaps)).toEqual([]);
  });

  // 13 catalog operations have no MCP tool. The proxy cannot allow or deny what
  // it never sees, so for those the token is the only control — and for
  // branch.delete the token's contents:write permits it over the raw API.
  it("reports an operation no MCP tool reaches as invisible to the proxy", () => {
    const rows2 = enforcementReport(validated([
      { action: "branch.delete", enforcedBy: "token", resources: ["acme/api"], branches: ["agent/*"] },
    ]));
    expect(rows2[0]?.gaps.join(" ")).toMatch(/no MCP tool/i);
  });

  // The dangerous collision: get_file_contents is reached by repo.read, which
  // takes no path limit, and by contents.read, which does. Granting both makes
  // the path limit decorative, because a call need only satisfy one rule.
  it("reports a limit another grant on the same tool makes unenforceable", () => {
    const rows2 = enforcementReport(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      { action: "contents.read", enforcedBy: "proxy", resources: ["acme/api"], paths: ["src/**"] },
    ]));
    const shadowed = rows2.find((r) => r.action === "contents.read");
    expect(shadowed?.gaps.join(" ")).toContain("get_file_contents");
    expect(shadowed?.gaps.join(" ")).toContain("repo.read");
    expect(shadowed?.gaps.join(" ")).toMatch(/paths/);
  });

  it("does not cry shadow when the other grant constrains the same facet", () => {
    const rows2 = enforcementReport(validated([
      { action: "contents.read", enforcedBy: "proxy", resources: ["acme/api"], paths: ["src/**"] },
      { action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
        branches: ["agent/*"], paths: ["src/**"], denyPaths: [".github/workflows/**", "**.env**"] },
    ]));
    // Both constrain paths, so neither makes the other's path limit useless.
    for (const row of rows2) {
      expect(row.gaps.filter((g) => g.includes("paths"))).toEqual([]);
    }
  });

  it("names the facet and the tool, so the fix is obvious", () => {
    const rows2 = enforcementReport(validated([
      { action: "pull_request.update", enforcedBy: "proxy", resources: ["acme/api"], max: 2 },
      { action: "pull_request.close", enforcedBy: "token", resources: ["acme/api"] },
    ]));
    const gaps = rows2.flatMap((r) => r.gaps).join(" ");
    expect(gaps).toContain("update_pull_request");
    expect(gaps).toContain("max");
  });
});

// The mandate the live writer actually produced for "fix issue #42", recorded
// verbatim. Compiling a real artifact catches the case where each piece is
// individually right and the chain still produces something useless.
const LIVE_WRITER_OUTPUT = validated([
  { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
  {
    action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"],
    branches: ["agent/issue-42*"],
  },
  {
    action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
    branches: ["agent/issue-42*"],
    paths: ["src/retry.ts", "src/**/*.test.ts", "test/**"],
    denyPaths: [".github/workflows/**", "**.env**"],
  },
  {
    action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
    branches: ["agent/issue-42*"], base: "main", max: 1,
  },
], { expiresInMinutes: 30 });

describe("the mandate the live writer produced", () => {
  it("compiles to rules with no enforcement gaps", () => {
    expect(enforcementReport(LIVE_WRITER_OUTPUT).flatMap((r) => r.gaps)).toEqual([]);
  });

  // Phase 2's exit criterion is that an attempted merge is blocked.
  it("does not allow the merge tool", () => {
    const rules = compileRules(LIVE_WRITER_OUTPUT);
    expect(rules.allowedTools).not.toContain("merge_pull_request");
    expect(rulesForTool(rules, "merge_pull_request")).toEqual([]);
  });

  it("carries the path limits onto both tools that write files", () => {
    const rules = compileRules(LIVE_WRITER_OUTPUT);
    for (const tool of ["create_or_update_file", "push_files"]) {
      const rule = rulesForTool(rules, tool).find((r) => r.action === "contents.write");
      expect(rule?.paths).toContain("src/retry.ts");
      expect(rule?.denyPaths).toContain(".github/workflows/**");
    }
  });

  it("expires on the mandate's 30 minutes, not the token's hour", () => {
    const at = new Date("2026-10-04T05:00:00.000Z");
    expect(compileRules(LIVE_WRITER_OUTPUT, at).expiresAt).toBe("2026-10-04T05:30:00.000Z");
  });
});
