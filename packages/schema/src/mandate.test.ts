import { describe, expect, it } from "vitest";
import { MandateSchema, parseMandateYaml, markValidated, unwrap, proofOf } from "./index.js";

const valid = {
  mandate: "fix-issue-42",
  task: "Fix issue #42 and open a PR",
  requestedBy: "user:alice",
  expiresInMinutes: 60,
  ceiling: "org-policy@v12",
  grants: [
    { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    { action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"], branches: ["agent/42-*"] },
    { action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], paths: ["**"], denyPaths: [".github/workflows/**", "**/.env*"] },
    { action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], base: "main", max: 1 },
  ],
  destinations: { allow: ["github.com/acme/api"] },
};

const proof = {
  ceilingId: "org-policy@v12", ceilingSha256: "0".repeat(64),
  userLevel: "push",
  checkedAt: "2026-10-04T00:00:00.000Z",
  grantProofs: [],
};

describe("MandateSchema", () => {
  it("accepts the PRD's example mandate", () => {
    const r = MandateSchema.safeParse(valid);
    expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(true);
  });

  it("rejects an unknown action", () => {
    const bad = { ...valid, grants: [{ action: "repo.yolo", enforcedBy: "token", resources: ["acme/api"] }] };
    const r = MandateSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("repo.yolo");
  });

  it("caps expiry at 60 minutes because GitHub tokens cannot outlive an hour", () => {
    expect(MandateSchema.safeParse({ ...valid, expiresInMinutes: 120 }).success).toBe(false);
    expect(MandateSchema.safeParse({ ...valid, expiresInMinutes: 60 }).success).toBe(true);
  });

  it("requires a positive integer expiry", () => {
    expect(MandateSchema.safeParse({ ...valid, expiresInMinutes: 0 }).success).toBe(false);
    expect(MandateSchema.safeParse({ ...valid, expiresInMinutes: -5 }).success).toBe(false);
    expect(MandateSchema.safeParse({ ...valid, expiresInMinutes: 1.5 }).success).toBe(false);
  });

  it("requires at least one grant and at least one resource per grant", () => {
    expect(MandateSchema.safeParse({ ...valid, grants: [] }).success).toBe(false);
    const noRes = { ...valid, grants: [{ action: "repo.read", enforcedBy: "token", resources: [] }] };
    expect(MandateSchema.safeParse(noRes).success).toBe(false);
  });

  it("rejects a constraint the catalog says the operation cannot carry", () => {
    // notifications.read is constrainable by nothing, so `branches` is meaningless.
    const bad = {
      ...valid,
      grants: [{ action: "notifications.read", enforcedBy: "token", resources: ["*"], branches: ["main"] }],
    };
    const r = MandateSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("branches");
  });

  it("rejects notGrantedNotable on input because it is derived for display only", () => {
    const bad = { ...valid, notGrantedNotable: ["pull_request.merge"] };
    expect(MandateSchema.safeParse(bad).success).toBe(false);
  });

  it("requires requestedBy to name an authorized principal, never an agent", () => {
    for (const p of ["agent:claude-code", "agent:codex", "bot:x", "admin", "alice"]) {
      expect(MandateSchema.safeParse({ ...valid, requestedBy: p }).success, p).toBe(false);
    }
    expect(MandateSchema.safeParse({ ...valid, requestedBy: "user:alice" }).success).toBe(true);
    expect(MandateSchema.safeParse({ ...valid, requestedBy: "app:ci-bot" }).success).toBe(true);
  });

  it("requires a destinations allow list", () => {
    const { destinations: _omit, ...noDest } = valid;
    expect(MandateSchema.safeParse(noDest).success).toBe(false);
  });

  it("rejects glob metacharacters it cannot decide", () => {
    for (const pattern of ["acme/api?", "acme/[ab]", "acme/{a,b}", "!acme/api", "acme/a***b"]) {
      const bad = { ...valid, grants: [{ action: "repo.read", enforcedBy: "token", resources: [pattern] }] };
      expect(MandateSchema.safeParse(bad).success, pattern).toBe(false);
    }
  });

  it("rejects path traversal in a pattern", () => {
    const bad = {
      ...valid,
      grants: [{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
        branches: ["agent/42-*"], paths: ["src/../.github/workflows/ci.yml"] }],
    };
    expect(MandateSchema.safeParse(bad).success).toBe(false);
  });

  it("parses YAML into a ProposedMandate", () => {
    const yaml = `
mandate: fix-issue-42
task: "Fix issue #42 and open a PR"
requestedBy: user:alice
expiresInMinutes: 60
ceiling: org-policy@v12
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["acme/api"]
destinations:
  allow: ["github.com/acme/api"]
`;
    expect(parseMandateYaml(yaml).mandate).toBe("fix-issue-42");
  });

  it("throws rather than returning a partial mandate on bad YAML", () => {
    expect(() => parseMandateYaml("mandate: [unclosed")).toThrow();
    expect(() => parseMandateYaml("mandate: x")).toThrow();
  });
});

describe("ValidatedMandate", () => {
  it("round-trips through markValidated and unwrap", () => {
    const m = MandateSchema.parse(valid);
    const v = markValidated(m, proof);
    expect(unwrap(v).mandate).toBe("fix-issue-42");
    expect(unwrap(v).grants).toHaveLength(4);
  });

  it("carries the proof, retrievable only through proofOf", () => {
    const v = markValidated(MandateSchema.parse(valid), proof);
    expect(proofOf(v).ceilingId).toBe("org-policy@v12");
    expect(proofOf(v).userLevel).toBe("push");
  });

  // The brand must be a real runtime symbol. A `declare const unique symbol`
  // type-checks but emits a reference to a binding that does not exist, so
  // markValidated would throw ReferenceError at runtime while compiling clean.
  it("is constructed at runtime without throwing", () => {
    expect(() => markValidated(MandateSchema.parse(valid), proof)).not.toThrow();
  });

  it("is frozen, so a holder cannot widen it in place", () => {
    const v = markValidated(MandateSchema.parse(valid), proof);
    expect(Object.isFrozen(v)).toBe(true);
    expect(() => {
      (v as unknown as { expiresInMinutes: number }).expiresInMinutes = 600;
    }).toThrow(TypeError);
  });

  it("does not leak the brand into JSON, so the hash is unaffected", () => {
    const m = MandateSchema.parse(valid);
    const v = markValidated(m, proof);
    expect(JSON.parse(JSON.stringify(v))).toEqual(JSON.parse(JSON.stringify(m)));
  });

  it("unwrap returns a plain object with no brand", () => {
    const v = markValidated(MandateSchema.parse(valid), proof);
    const plain = unwrap(v);
    expect(Object.getOwnPropertySymbols(plain)).toHaveLength(0);
  });
});
