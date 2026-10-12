import { describe, expect, it } from "vitest";
import { MandateSchema, markValidated, type ValidatedMandate } from "@mandate-dev/schema";
import { compileGhAw, ghAwBackend, type GhAwResult } from "./ghaw.js";

const validated = (grants: unknown[], over: Record<string, unknown> = {}): ValidatedMandate =>
  markValidated(MandateSchema.parse({
    mandate: "fix-issue-42", task: "t", requestedBy: "user:alice", expiresInMinutes: 30,
    ceiling: "org-policy@v12", grants,
    destinations: { allow: ["github.com/acme/api", "api.github.com"] },
    ...over,
  }), {
    ceilingId: "org-policy-v12.cedar", ceilingSha256: "0".repeat(64), userLevel: "push",
    checkedAt: "2026-10-03T00:00:00.000Z", grantProofs: [],
  });

/** The shape the writer produced for every fix task in the published benchmark. */
const fixGrants = (over: { branches?: string[]; paths?: string[]; base?: string } = {}) => [
  { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
  { action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"], branches: over.branches ?? ["agent/42-fix"] },
  {
    action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
    branches: over.branches ?? ["agent/42-fix"], paths: over.paths ?? ["src/retry.js", "test/retry.test.js"],
    denyPaths: [".github/workflows/**", "**.env**"],
  },
  {
    action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
    branches: over.branches ?? ["agent/42-fix"], base: over.base ?? "main", max: 1,
  },
];

const ok = (r: GhAwResult) => {
  if (!r.ok) throw new Error(`refused: ${r.refusals.map((x) => x.reason).join("; ")}`);
  return r;
};
const refusals = (r: GhAwResult): string => (r.ok ? "" : r.refusals.map((x) => x.reason).join("\n"));
type Obj = Record<string, unknown>;
const at = (o: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((v, k) => (v as Obj | undefined)?.[k], o);

describe("compileGhAw: a fix-issue mandate", () => {
  const r = ok(compileGhAw(validated(fixGrants())));
  const pr = at(r.frontmatter, "safe-outputs", "create-pull-request") as Obj;

  it("names the one repository the workflow must live in", () => {
    expect(r.repo).toBe("acme/api");
  });

  it("is a Backend over a ValidatedMandate", () => {
    expect(ghAwBackend.name).toBe("gh-aw-safe-outputs");
    expect(ghAwBackend.compile(validated(fixGrants()))).toEqual(r);
  });

  it("carries the pull request's own count", () => {
    const g = fixGrants();
    (g[3] as { max: number }).max = 3;
    expect(at(ok(compileGhAw(validated(g))).frontmatter, "safe-outputs", "create-pull-request", "max")).toBe(3);
  });

  it("carries the pull request's count, base and branches", () => {
    expect(pr).toMatchObject({ max: 1, "base-branch": "main", "allowed-branches": ["agent/42-fix"] });
  });

  // gh-aw checks the branch name the agent asked for, then appends a random
  // suffix before pushing. The pushed branch must be the approved one.
  it("keeps the branch name gh-aw checked as the branch it pushes", () => {
    expect(pr["preserve-branch-name"]).toBe(true);
    expect(pr["branch-prefix"]).toBeUndefined();
  });

  it("limits the patch to the mandate's paths, and strips its deny paths", () => {
    expect(pr["allowed-files"]).toEqual(["src/retry.js", "test/retry.test.js"]);
    expect(pr["excluded-files"]).toEqual([".github/workflows/**", "**.env**"]);
  });

  // Each of these is a write gh-aw makes on its own unless told not to, and
  // none is in the mandate.
  it("switches off every write the mandate did not grant", () => {
    expect(pr).toMatchObject({
      "fallback-as-issue": false, "auto-close-issue": false, "auto-merge": false,
      "close-older-pull-requests": false, stacked: false, "recreate-ref": false,
      "protected-files": "blocked",
    });
    expect(pr["expires"]).toBeUndefined();
    expect(pr["allowed-base-branches"]).toBeUndefined();
    expect(pr["target-repo"]).toBeUndefined();
    const so = at(r.frontmatter, "safe-outputs") as Obj;
    // Found preparing the live run: detection files an "[aw] Detection Runs"
    // issue and labels the triggering item needs-review, by default.
    expect(so["threat-detection"]).toEqual({ "report-as-issue": false, "continue-on-error": false });
    expect(so).toMatchObject({
      "activation-comments": false, "report-failed-jobs": false, "report-failure-as-issue": false,
      "report-incomplete": { "create-issue": false },
      "missing-tool": { "create-issue": false }, "missing-data": { "create-issue": false },
    });
    expect(Object.keys(so).filter((k) => !GLOBAL_KEYS.has(k) && k !== "github-token"))
      .toEqual(["create-pull-request"]);
  });

  it("gives the agent read-only GitHub tools for what the mandate reads, on its repository", () => {
    expect(at(r.frontmatter, "tools", "github")).toEqual({
      "read-only": true,
      "github-token": "${{ secrets.GITHUB_TOKEN }}",
      "allowed-repos": ["acme/api"],
      // gh-aw's compiler requires one beside allowed-repos (found by the live
      // run); "none" filters nothing, which is what the mandate says.
      "min-integrity": "none",
      allowed: ["get_file_contents", "list_branches", "search_code"],
    });
    expect(r.frontmatter["permissions"]).toEqual({ contents: "read" });
  });

  // gh-aw prefers a PAT from GH_AW_GITHUB_TOKEN (or ..._MCP_SERVER_TOKEN) when
  // the secret exists, and a PAT ignores permissions:. Pinned, the workflow
  // token's permissions are the bound; found in review.
  it("pins the agent's GitHub tools and the safe-output jobs to the workflow token", () => {
    expect(at(r.frontmatter, "tools", "github", "github-token")).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(at(r.frontmatter, "safe-outputs", "github-token")).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(pr["github-token-for-extra-empty-commit"]).toBe("none");
  });

  it("caps the run at the mandate's expiry, and names its egress as the agent's own", () => {
    expect(r.frontmatter["timeout-minutes"]).toBe(30);
    expect(r.frontmatter["network"]).toBe("defaults");
  });

  // gh-aw's own egress for the agent and its model API: the operator's
  // choice, like --agent-egress, and not a destination the mandate grants.
  it("says what it adds that is not from the mandate", () => {
    expect(r.beyondMandate.join("\n")).toMatch(/network: defaults.*not a destination/s);
    expect(r.beyondMandate.join("\n")).toMatch(/bash.*gh-aw's own default/s);
  });

  // gh-aw's strict mode requires bash be stated beside min-integrity: none.
  // ["*"] is what gh-aw sets itself when its sandbox is on (tools.go:613-628),
  // so stating it grants nothing gh-aw would not.
  it("states gh-aw's default shell, which its strict mode requires", () => {
    expect(at(r.frontmatter, "tools", "bash")).toEqual(["*"]);
  });

  it("says where it is narrower than the mandate", () => {
    expect(r.narrowings.join("\n")).toMatch(/protected-files/);
    expect(r.narrowings.join("\n")).toMatch(/excluded-files/);
  });
});

const GLOBAL_KEYS = new Set([
  "threat-detection", "activation-comments", "report-failed-jobs", "report-failure-as-issue", "report-incomplete",
  "missing-tool", "missing-data",
]);

describe("compileGhAw: comments", () => {
  const triage = (grants: unknown[]) => validated([
    { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    { action: "issue.read", enforcedBy: "token", resources: ["acme/api"] },
    ...grants,
  ]);

  it("maps issue comments to add-comment on any issue in the repository, never discussions", () => {
    const r = ok(compileGhAw(triage([
      { action: "issue.comment", enforcedBy: "token", resources: ["acme/api"], max: 2 },
    ])));
    expect(at(r.frontmatter, "safe-outputs", "add-comment")).toEqual({
      max: 2, target: "*", issues: true, "pull-requests": false, discussions: false,
    });
    expect(r.frontmatter["permissions"]).toEqual({ contents: "read", issues: "read" });
  });

  // The proxy decides add_issue_comment by either grant, each with its own
  // count, so their limits add up. One add-comment carries the sum.
  it("adds the issue and pull-request comment limits, as the proxy does", () => {
    const r = ok(compileGhAw(triage([
      { action: "issue.comment", enforcedBy: "token", resources: ["acme/api"], max: 2 },
      { action: "pull_request.comment", enforcedBy: "token", resources: ["acme/api"], max: 3 },
    ])));
    expect(at(r.frontmatter, "safe-outputs", "add-comment")).toMatchObject({
      max: 5, issues: true, "pull-requests": true, discussions: false,
    });
  });
});

describe("compileGhAw: what it refuses rather than widen", () => {
  const refuse = (m: ValidatedMandate, pattern: RegExp) => {
    const r = compileGhAw(m);
    expect(r.ok).toBe(false);
    expect(refusals(r)).toMatch(pattern);
  };

  it("a mandate over two repositories", () => {
    refuse(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api", "acme/web"] },
      ...fixGrants().slice(1),
    ]), /one repository/);
  });

  it("a repository pattern", () => {
    refuse(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/*"] },
      ...fixGrants().slice(1),
    ]), /literal/);
  });

  // gh-aw checks the name the agent gave and pushes it normalised: a pattern
  // like agent/42-* admits "agent/42-!!", which is pushed as "agent/42".
  it("a branch pattern, since normalisation can push a name outside it", () => {
    refuse(validated(fixGrants({ branches: ["agent/42-*"] })), /pattern.*normalis/s);
  });

  it("a lone * branch pattern", () => {
    refuse(validated(fixGrants({ branches: ["*"] })), /pattern/);
  });

  it("a literal branch gh-aw would rename when it pushes", () => {
    refuse(validated(fixGrants({ branches: ["agent/fix#42"] })), /agent\/fix#42.*normalis/s);
    refuse(validated(fixGrants({ branches: ["agent/42--fix"] })), /normalis/);
    refuse(validated(fixGrants({ branches: ["-agent/42"] })), /normalis/);
  });

  it("grants that disagree on the branch set", () => {
    const g = fixGrants();
    (g[1] as { branches: string[] }).branches = ["agent/42-other"];
    refuse(validated(g), /limit branches differently/);
  });

  it("a pull request or a comment with no count", () => {
    const g = fixGrants();
    delete (g[3] as { max?: number }).max;
    refuse(validated(g), /pull_request\.create has no max/);
    refuse(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      { action: "issue.comment", enforcedBy: "token", resources: ["acme/api"] },
    ]), /issue\.comment has no max/);
  });

  it("a base given as a pattern", () => {
    refuse(validated(fixGrants({ base: "release/*" })), /base/);
  });

  // Found in review: gh-aw's create-pull-request commits whatever the agent
  // changed, so a PR grant without contents.write exported with no
  // allowed-files at all -- any file. The three go together or not at all.
  it("pull_request.create without contents.write or branch.create", () => {
    const [read, branch, , pr] = fixGrants();
    refuse(validated([read, branch, pr]), /pull_request\.create.*contents\.write/s);
    const [, , write] = fixGrants();
    refuse(validated([read, write, pr]), /branch\.create/);
  });

  // gh-aw v0.89.21 bug, found by the live run: when PR creation is refused
  // for permissions, it opens a fallback issue before it checks
  // fallback-as-issue (create_pull_request.cjs:2815-2875). Only a token
  // without issues: write stops it, and add-comment on issues grants that.
  it("a pull request together with issue comments, while gh-aw ignores fallback-as-issue", () => {
    refuse(validated([
      ...fixGrants(),
      { action: "issue.comment", enforcedBy: "token", resources: ["acme/api"], max: 1 },
    ]), /issue\.comment.*fallback issue/s);
  });

  it("but a pull request with pull-request comments, which grant no issues: write", () => {
    ok(compileGhAw(validated([
      ...fixGrants(),
      { action: "pull_request.comment", enforcedBy: "token", resources: ["acme/api"], max: 1 },
    ])));
  });

  it("contents.write without pull_request.create", () => {
    refuse(validated(fixGrants().slice(0, 3)), /contents\.write.*pull_request\.create/s);
  });

  it("an operation it has no safe output for, naming it", () => {
    refuse(validated([
      ...fixGrants(),
      { action: "issue.create", enforcedBy: "token", resources: ["acme/api"], max: 1 },
    ]), /issue\.create/);
  });

  // gh-aw adds a create-issue output to any workflow with no write output of
  // its own -- the published triage mandate (repo.read alone) is one.
  it("a mandate with no write at all", () => {
    refuse(validated([{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }]),
      /create-issue/);
  });

  it("a read limited by path or branch, which a tool allow-list cannot hold", () => {
    refuse(validated([
      ...fixGrants(),
      { action: "contents.read", enforcedBy: "proxy", resources: ["acme/api"], paths: ["src/**"] },
    ]), /contents\.read/);
  });

  it("a destination outside GitHub", () => {
    refuse(validated(fixGrants(), {
      destinations: { allow: ["github.com/acme/api", "registry.npmjs.org"] },
    }), /registry\.npmjs\.org/);
  });

  it("reports every refusal, not just the first", () => {
    const r = compileGhAw(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      { action: "issue.create", enforcedBy: "token", resources: ["acme/api"], max: 1 },
      { action: "issue.label", enforcedBy: "token", resources: ["acme/api"], max: 1 },
    ]));
    expect(refusals(r)).toMatch(/issue\.create/);
    expect(refusals(r)).toMatch(/issue\.label/);
  });
});
