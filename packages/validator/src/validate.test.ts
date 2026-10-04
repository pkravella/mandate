import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MandateSchema, proofOf, type ProposedMandate } from "@mandate-dev/schema";
import { loadCeiling } from "./ceiling.js";
import { validate } from "./validate.js";
import type { UserAuthority } from "./userAuthority.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/ceilings/${name}`, import.meta.url)), "utf8");

const ceiling = loadCeiling("org-policy@v12", fixture("org-policy-v12.cedar"), fixture("schema.cedarschema"));
const alice: UserAuthority = { login: "alice", level: "push" };

const propose = (grants: unknown[]): ProposedMandate =>
  MandateSchema.parse({
    mandate: "fix-issue-42",
    task: "Fix issue #42 and open a PR",
    requestedBy: "user:alice",
    expiresInMinutes: 60,
    ceiling: "org-policy@v12",
    grants,
    destinations: { allow: ["github.com/acme/api"] },
  }) as ProposedMandate;

const READ = { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] };
// Note the deny list. The ceiling's Cedar `like "*.env*"` is character-wise,
// not segment-aware, so it denies any path CONTAINING ".env" -- including
// "src/s.env". A mandate must be at least as restrictive, so the PRD example's
// `**/.env*` (basename starts with .env) is NOT strong enough for this
// ceiling. See the dedicated test below.
const WRITE = {
  action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
  branches: ["agent/42-*"], paths: ["src/**"], denyPaths: [".github/workflows/**", "**.env**"],
};
const BRANCH = { action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"], branches: ["agent/42-*"] };
const PR = {
  action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
  branches: ["agent/42-*"], base: "main", max: 1,
};

const codes = (grants: unknown[], authority: UserAuthority = alice) => {
  const r = validate(propose(grants), { ceiling, authority });
  return r.ok ? [] : r.rejections.map((x) => x.code);
};

describe("validate — acceptance", () => {
  it("accepts a mandate for the PRD's example task", () => {
    const r = validate(propose([READ, BRANCH, WRITE, PR]), { ceiling, authority: alice });
    expect(r.ok, r.ok ? "" : JSON.stringify(r.rejections, null, 1)).toBe(true);
  });

  it("produces a ValidatedMandate whose proof names the ceiling and the clauses", () => {
    const r = validate(propose([READ, WRITE]), { ceiling, authority: alice });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const proof = proofOf(r.mandate);
    expect(proof.ceilingId).toBe("org-policy@v12");
    expect(proof.userLevel).toBe("push");
    expect(proof.grantProofs).toHaveLength(2);
    expect(proof.grantProofs.flatMap((g) => g.permittedBy)).toContain("allow-agent-branch-writes");
    expect(proof.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts a grant strictly narrower than the ceiling", () => {
    expect(codes([{ ...WRITE, branches: ["agent/42-fix"], paths: ["src/one.ts"] }])).toEqual([]);
  });

  it("accepts a deny list stronger than the ceiling's", () => {
    expect(codes([{ ...WRITE, denyPaths: [".github/**", "**.env**", "**secret**"] }])).toEqual([]);
  });
});

describe("validate — ceiling containment", () => {
  it("rejects an operation the ceiling has no rule for", () => {
    const r = validate(propose([{ action: "pull_request.merge", enforcedBy: "token", resources: ["acme/api"], max: 1 }]),
      { ceiling, authority: alice });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejections[0]!.code).toBe("no-ceiling-rule");
    expect(r.rejections[0]!.message).toContain("pull_request.merge");
  });

  it("rejects a repository outside the ceiling, naming the clause and a counterexample", () => {
    const r = validate(propose([{ ...READ, resources: ["evil/api"] }]), { ceiling, authority: alice });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const rej = r.rejections[0]!;
    expect(rej.code).toBe("not-contained");
    expect(rej.clause).toBe("allow-read-any-repo");
    expect(rej.counterexample).toBeDefined();
    expect(rej.counterexample!.length).toBeGreaterThan(0);
  });

  it("rejects a branch pattern wider than the ceiling's", () => {
    expect(codes([{ ...WRITE, branches: ["**"] }])).toContain("not-contained");
    expect(codes([{ ...WRITE, branches: ["main"] }])).toContain("not-contained");
  });

  it("rejects a path pattern wider than the ceiling's deny list", () => {
    expect(codes([{ ...WRITE, denyPaths: [".github/workflows/**"] }])).toContain("not-contained");
  });

  // A product-level consequence of Cedar's `like` being character-wise rather
  // than segment-aware: a ceiling that writes `like "*.env*"` denies strictly
  // more than a glob reader expects, so the PRD's own example deny list is too
  // weak against it. The validator is right to reject, and the counterexample
  // says exactly why.
  it("rejects the PRD example's deny list against a character-wise ceiling pattern", () => {
    const r = validate(
      propose([{ ...WRITE, denyPaths: [".github/workflows/**", "**/.env*"] }]),
      { ceiling, authority: alice },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const rej = r.rejections.find((x) => x.code === "not-contained")!;
    expect(rej.counterexample).toContain(".env");
    // The witness is a path containing .env that is NOT a dotenv basename.
    expect(rej.counterexample!.endsWith(".env")).toBe(true);
    expect(rej.counterexample!.includes("/.env")).toBe(false);
  });

  // The ceiling constrains a facet; the grant is silent about it. A silent
  // grant is UNCONSTRAINED, which is wider than the ceiling -- so it must be
  // rejected rather than treated as "no facet to compare".
  it("rejects a write that omits branches while the ceiling constrains them", () => {
    const { branches: _drop, ...noBranches } = WRITE;
    expect(codes([noBranches])).toContain("not-contained");
  });

  it("rejects a PR grant that omits base while the ceiling pins it to main", () => {
    const { base: _drop, ...noBase } = PR;
    expect(codes([noBase])).toContain("not-contained");
  });

  it("rejects a write that omits paths while the ceiling denies some", () => {
    const { paths: _p, denyPaths: _d, ...noPaths } = WRITE;
    expect(codes([noPaths])).toContain("not-contained");
  });

  it("rejects a base that is not the ceiling's base", () => {
    expect(codes([{ ...PR, base: "release/1.0" }])).toContain("not-contained");
  });

  it("rejects an undecidable pattern rather than guessing", () => {
    // Bypasses the schema to simulate a hand-edited mandate reaching validate().
    const bad = { ...propose([READ]), grants: [{ ...READ, resources: ["acme/api?"] }] } as ProposedMandate;
    const r = validate(bad, { ceiling, authority: alice });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0]!.code).toBe("undecidable");
  });

  it("rejects an unknown operation", () => {
    const bad = { ...propose([READ]), grants: [{ ...READ, action: "repo.yolo" }] } as ProposedMandate;
    const r = validate(bad, { ceiling, authority: alice });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0]!.code).toBe("unknown-operation");
  });
});

