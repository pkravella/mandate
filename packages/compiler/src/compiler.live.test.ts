import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MandateSchema, markValidated, type ValidatedMandate } from "@mandate-dev/schema";
import { githubAppDeps } from "./githubApp.js";
import { MintError, mintToken, requiredPermissions, revokeToken } from "./token.js";

// Against the real GitHub App. No model spend, but it mints real credentials
// for a real repository, so it is gated on an explicit opt-in as well as on
// the app's details being configured.
//
//   MANDATE_LIVE=1 pnpm --filter @mandate-dev/compiler test
const env = (name: string): string | undefined => process.env[name];
const live = env("MANDATE_LIVE") === "1"
  && env("MANDATE_APP_ID") !== undefined
  && env("MANDATE_INSTALLATION_ID") !== undefined
  && env("MANDATE_APP_KEY_PATH") !== undefined
  && env("MANDATE_TEST_REPO") !== undefined;

const deps = (): ReturnType<typeof githubAppDeps> => githubAppDeps({
  appId: env("MANDATE_APP_ID") ?? "",
  installationId: Number(env("MANDATE_INSTALLATION_ID") ?? "0"),
  privateKeyPath: env("MANDATE_APP_KEY_PATH") ?? "",
});

const repo = (): string => env("MANDATE_TEST_REPO") ?? "";

const AppSchema = z.object({ permissions: z.record(z.string(), z.string()) });

const validated = (grants: unknown[]): ValidatedMandate =>
  markValidated(MandateSchema.parse({
    mandate: "live-probe", task: "mint a token", requestedBy: "user:pkravella",
    expiresInMinutes: 30, ceiling: "sandbox@v1", grants,
    destinations: { allow: [`github.com/${repo()}`] },
  }), {
    ceilingId: "sandbox@v1", ceilingSha256: "0".repeat(64), userLevel: "push",
    checkedAt: new Date().toISOString(), grantProofs: [],
  });

const writeGrant = (): unknown => ({
  action: "contents.write", enforcedBy: "proxy", resources: [repo()],
  branches: ["agent/**"], paths: ["**"],
  denyPaths: [".github/workflows/**", "**.env**"],
});

describe.skipIf(!live)("minting against the real GitHub App", () => {
  it("mints a token scoped to the mandate's repository and permissions", async () => {
    const d = deps();
    const m = validated([writeGrant()]);
    const minted = await mintToken(d, m);
    try {
      expect(minted.repositories).toEqual([repo().split("/")[1]]);
      expect(minted.permissions).toMatchObject({ contents: "write", metadata: "read" });
      // The installation also holds issues:write. The mandate did not ask for
      // it, so the token must not carry it.
      expect(minted.permissions.issues).toBeUndefined();
      expect(minted.fingerprint).toHaveLength(12);

      // GitHub's hard one-hour cap, which is Decision D5's whole reason.
      const lifetimeMinutes = (Date.parse(minted.expiresAt) - Date.now()) / 60_000;
      expect(lifetimeMinutes).toBeGreaterThan(50);
      expect(lifetimeMinutes).toBeLessThanOrEqual(61);

      // The token works, and only where it should.
      const ok = await d.asInstallation("GET /installation/repositories", minted.token);
      expect(ok.status).toBe(200);
    } finally {
      await revokeToken(d, minted.token);
    }
  }, 60_000);

  // This task's premise was that GitHub silently drops permissions the
  // installation lacks. It does not: the app deliberately has no `actions`
  // permission, and asking for it is refused outright.
  it("is refused when the mandate needs a permission the installation lacks", async () => {
    const m = validated([
      writeGrant(),
      { action: "actions.read", enforcedBy: "token", resources: [repo()] },
    ]);
    expect(requiredPermissions(m).actions).toBe("read");
    await expect(mintToken(deps(), m)).rejects.toThrow(MintError);
    await expect(mintToken(deps(), m))
      .rejects.toThrow(/not granted to this installation/);
  }, 60_000);

  it("is refused for a repository outside the installation", async () => {
    const [owner] = repo().split("/");
    const m = validated([
      { action: "repo.read", enforcedBy: "token", resources: [`${owner ?? "x"}/definitely-not-installed`] },
    ]);
    await expect(mintToken(deps(), m)).rejects.toThrow(/does not exist or is not accessible/);
  }, 60_000);

  // Measured: DELETE /installation/token answers 204 immediately, but the
  // token kept working for two to four seconds. Revocation is real and not
  // instant, which is why the mandate's lifetime rests on the proxy refusing
  // calls past expiresAt rather than on the credential dying.
  it("revokes a token, with a propagation window", async () => {
    const d = deps();
    const minted = await mintToken(d, validated([writeGrant()]));
    const read = async (): Promise<number> =>
      (await d.asInstallation("GET /repos/{owner}/{repo}/contents/README.md", minted.token, {
        owner: repo().split("/")[0] ?? "", repo: repo().split("/")[1] ?? "",
      })).status;

    expect(await read()).toBe(200);
    await revokeToken(d, minted.token);

    let status = 200;
    const started = Date.now();
    while (status === 200 && Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 2000));
      status = await read();
    }
    expect(status).toBe(401);
    console.log(`revocation took effect after ~${((Date.now() - started) / 1000).toFixed(0)}s`);
  }, 60_000);
});

// Keeps the fixture honest: the live tests above assume this exact setup.
describe.skipIf(!live)("the app the live tests assume", () => {
  it("holds contents, issues and pull_requests but deliberately not actions", async () => {
    const res = await deps().asApp("GET /app", {});
    expect(res.status).toBe(200);
    const body = AppSchema.parse(res.data);
    expect(body.permissions).toMatchObject({
      contents: "write", issues: "write", metadata: "read", pull_requests: "write",
    });
    // An installation missing a permission the mandate asks for is how the
    // refusal path above is exercised against the real API.
    expect(body.permissions["actions"]).toBeUndefined();
  }, 30_000);
});
