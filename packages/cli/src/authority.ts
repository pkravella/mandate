import { readFileSync } from "node:fs";
import { githubAppDeps } from "@mandate-dev/compiler";
import { fetchUserAuthority, type UserAuthority } from "@mandate-dev/validator";

export const USER_LEVELS = ["none", "pull", "triage", "push", "maintain", "admin"] as const;

/**
 * Reads the requester's level from GitHub. Injected so the decision path is
 * testable without credentials, and so no code path reaches for the network
 * unless the operator asked it to.
 */
export type ResolveAuthority = (repo: string, login: string) => Promise<UserAuthority>;

export interface AuthorityDeps {
  readonly resolve?: ResolveAuthority;
}

export interface AuthoritySource {
  /** `owner/name` to look the level up on. Mutually exclusive with `level`. */
  readonly repo?: string | undefined;
  /** An asserted level. Mutually exclusive with `repo`. */
  readonly level?: string | undefined;
  readonly as: string;
}

/**
 * Where the level came from, which the output has to state.
 *
 * "Verified" and "asserted" are different claims, and output that does not
 * distinguish them reads like an authorisation record while being an operator's
 * say-so. Keeping the provenance beside the level is what makes the difference
 * visible at the point the decision is reported.
 */
export interface ResolvedAuthority {
  readonly authority: UserAuthority;
  readonly verified: boolean;
  readonly provenance: string;
}

/**
 * The one place the question "whose authority, and who says so?" is answered.
 *
 * Both `validate` and `widen` take `--as` and decide against a level, and they
 * had separate copies of the level parsing with the same `push` default. Two
 * copies of an authority decision is how one of them silently stops matching
 * the other — the Phase 3 lesson that cost a whole benchmark sweep — so there
 * is one function and both call it.
 */
export async function resolveAuthority(
  src: AuthoritySource, deps: AuthorityDeps = {},
): Promise<ResolvedAuthority | { readonly error: string }> {
  const hasRepo = src.repo !== undefined && src.repo.length > 0;
  const hasLevel = src.level !== undefined && src.level.length > 0;

  if (hasRepo && hasLevel) {
    return {
      error: "--repo and --level both say where the requester's authority comes from; "
        + "pass only one. --repo reads it from GitHub, --level asserts it.",
    };
  }
  // No default. `--level` used to default to `push`, so every run asserted push
  // authority and nothing in the output said so — the output read like an
  // authorisation record and was not one. An operator who has not said where
  // the level came from has not been asked the question.
  if (!hasRepo && !hasLevel) {
    return {
      error: "the requester's repository authority is unknown. Pass --repo <owner/name> to "
        + `read it from GitHub, or --level <${USER_LEVELS.join("|")}> to assert it; an `
        + "asserted level is labelled unverified in the output.",
    };
  }

  if (hasLevel) {
    const level = USER_LEVELS.find((l) => l === src.level);
    if (level === undefined) {
      return {
        error: `--level must be one of ${USER_LEVELS.join(", ")}, `
          + `not ${JSON.stringify(src.level)}`,
      };
    }
    return {
      authority: { login: src.as, level },
      verified: false,
      provenance: `level ${level} for ${src.as} was asserted with --level and is NOT verified; `
        + "this output is not an authorisation record. Pass --repo to read it from GitHub.",
    };
  }

  const repo = src.repo ?? "";
  const resolve = deps.resolve;
  if (resolve === undefined) {
    return {
      error: "--repo needs GitHub App credentials to read the requester's permission. Set "
        + "MANDATE_APP_ID, MANDATE_INSTALLATION_ID and MANDATE_APP_KEY_PATH, or assert the "
        + "level with --level.",
    };
  }

  // A throw is bad input, not a fallback. `fetchUserAuthority` already resolves
  // `none` for every answer GitHub gives that we cannot use; a throw here means
  // the lookup could not be attempted at all, which is a different failure and
  // must not be reported to the operator as "this user has no access".
  let authority: UserAuthority;
  try {
    authority = await resolve(repo, src.as);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { error: `Could not read ${src.as}'s permission on ${repo}: ${detail}` };
  }

  return {
    authority,
    verified: true,
    provenance: authority.level === "none"
      ? `${src.as} has no access to ${repo} (level none), so no grant can be authorised. `
        + "A lookup that could not be made also reads as none, by design."
      : `level ${authority.level} for ${src.as} was verified against ${repo}.`,
  };
}

/**
 * The real resolver, or `undefined` when the App is not configured.
 *
 * Returning `undefined` rather than a resolver that throws is deliberate: the
 * operator gets "set these variables, or assert the level" at the point they
 * asked for a lookup, instead of a stack trace from inside the request.
 *
 * The token is minted with `metadata: read` only — the narrowest permission
 * that can answer this question — and revoked on the way out. Minting per
 * lookup rather than once is the cheap, correct order: this runs once per CLI
 * invocation, and a longer-lived token would outlive the answer it was for.
 */
export function githubResolver(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolveAuthority | undefined {
  const appId = env["MANDATE_APP_ID"];
  const installationId = env["MANDATE_INSTALLATION_ID"];
  const keyPath = env["MANDATE_APP_KEY_PATH"];
  if (appId === undefined || installationId === undefined || keyPath === undefined) {
    return undefined;
  }
  const id = Number(installationId);
  if (!Number.isInteger(id) || id <= 0) return undefined;

  return async (repo, login) => {
    const [, name] = repo.split("/");
    const deps = githubAppDeps({
      appId,
      installationId: id,
      privateKey: readFileSync(keyPath, "utf8"),
    });
    const res = await deps.asApp(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: id,
        repositories: [name ?? ""],
        permissions: { metadata: "read" },
      },
    );
    const token = (res.data as { readonly token?: unknown }).token;
    if (typeof token !== "string") {
      throw new Error(`GitHub did not return a usable token (status ${res.status})`);
    }
    try {
      return await fetchUserAuthority(
        { request: (route, params) => deps.asInstallation(route, token, params) },
        repo, login,
      );
    } finally {
      try {
        await deps.asInstallation("DELETE /installation/token", token);
      } catch {
        // A token that could not be revoked still expires in an hour, and
        // failing the lookup over it would turn a cleanup problem into a denial.
      }
    }
  };
}
