import { describe, expect, it } from "vitest";
import { MandateSchema, markValidated, type ValidatedMandate } from "@mandate-dev/schema";
import {
  MintError, mintToken, requiredPermissions, revokeToken, targetRepositories,
  type GitHubResponse, type MintDeps,
} from "./token.js";

const validated = (grants: unknown[]): ValidatedMandate =>
  markValidated(MandateSchema.parse({
    mandate: "m", task: "t", requestedBy: "user:a", expiresInMinutes: 30,
    ceiling: "c@v1", grants, destinations: { allow: ["github.com/acme/api"] },
  }), {
    ceilingId: "c@v1", userLevel: "push",
    checkedAt: "2026-10-03T00:00:00.000Z", grantProofs: [],
  });

const WRITE_GRANT = {
  action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
  branches: ["agent/*"], paths: ["**"], denyPaths: [".github/workflows/**", "**.env**"],
};
const READ_GRANT = { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] };

/** Captured verbatim from the live endpoint. */
const GITHUB = {
  ok: (over: Record<string, unknown> = {}): GitHubResponse => ({
    status: 201,
    data: {
      token: "ghs_fake_value", expires_at: "2026-10-04T06:18:15Z",
      permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      repositories: [{ name: "api" }], repository_selection: "selected",
      ...over,
    },
  }),
  permissionNotGranted: {
    status: 422,
    data: { message: "The permissions requested are not granted to this installation." },
  } satisfies GitHubResponse,
  levelNotGranted: {
    status: 422,
    data: {
      message: "The level of access for permissions requested are not granted to this installation.",
    },
  } satisfies GitHubResponse,
  repoNotAccessible: {
    status: 422,
    data: {
      message: "There is at least one repository that does not exist or is not accessible to the parent installation.",
    },
  } satisfies GitHubResponse,
};

interface Recorded { route: string; params: Readonly<Record<string, unknown>> }

const deps = (reply: GitHubResponse, sink: Recorded[] = []): MintDeps & { calls: Recorded[] } => ({
  installationId: 167723527,
  calls: sink,
  asApp: async (route, params) => { sink.push({ route, params }); return reply; },
  asInstallation: async () => ({ status: 204, data: null }),
});

describe("requiredPermissions", () => {
  it("takes the union of the permissions the grants need", () => {
    const p = requiredPermissions(validated([
      READ_GRANT,
      { action: "issue.comment", enforcedBy: "token", resources: ["acme/api"], max: 1 },
    ]));
    expect(p).toMatchObject({ contents: "read", issues: "write" });
  });

  it("takes write when any grant on a permission needs write", () => {
    expect(requiredPermissions(validated([READ_GRANT, WRITE_GRANT])).contents).toBe("write");
  });

  it("does not downgrade a write when a later read grant shares the permission", () => {
    expect(requiredPermissions(validated([WRITE_GRANT, READ_GRANT])).contents).toBe("write");
  });

  it("never requests a permission no grant needs", () => {
    const p = requiredPermissions(validated([READ_GRANT]));
    expect(p.workflows).toBeUndefined();
    expect(p.secrets).toBeUndefined();
    expect(p.administration).toBeUndefined();
    expect(p.issues).toBeUndefined();
  });

  it("always includes metadata read, which GitHub expects alongside contents", () => {
    expect(requiredPermissions(validated([READ_GRANT])).metadata).toBe("read");
  });
});

