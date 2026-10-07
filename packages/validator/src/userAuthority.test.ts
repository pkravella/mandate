import { describe, expect, it } from "vitest";
import { fetchUserAuthority, type OctokitLike } from "./userAuthority.js";

/**
 * `fetchUserAuthority` had no tests at all, despite the Phase 3 handoff
 * recording it as "exists and is tested" and a comment in the live e2e test
 * asserting "fetchUserAuthority has its own tests". It is the function that
 * decides whether the requester is allowed to ask for what the mandate grants
 * — D2's whole user-authority half — so it gets the response shapes GitHub
 * actually returns, not the one that would be convenient.
 *
 * The shape is the bug. `GET /repos/{owner}/{repo}/collaborators/{username}/permission`
 * documents `permission` as the LEGACY vocabulary — `admin | write | read | none`
 * — while `UserLevel` is `none | pull | triage | push | maintain | admin`. An
 * exact-string match against `permission` therefore resolves a real
 * collaborator with write access to `none`, which denies every grant. It fails
 * closed, so it is not a breach; it would simply have meant that wiring in the
 * one function that closes the trust story made the product reject everything.
 *
 * `role_name` is the field carrying the fine-grained role, including `triage`
 * and `maintain` — and, for an organization with custom repository roles, a
 * name that is in no vocabulary at all.
 */
const replying = (data: unknown): OctokitLike => ({
  request: async () => ({ data }),
});

const throwing = (): OctokitLike => ({
  request: async () => { throw new Error("network"); },
});

describe("fetchUserAuthority — the legacy permission vocabulary", () => {
  // The four values `permission` is documented to take. Three of them are not
  // UserLevel strings, and the mapping is the whole point of this test.
  it.each([
    ["admin", "admin"],
    ["write", "push"],
    ["read", "pull"],
    ["none", "none"],
  ])("maps permission %s to level %s", async (permission, expected) => {
    const got = await fetchUserAuthority(replying({ permission }), "acme/api", "alice");
    expect(got).toEqual({ login: "alice", level: expected });
  });
});

describe("fetchUserAuthority — the fine-grained role", () => {
  // These two exist only in `role_name`. Without reading it, a user with triage
  // is indistinguishable from one with read, and `maintain` from `write` — so
  // every operation whose minUserLevel is `triage` or `maintain` would be
  // decided against the wrong level.
  it.each([
    ["triage", "triage"],
    ["maintain", "maintain"],
    ["admin", "admin"],
    ["push", "push"],
    ["pull", "pull"],
  ])("reads role_name %s as level %s", async (roleName, expected) => {
    const got = await fetchUserAuthority(
      // `permission` is coarser here, which is exactly the real response: a
      // maintainer's legacy permission is "write". Taking the coarser field
      // when the finer one is present would under-report authority.
      replying({ permission: "write", role_name: roleName }), "acme/api", "alice",
    );
    expect(got).toEqual({ login: "alice", level: expected });
  });

  it("prefers role_name over permission when they disagree", async () => {
    const got = await fetchUserAuthority(
      replying({ permission: "write", role_name: "maintain" }), "acme/api", "alice",
    );
    expect(got.level).toBe("maintain");
  });

  /**
   * An organization with custom repository roles returns the custom role's name
   * here, which is in no vocabulary. Falling back to `permission` is right: the
   * custom role's base permission is what the legacy field reports, so the
   * answer is the closest level GitHub can express rather than `none`.
   *
   * Resolving `none` instead would be safe but wrong in a way that looks like a
   * Mandate bug to anyone using custom roles — every mandate rejected, with a
   * message saying they have no access to a repository they can push to.
   */
  it("falls back to permission for a custom role name", async () => {
    const got = await fetchUserAuthority(
      replying({ permission: "write", role_name: "security-reviewer" }),
      "acme/api", "alice",
    );
    expect(got.level).toBe("push");
  });
});

describe("fetchUserAuthority — failing closed", () => {
  it("resolves none when the request throws", async () => {
    // A 404 because the user cannot see the repository, or an outage. Guessing
    // higher on an error turns an outage into an over-grant.
    const got = await fetchUserAuthority(throwing(), "acme/api", "alice");
    expect(got).toEqual({ login: "alice", level: "none" });
  });

  it.each([
    ["an unrecognised permission", { permission: "superuser" }],
    ["neither field", { user: { login: "alice" } }],
    ["a null permission", { permission: null }],
    ["a numeric permission", { permission: 7 }],
    ["an empty object", {}],
    ["a string body", "write"],
    ["a null body", null],
    ["an array body", [{ permission: "admin" }]],
  ])("resolves none for %s", async (_label, data) => {
    const got = await fetchUserAuthority(replying(data), "acme/api", "alice");
    expect(got.level).toBe("none");
  });

  it.each([
    ["an empty repo", ""],
    ["no owner", "/api"],
    ["no name", "acme/"],
    ["no separator", "acme"],
  ])("resolves none for %s without calling GitHub at all", async (_label, repo) => {
    let called = false;
    const octokit: OctokitLike = {
      request: async () => { called = true; return { data: { permission: "admin" } }; },
    };
    const got = await fetchUserAuthority(octokit, repo, "alice");
    expect(got.level).toBe("none");
    expect(called, "a malformed repository must not reach the API").toBe(false);
  });

  /**
   * The route carries the login as a path parameter. A login containing a slash
   * would address a different endpoint entirely, so it is refused before the
   * request rather than encoded and hoped for.
   */
  it("resolves none for a login that could alter the route", async () => {
    let called = false;
    const octokit: OctokitLike = {
      request: async () => { called = true; return { data: { permission: "admin" } }; },
    };
    for (const login of ["alice/../../admin", "", "alice?x=1", "a/b"]) {
      const got = await fetchUserAuthority(octokit, "acme/api", login);
      expect(got.level, login).toBe("none");
    }
    expect(called).toBe(false);
  });
});

describe("fetchUserAuthority — what it sends", () => {
  it("asks for the permission of exactly the repository and login given", async () => {
    const seen: { route?: string; params?: Record<string, unknown> } = {};
    const octokit: OctokitLike = {
      request: async (route, params) => {
        seen.route = route;
        seen.params = params as Record<string, unknown>;
        return { data: { permission: "write" } };
      },
    };
    await fetchUserAuthority(octokit, "acme/api", "alice");
    expect(seen.route).toBe("GET /repos/{owner}/{repo}/collaborators/{username}/permission");
    expect(seen.params).toEqual({ owner: "acme", repo: "api", username: "alice" });
  });
});
