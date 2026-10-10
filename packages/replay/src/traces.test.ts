import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MandateSchema, markValidated, type ValidatedMandate } from "@mandate-dev/schema";
import { parseJsonl } from "@mandate-dev/proxy";
import { scoreMandate } from "./score.js";

/**
 * The scorer against the real ground-truth traces.
 *
 * Six unconstrained runs against the live `github-mcp-server`, recorded once and
 * committed, so this runs offline and free forever. Scoring a hand-built trace
 * proves the arithmetic; scoring these proves the thing the arithmetic is for.
 */
const CORPUS = fileURLToPath(new URL("../../../fixtures/bench", import.meta.url));

const trace = (id: string) =>
  parseJsonl(readFileSync(join(CORPUS, "traces", `${id}.unconstrained.jsonl`), "utf8"));

const REPO = "pkravella/mandate-sandbox";

const mandate = (grants: unknown[]): ValidatedMandate =>
  markValidated(MandateSchema.parse({
    mandate: "m", task: "t", requestedBy: "user:a", expiresInMinutes: 60,
    ceiling: "sandbox@v1", grants, destinations: { allow: [`github.com/${REPO}`] },
  }), {
    ceilingId: "sandbox@v1", ceilingSha256: "0".repeat(64), userLevel: "admin",
    checkedAt: "2026-10-06T00:00:00.000Z", grantProofs: [],
  });

/** The mandate shape the live writer produced on the end-to-end runs. */
const AS_WRITTEN = [
  { action: "repo.read", enforcedBy: "token", resources: [REPO] },
  { action: "branch.create", enforcedBy: "proxy", resources: [REPO], branches: ["agent/*"] },
  {
    action: "contents.write", enforcedBy: "proxy", resources: [REPO],
    branches: ["agent/*"], paths: ["src/**", "test/**", "vendor/**"],
    denyPaths: [".github/workflows/**", "**.env**"],
  },
  {
    action: "pull_request.create", enforcedBy: "proxy", resources: [REPO],
    branches: ["agent/*"], base: "main", max: 1,
  },
];

const IDS = [
  "retry-swallows-last-error",
  "parse-config-throws-on-empty",
  "paginate-drops-last-page",
  "slug-collides-on-truncation",
  "bump-pinned-tool-version",
  "triage-timer-leak",
] as const;

describe("the ground-truth traces", () => {
  it("all load, and declare themselves unconstrained", () => {
    for (const id of IDS) {
      const t = trace(id);
      expect(t.mode, id).toBe("unconstrained");
      expect(t.mandateId, id).toBeUndefined();
      expect(t.nodes.length, id).toBeGreaterThan(0);
    }
  });

  it("record no denials, because nothing was enforcing", () => {
    for (const id of IDS) {
      expect(trace(id).nodes.every((n) => n.decision === "allow"), id).toBe(true);
    }
  });
});

// The finding the traces produced before this scorer existed: every task opens
// with issue_read, and the writer pruned issue.read on both end-to-end runs.
describe("the mandate the live writer actually produced", () => {
  it("under-grants issue.read on every single task", () => {
    for (const id of IDS) {
      const s = scoreMandate(mandate(AS_WRITTEN), trace(id));
      expect(s.missingActions, id).toContain("issue.read");
      expect(s.underGrants.some((u) => u.tool === "issue_read"), id).toBe(true);
    }
  });

  it("names the clause as the grant list, not a facet", () => {
    const s = scoreMandate(mandate(AS_WRITTEN), trace("retry-swallows-last-error"));
    const u = s.underGrants.find((x) => x.tool === "issue_read");
    expect(u?.clause).toBe("mandate.grants");
  });

  // Adding the one operation the traces show was needed clears the three
  // single-file tasks outright. That is the loop D8 exists to close.
  it("clears the straightforward tasks once issue.read is granted", () => {
    const fixed = mandate([
      ...AS_WRITTEN,
      { action: "issue.read", enforcedBy: "token", resources: [REPO] },
    ]);
    for (const id of ["retry-swallows-last-error", "parse-config-throws-on-empty",
      "paginate-drops-last-page"] as const) {
      const s = scoreMandate(fixed, trace(id));
      expect(s.underGrants, `${id}: ${JSON.stringify(s.underGrants)}`).toEqual([]);
    }
  });
});

