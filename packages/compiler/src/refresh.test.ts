import { describe, expect, it, vi } from "vitest";
import { TokenRefresher } from "./refresh.js";
import type { MintDeps, MintedToken } from "./token.js";

const minted = (n: number, minutesFromNow: number): MintedToken => {
  const expiresAt = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
  return {
    token: `ghs_${n}`, expiresAt, repositories: ["api"], permissions: {},
    fingerprint: `fp${n}`.padEnd(12, "0"),
    toJSON: () => ({ token: "[redacted]", fingerprint: `fp${n}`.padEnd(12, "0"), expiresAt }),
  };
};

/** Records the tokens revocation was asked to destroy. */
const revoking = (): MintDeps & { revoked: string[] } => {
  const revoked: string[] = [];
  return {
    installationId: 1,
    revoked,
    asApp: async () => ({ status: 500, data: null }),
    asInstallation: async (_route, token) => { revoked.push(token); return { status: 204, data: null }; },
  };
};

describe("TokenRefresher", () => {
  it("mints once and reuses while the token is fresh", async () => {
    const mint = vi.fn<() => Promise<MintedToken>>().mockResolvedValue(minted(1, 60));
    const r = new TokenRefresher(mint, { refreshAtMinutesRemaining: 10 });
    expect((await r.current()).token).toBe("ghs_1");
    expect((await r.current()).token).toBe("ghs_1");
    expect(mint).toHaveBeenCalledTimes(1);
    await r.stop();
  });

  it("re-mints when fewer than the configured minutes remain (D5)", async () => {
    const mint = vi.fn<() => Promise<MintedToken>>()
      .mockResolvedValueOnce(minted(1, 5))
      .mockResolvedValueOnce(minted(2, 60));
    const r = new TokenRefresher(mint, { refreshAtMinutesRemaining: 10 });
    expect((await r.current()).token).toBe("ghs_1");
    expect((await r.current()).token).toBe("ghs_2");
    expect(mint).toHaveBeenCalledTimes(2);
    await r.stop();
  });

  it("treats an unparseable expiry as expired rather than trusting it", async () => {
    const bad = { ...minted(1, 60), expiresAt: "not a date" };
    const mint = vi.fn<() => Promise<MintedToken>>()
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(minted(2, 60));
    const r = new TokenRefresher(mint, { refreshAtMinutesRemaining: 10 });
    await r.current();
    expect((await r.current()).token).toBe("ghs_2");
    await r.stop();
  });

  it("does not mint again after stop()", async () => {
    const mint = vi.fn<() => Promise<MintedToken>>().mockResolvedValue(minted(1, 5));
    const r = new TokenRefresher(mint, { refreshAtMinutesRemaining: 10 });
    await r.current();
    await r.stop();
    await expect(r.current()).rejects.toThrow(/stopped/);
  });

  it("coalesces concurrent refreshes into one mint", async () => {
    let resolve!: (v: MintedToken) => void;
    const mint = vi.fn<() => Promise<MintedToken>>()
      .mockImplementation(() => new Promise<MintedToken>((r) => { resolve = r; }));
    const r = new TokenRefresher(mint, { refreshAtMinutesRemaining: 10 });
    const a = r.current();
    const b = r.current();
    resolve(minted(1, 60));
    await Promise.all([a, b]);
    expect(mint).toHaveBeenCalledTimes(1);
    await r.stop();
  });

  // PRD lifecycle step 8: the token is revoked. The plan's stop() only dropped
  // the cache, leaving a live credential valid for up to an hour.
  it("revokes the token it is holding when it stops", async () => {
    const deps = revoking();
    const r = new TokenRefresher(() => Promise.resolve(minted(1, 60)), { deps });
    await r.current();
    await r.stop();
    expect(deps.revoked).toEqual(["ghs_1"]);
  });

  it("revokes the token it replaces, so a run never holds two live credentials", async () => {
    const deps = revoking();
    const mint = vi.fn<() => Promise<MintedToken>>()
      .mockResolvedValueOnce(minted(1, 5))
      .mockResolvedValueOnce(minted(2, 60));
    const r = new TokenRefresher(mint, { refreshAtMinutesRemaining: 10, deps });
    await r.current();
    await r.current();
    expect(deps.revoked).toEqual(["ghs_1"]);
    await r.stop();
    expect(deps.revoked).toEqual(["ghs_1", "ghs_2"]);
  });

  it("is safe to stop twice", async () => {
    const deps = revoking();
    const r = new TokenRefresher(() => Promise.resolve(minted(1, 60)), { deps });
    await r.current();
    await r.stop();
    await r.stop();
    expect(deps.revoked).toEqual(["ghs_1"]);
  });

  // A failed revoke must not take the run down: the token expires on its own
  // within the hour, and the proxy stops honouring the mandate before that.
  it("does not fail stop() when revocation is refused", async () => {
    const r = new TokenRefresher(() => Promise.resolve(minted(1, 60)), {
      deps: {
        installationId: 1,
        asApp: async () => ({ status: 500, data: null }),
        asInstallation: async () => ({ status: 403, data: { message: "Bad credentials" } }),
      },
    });
    await r.current();
    await expect(r.stop()).resolves.toBeUndefined();
  });

  // Handing back a token after the caller asked to stop is the opposite of
  // what stopping means, and the token must not be left live either.
  it("revokes and refuses a token that arrives after stop()", async () => {
    const deps = revoking();
    let resolve!: (v: MintedToken) => void;
    const r = new TokenRefresher(
      () => new Promise<MintedToken>((res) => { resolve = res; }),
      { deps },
    );
    const pending = r.current();
    await r.stop();
    resolve(minted(1, 60));
    await expect(pending).rejects.toThrow(/stopped/);
    expect(deps.revoked).toEqual(["ghs_1"]);
  });

  it("retries after a failed mint rather than caching the failure", async () => {
    const mint = vi.fn<() => Promise<MintedToken>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(minted(2, 60));
    const r = new TokenRefresher(mint, {});
    await expect(r.current()).rejects.toThrow("network");
    expect((await r.current()).token).toBe("ghs_2");
    await r.stop();
  });
});
