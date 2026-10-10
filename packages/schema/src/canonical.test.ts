import { describe, expect, it } from "vitest";
import { MandateSchema, canonicalize, mandateHash, markValidated } from "./index.js";

const base = {
  mandate: "m", task: "t", requestedBy: "user:a", expiresInMinutes: 30,
  ceiling: "c@v1",
  grants: [
    { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    { action: "issue.read", enforcedBy: "token", resources: ["acme/api"] },
  ],
  destinations: { allow: ["github.com/acme/api"] },
};

describe("canonicalize", () => {
  it("is insensitive to grant order", () => {
    const a = MandateSchema.parse(base);
    const b = MandateSchema.parse({ ...base, grants: [...base.grants].reverse() });
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(mandateHash(a)).toBe(mandateHash(b));
  });

  it("is insensitive to key order", () => {
    const a = MandateSchema.parse(base);
    const b = MandateSchema.parse({
      destinations: base.destinations, grants: base.grants, ceiling: base.ceiling,
      expiresInMinutes: base.expiresInMinutes, requestedBy: base.requestedBy,
      task: base.task, mandate: base.mandate,
    });
    expect(mandateHash(a)).toBe(mandateHash(b));
  });

  it("changes when authority changes", () => {
    const a = MandateSchema.parse(base);
    const b = MandateSchema.parse({
      ...base,
      grants: [...base.grants, { action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"] }],
    });
    expect(mandateHash(a)).not.toBe(mandateHash(b));
  });

  it("changes when a constraint is loosened", () => {
    const tight = MandateSchema.parse({ ...base, grants: [
      { action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
        branches: ["agent/42-*"], paths: ["src/**"] }] });
    const loose = MandateSchema.parse({ ...base, grants: [
      { action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
        branches: ["agent/42-*"], paths: ["**"] }] });
    expect(mandateHash(tight)).not.toBe(mandateHash(loose));
  });

  it("changes when expiry changes, so an approval cannot be replayed for longer", () => {
    const a = MandateSchema.parse({ ...base, expiresInMinutes: 30 });
    const b = MandateSchema.parse({ ...base, expiresInMinutes: 60 });
    expect(mandateHash(a)).not.toBe(mandateHash(b));
  });

  it("produces a stable 64-char hex digest", () => {
    expect(mandateHash(MandateSchema.parse(base))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a validated mandate identically to its plain form", () => {
    // The approval cache keys on the hash, so branding must not change it.
    const m = MandateSchema.parse(base);
    const v = markValidated(m, {
      ceilingId: "c@v1", ceilingSha256: "0".repeat(64), userLevel: "push",
      checkedAt: "2026-10-04T00:00:00.000Z", grantProofs: [],
    });
    expect(mandateHash(v)).toBe(mandateHash(m));
  });
});