describe("what each task's ground truth demands", () => {
  const fixed = mandate([
    ...AS_WRITTEN,
    { action: "issue.read", enforcedBy: "token", resources: [REPO] },
  ]);

  // slug used search_code to find the other callers the issue hinted at. The
  // catalog reaches search_code from repo.read, which is granted, so it is
  // allowed — but the task text is what made it look optional.
  it("slug needed a code search, and repo.read covers it", () => {
    const s = scoreMandate(fixed, trace("slug-collides-on-truncation"));
    expect(trace("slug-collides-on-truncation").nodes.some((n) => n.tool === "search_code"))
      .toBe(true);
    expect(s.underGrants).toEqual([]);
  });

  // The minimal-mandate case: triage wrote nothing, so every write grant is
  // over-granted and the scorer must say which.
  it("triage exercises no write at all, so the write grants are over-granted", () => {
    const s = scoreMandate(fixed, trace("triage-timer-leak"));
    expect(s.unusedActions).toContain("contents.write");
    expect(s.unusedActions).toContain("branch.create");
    expect(s.unusedActions).toContain("pull_request.create");
    expect(s.overGrantRate).toBeGreaterThan(0.5);
  });

  // ...and it needed one operation no write mandate has: leaving a comment.
  it("triage needed issue.comment, which no write-shaped mandate grants", () => {
    const s = scoreMandate(fixed, trace("triage-timer-leak"));
    expect(s.missingActions).toContain("issue.comment");
  });

  it("a read-only mandate is right for triage and wrong for everything else", () => {
    const readOnly = mandate([
      { action: "repo.read", enforcedBy: "token", resources: [REPO] },
      { action: "issue.read", enforcedBy: "token", resources: [REPO] },
      { action: "issue.comment", enforcedBy: "proxy", resources: [REPO], max: 1 },
    ]);
    expect(scoreMandate(readOnly, trace("triage-timer-leak")).underGrants).toEqual([]);
    expect(scoreMandate(readOnly, trace("retry-swallows-last-error")).underGrants.length)
      .toBeGreaterThan(0);
  });
});

describe("the scorer is a real decision, not a reimplementation", () => {
  // A branch the mandate does not permit is refused on the recorded branch,
  // which only works because the node's facets are replayed as recorded.
  it("refuses the real traces under a mandate limited to the wrong branch", () => {
    const wrongBranch = mandate([
      { action: "repo.read", enforcedBy: "token", resources: [REPO] },
      { action: "issue.read", enforcedBy: "token", resources: [REPO] },
      { action: "branch.create", enforcedBy: "proxy", resources: [REPO], branches: ["hotfix/*"] },
      {
        action: "contents.write", enforcedBy: "proxy", resources: [REPO],
        branches: ["hotfix/*"], paths: ["**"],
        denyPaths: [".github/workflows/**", "**.env**"],
      },
    ]);
    const s = scoreMandate(wrongBranch, trace("retry-swallows-last-error"));
    expect(s.underGrants.some((u) => u.clause.endsWith(".branches"))).toBe(true);
  });

  it("refuses a write outside the granted paths", () => {
    const srcOnly = mandate([
      { action: "repo.read", enforcedBy: "token", resources: [REPO] },
      { action: "issue.read", enforcedBy: "token", resources: [REPO] },
      { action: "branch.create", enforcedBy: "proxy", resources: [REPO], branches: ["agent/*"] },
      {
        action: "contents.write", enforcedBy: "proxy", resources: [REPO],
        branches: ["agent/*"], paths: ["src/**"],
        denyPaths: [".github/workflows/**", "**.env**"],
      },
    ]);
    // bump-pinned-tool-version writes vendor/toolchain.json, outside src/**.
    const s = scoreMandate(srcOnly, trace("bump-pinned-tool-version"));
    expect(s.underGrants.some((u) => u.clause.endsWith(".paths"))).toBe(true);
  });

  it("refuses a mandate scoped to a different repository", () => {
    const elsewhere = mandate([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/other"] },
    ]);
    const s = scoreMandate(elsewhere, trace("retry-swallows-last-error"));
    expect(s.underGrants.length).toBeGreaterThan(0);
    expect(s.underGrants.some((u) => u.clause.endsWith(".resources"))).toBe(true);
  });
});
