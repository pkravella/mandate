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
