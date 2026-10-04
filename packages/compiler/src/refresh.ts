import { revokeToken, type MintDeps, type MintedToken } from "./token.js";

export interface RefreshOptions {
  /** Re-mint when this many minutes or fewer remain. Default 10. */
  readonly refreshAtMinutesRemaining?: number;
  /**
   * Revoke the token when the refresher stops, and whenever a fresh one
   * replaces it. Needs `deps`. Default true when `deps` is given.
   */
  readonly deps?: MintDeps;
}

/**
 * Decision D5: two independent clocks. A mandate may outlive a GitHub
 * installation token, which is capped at one hour and cannot be extended, so
 * the refresher re-mints while the mandate is still live.
 *
 * Refreshing can never extend authority. The proxy refuses every call past the
 * mandate's own `expiresAt`, and that is the control the mandate's lifetime
 * rests on — not revocation, which is measurably *eventually consistent*
 * (`DELETE /installation/token` answers 204 but the token kept working for two
 * to four seconds afterwards). Revocation shortens the window in which a
 * leaked token is useful; it does not define the authority's end.
 */
export class TokenRefresher {
  #cached: MintedToken | undefined;
  #inFlight: Promise<MintedToken> | undefined;
  #stopped = false;
  readonly #threshold: number;
  readonly #deps: MintDeps | undefined;

  constructor(
    private readonly mint: () => Promise<MintedToken>,
    opts: RefreshOptions = {},
  ) {
    this.#threshold = (opts.refreshAtMinutesRemaining ?? 10) * 60_000;
    this.#deps = opts.deps;
  }

  async current(): Promise<MintedToken> {
    if (this.#stopped) throw new Error("TokenRefresher is stopped");
    const cached = this.#cached;
    if (cached !== undefined && !this.#isStale(cached)) return cached;

    this.#inFlight ??= this.mint()
      .then(async (fresh) => {
        // Replacing a live token leaves the old one valid for its full hour
        // unless it is revoked, which is a second usable credential for no
        // reason.
        const previous = this.#cached;
        this.#cached = fresh;
        if (previous !== undefined) await this.#revoke(previous);
        return fresh;
      })
      .finally(() => { this.#inFlight = undefined; });

    const minted = await this.#inFlight;
    // stop() may have been called while the mint was in flight. Honour it:
    // handing back a token after the caller asked to stop is the opposite of
    // what stopping means.
    if (this.#stopped) {
      await this.#revoke(minted);
      throw new Error("TokenRefresher is stopped");
    }
    return minted;
  }

  #isStale(t: MintedToken): boolean {
    const remaining = Date.parse(t.expiresAt) - Date.now();
    // An unparseable expiry is treated as expired. Trusting it would mean
    // using a token past its life on the strength of a malformed string.
    return Number.isNaN(remaining) || remaining <= this.#threshold;
  }

  async #revoke(t: MintedToken): Promise<void> {
    if (this.#deps === undefined) return;
    // A failed revoke must not take down the run: the token expires on its own
    // within the hour, and the proxy stops honouring the mandate before that.
    try {
      await revokeToken(this.#deps, t.token);
    } catch {
      // Intentionally swallowed. See above.
    }
  }

  /**
   * Stops refreshing and revokes the current token, for the PRD's lifecycle
   * step 8. Safe to call twice; `DELETE /installation/token` is idempotent.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    const cached = this.#cached;
    this.#cached = undefined;
    if (cached !== undefined) await this.#revoke(cached);
  }
}
