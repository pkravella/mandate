import { describe, expect, it } from "vitest";
import { pauseRecord, widenRefusal } from "./pause.js";
import type { Decision } from "./proxy.js";

const deny = (clause: string, reason = "because"): Extract<Decision, { kind: "deny" }> =>
  ({ kind: "deny", tool: "create_or_update_file", clause, reason });

const record = (clause: string, observed: Record<string, string> = {}) =>
  pauseRecord({
    mandateId: "fix-issue-42",
    decision: deny(clause),
    observed,
    now: new Date("2026-10-04T05:00:00.000Z"),
  });

describe("pauseRecord", () => {
  it("names the clause and the reason it hit (R10)", () => {
    const r = record("contents.write.branches", { branch: "main" });
    expect(r.clause).toBe("contents.write.branches");
    expect(r.reason).toBe("because");
    expect(r.mandateId).toBe("fix-issue-42");
    expect(r.at).toBe("2026-10-04T05:00:00.000Z");
  });

  it("proposes the narrowest branch that would have let the call through", () => {
    const r = record("contents.write.branches", { branch: "hotfix/urgent" });
    expect(r.widenRequest?.action).toBe("contents.write");
    expect(r.widenRequest?.addGrant.branches).toEqual(["hotfix/urgent"]);
    // Not a wildcard, and not the whole repository.
    expect(JSON.stringify(r.widenRequest?.addGrant)).not.toContain("**");
  });

  it("proposes one more call when the count was the limit", () => {
    expect(record("pull_request.create.max", { max: "1" }).widenRequest?.addGrant.max).toBe(2);
  });

  it("proposes the observed path, the repository and the base for their clauses", () => {
    expect(record("contents.write.paths", { path: "docs/a.md" }).widenRequest?.addGrant.paths)
      .toEqual(["docs/a.md"]);
    expect(record("repo.read.resources", { repo: "acme/web" }).widenRequest?.addGrant.resources)
      .toEqual(["acme/web"]);
    expect(record("pull_request.create.base", { base: "develop" }).widenRequest?.addGrant.base)
      .toBe("develop");
  });

  it("carries the action so the request names which grant to widen", () => {
    expect(record("pull_request.create.base", { base: "develop" }).widenRequest?.addGrant.action)
      .toBe("pull_request.create");
  });

  // A one-click "add .github/workflows/** to your paths" would make the deny
  // list decorative, which is the opposite of what it is for.
  it("offers no widen request for a deny-path denial", () => {
    const r = record("contents.write.denyPaths", { path: ".github/workflows/ci.yml" });
    expect(r.widenRequest).toBeUndefined();
    expect(widenRefusal("contents.write.denyPaths")).toContain("ceiling change");
  });

  // A widen request has to be something `mandate widen` will read, and the
  // request format validates its patterns as globs. `pages/[id].tsx` is how
  // Next.js names a dynamic route, so an observed path can legitimately be
  // unrepresentable as a pattern — and an offer the CLI would refuse to parse
  // is worse than no offer, because it looks actionable.
  it("offers no widen request when the observed value is not a usable pattern", () => {
    const r = record("contents.write.paths", { path: "pages/[id].tsx" });
    expect(r.widenRequest).toBeUndefined();
    // Still a pause with a clause and a reason: the call was refused, and R10
    // requires that much whether or not a widen is on offer.
    expect(r.clause).toBe("contents.write.paths");
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it("still offers a widen for an ordinary path", () => {
    expect(record("contents.write.paths", { path: "tests/a.ts" }).widenRequest?.addGrant.paths)
      .toEqual(["tests/a.ts"]);
  });

  it("offers no widen request for an expired mandate", () => {
    expect(record("mandate.expiry").widenRequest).toBeUndefined();
    expect(widenRefusal("mandate.expiry")).toContain("new mandate");
  });

  it("offers no widen request for an operation that is not granted at all", () => {
    expect(record("mandate.grants").widenRequest).toBeUndefined();
  });

  it("offers no widen request for a disallowed destination", () => {
    const r = record("destinations.allow", { url: "evil.example.com" });
    expect(r.widenRequest).toBeUndefined();
    expect(widenRefusal("destinations.allow")).toContain("where data may go");
  });

  it("offers no widen request for an internal failure", () => {
    expect(record("mandate.internal").widenRequest).toBeUndefined();
  });

  // An empty delta looks actionable and is not: the reviewer clicks approve and
  // nothing changes.
  it("offers no widen request when it has nothing concrete to propose", () => {
    expect(record("contents.write.branches", {}).widenRequest).toBeUndefined();
    expect(record("contents.write.paths", { path: "" }).widenRequest).toBeUndefined();
  });

  it("keeps what it observed, so the record is auditable", () => {
    expect(record("contents.write.branches", { branch: "main", repo: "acme/api" }).observed)
      .toEqual({ branch: "main", repo: "acme/api" });
  });

  it("survives a malformed max without proposing NaN", () => {
    expect(record("pull_request.create.max", { max: "lots" }).widenRequest?.addGrant.max).toBe(1);
  });
});