describe("validate — user authority, a separate check from the ceiling", () => {
  it("rejects a code write when the user only has pull", () => {
    const bob: UserAuthority = { login: "bob", level: "pull" };
    const r = validate(propose([WRITE]), { ceiling, authority: bob });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const rej = r.rejections.find((x) => x.code === "user-authority")!;
    expect(rej.message).toContain("pull");
    expect(rej.message).toContain("push");
    expect(rej.message).toContain("bob");
  });

  it("rejects everything when the user has no access at all", () => {
    expect(codes([READ], { login: "nobody", level: "none" })).toContain("user-authority");
  });

  it("accepts a read at pull level", () => {
    expect(codes([READ], { login: "bob", level: "pull" })).toEqual([]);
  });

  it("reports ceiling and user-authority failures separately, not merged", () => {
    const got = codes([{ ...WRITE, resources: ["evil/api"] }], { login: "bob", level: "pull" });
    expect(got).toContain("not-contained");
    expect(got).toContain("user-authority");
  });

  it("does not let a higher user level widen the ceiling", () => {
    // admin still cannot exceed the org ceiling.
    expect(codes([{ action: "secrets.read", enforcedBy: "token", resources: ["acme/api"] }],
      { login: "root", level: "admin" })).toContain("no-ceiling-rule");
  });
});

describe("validate — layer agreement", () => {
  it("fails closed when the extracted rule and Cedar disagree", () => {
    // A rule whose extracted patterns claim more than the Cedar source does.
    // loadCeiling cannot produce this, so it is injected directly.
    const skewed = {
      ...ceiling,
      rules: [{
        id: "skew", action: "repo.read", resources: ["**"],
        branches: [], paths: [], denyPaths: [], base: [],
      }],
    };
    const r = validate(propose([{ ...READ, resources: ["evil/api"] }]), { ceiling: skewed, authority: alice });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections.map((x) => x.code)).toContain("layer-disagreement");
  });

  it("records what Cedar actually permitted, not only what layer 1 matched", () => {
    const r = validate(propose([WRITE]), { ceiling, authority: alice });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(proofOf(r.mandate).grantProofs[0]!.permittedBy).toEqual(["allow-agent-branch-writes"]);
  });
});

describe("validate — reporting", () => {
  it("reports every failing grant, not just the first", () => {
    const got = codes([
      { ...READ, resources: ["evil/api"] },
      { ...WRITE, branches: ["**"] },
    ]);
    expect(got.filter((c) => c === "not-contained")).toHaveLength(2);
  });

  it("carries the grant index on every grant-scoped rejection", () => {
    const r = validate(propose([READ, { ...WRITE, branches: ["**"] }]), { ceiling, authority: alice });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0]!.grantIndex).toBe(1);
  });
});