describe("targetRepositories", () => {
  // Measured: the access_tokens route takes bare names. A full owner/name is
  // refused as "does not exist or is not accessible", which reads like a
  // permissions problem and is not one.
  it("returns bare repository names, which is what the route accepts", () => {
    expect(targetRepositories(validated([READ_GRANT])).names).toEqual(["api"]);
  });

  it("returns the owner so it can be checked rather than discarded", () => {
    expect(targetRepositories(validated([READ_GRANT])).owner).toBe("acme");
  });

  // Dropping the owner silently is the hole: `acme/api` and `other/api` both
  // reduce to `api`, and the token would be minted for whichever the
  // installation covers.
  it("refuses a mandate that spans two owners", () => {
    expect(() => targetRepositories(validated([
      READ_GRANT,
      { action: "issue.read", enforcedBy: "token", resources: ["other/api"] },
    ]))).toThrow(/cannot span owners/);
  });

  it("refuses to mint for a pattern it cannot resolve to concrete names", () => {
    expect(() => targetRepositories(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/*"] },
    ]))).toThrow(/concrete/);
  });

  it("refuses a resource that is not exactly owner/name", () => {
    expect(() => targetRepositories(validated([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api/extra"] },
    ]))).toThrow(/owner\/name/);
  });
});

describe("mintToken", () => {
  it("asks GitHub for exactly the repositories and permissions derived", async () => {
    const calls: Recorded[] = [];
    const minted = await mintToken(deps(GITHUB.ok(), calls), validated([WRITE_GRANT]));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe("POST /app/installations/{installation_id}/access_tokens");
    expect(calls[0]?.params["repositories"]).toEqual(["api"]);
    expect(calls[0]?.params["permissions"]).toMatchObject({ contents: "write", metadata: "read" });
    expect(minted.expiresAt).toBe("2026-10-04T06:18:15Z");
    expect(minted.repositories).toEqual(["api"]);
  });

  // Measured: omitting `permissions` mints a token carrying EVERY permission
  // the installation holds, so an empty set can never be sent as "no
  // preference". requiredPermissions always seeds metadata, which makes this
  // unreachable today -- it is an invariant, not an accident of that seeding.
  it("always sends a permissions field", async () => {
    const calls: Recorded[] = [];
    await mintToken(deps(GITHUB.ok(), calls), validated([READ_GRANT]));
    expect(calls[0]?.params["permissions"]).toBeDefined();
    expect(Object.keys(calls[0]?.params["permissions"] as object).length).toBeGreaterThan(0);
  });

  it("fingerprints rather than exposes the token", async () => {
    const minted = await mintToken(deps(GITHUB.ok({ token: "ghs_secret_value" })), validated([READ_GRANT]));
    expect(minted.fingerprint).toHaveLength(12);
    expect(minted.fingerprint).not.toContain("secret");
  });

  // A MintedToken is the sort of object that lands in a log line or an error
  // payload, and the secrets rule is that a token appears only as a fingerprint.
  it("redacts the token when serialised", async () => {
    const minted = await mintToken(deps(GITHUB.ok({ token: "ghs_secret_value" })), validated([READ_GRANT]));
    const dumped = JSON.stringify(minted);
    expect(dumped).not.toContain("ghs_secret_value");
    expect(dumped).toContain("[redacted]");
    expect(dumped).toContain(minted.fingerprint);
    // The real value is still reachable for the one caller that needs it.
    expect(minted.token).toBe("ghs_secret_value");
  });

  // This task's premise was that GitHub silently drops permissions the
  // installation lacks. Measured against the live endpoint, it does not: it
  // refuses with 422, and distinguishes a missing permission from an
  // insufficient level. The job is to surface its wording.
  it("surfaces GitHub's refusal when the installation lacks a permission", async () => {
    await expect(mintToken(deps(GITHUB.permissionNotGranted), validated([WRITE_GRANT])))
      .rejects.toThrow(/The permissions requested are not granted to this installation/);
  });

  it("surfaces GitHub's refusal when the installation grants a lower level", async () => {
    await expect(mintToken(deps(GITHUB.levelNotGranted), validated([WRITE_GRANT])))
      .rejects.toThrow(/The level of access for permissions requested/);
  });

  it("surfaces GitHub's refusal when a repository is outside the installation", async () => {
    await expect(mintToken(deps(GITHUB.repoNotAccessible), validated([READ_GRANT])))
      .rejects.toThrow(/does not exist or is not accessible/);
  });

  it("names what it asked for in a refusal, so the fix is obvious", async () => {
    await expect(mintToken(deps(GITHUB.permissionNotGranted), validated([WRITE_GRANT])))
      .rejects.toThrow(/contents.*write/);
  });

  // Unreachable against today's API, kept because it is the difference between
  // fail-closed and fail-open if that behaviour ever changes.
  it("still fails closed if a token ever comes back narrower than requested", async () => {
    const narrowed = GITHUB.ok({ permissions: { metadata: "read" } });
    await expect(mintToken(deps(narrowed), validated([WRITE_GRANT])))
      .rejects.toThrow(/did not grant contents:write/);
  });

  it("refuses a 201 whose body carries no usable token", async () => {
    await expect(mintToken(deps({ status: 201, data: { expires_at: "x" } }), validated([READ_GRANT])))
      .rejects.toThrow(MintError);
  });

  it("refuses a 201 whose token is an empty string", async () => {
    await expect(mintToken(deps(GITHUB.ok({ token: "" })), validated([READ_GRANT])))
      .rejects.toThrow(/cannot use/);
  });
});

describe("revokeToken", () => {
  it("deletes the installation token with the token itself", async () => {
    const seen: { route: string; token: string }[] = [];
    await revokeToken({
      installationId: 1,
      asApp: async () => ({ status: 500, data: null }),
      asInstallation: async (route, token) => { seen.push({ route, token }); return { status: 204, data: null }; },
    }, "ghs_x");
    expect(seen).toEqual([{ route: "DELETE /installation/token", token: "ghs_x" }]);
  });

  it("reports a refusal by fingerprint, never by value", async () => {
    const failing: MintDeps = {
      installationId: 1,
      asApp: async () => ({ status: 500, data: null }),
      asInstallation: async () => ({ status: 403, data: { message: "Bad credentials" } }),
    };
    await expect(revokeToken(failing, "ghs_secret_value")).rejects.toThrow(/Bad credentials/);
    await expect(revokeToken(failing, "ghs_secret_value")).rejects.not.toThrow(/ghs_secret_value/);
  });
});
