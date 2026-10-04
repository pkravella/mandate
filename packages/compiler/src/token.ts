import { createHash } from "node:crypto";
import { z } from "zod";
import { getOperation, type GhPermission } from "@mandate-dev/catalog";
import { unwrap, type ValidatedMandate } from "@mandate-dev/schema";

export type PermissionSet = Partial<Record<GhPermission, "read" | "write">>;

/** A GitHub REST response, already decoded. An adapter must not throw on 4xx. */
export interface GitHubResponse {
  readonly status: number;
  readonly data: unknown;
}

export interface MintDeps {
  /** Authenticated as the GitHub App itself, with the app JWT. */
  asApp(route: string, params: Readonly<Record<string, unknown>>): Promise<GitHubResponse>;
  /**
   * Authenticated as a given installation token. Used only to revoke it:
   * `DELETE /installation/token` authenticates with the token it destroys.
   */
  asInstallation(
    route: string, token: string, params?: Readonly<Record<string, unknown>>,
  ): Promise<GitHubResponse>;
  readonly installationId: number;
}

export type MintErrorCode =
  /** The mandate cannot be expressed as a token request at all. */
  | "not-mintable"
  /** GitHub refused: the installation lacks a permission or a repository. */
  | "refused"
  /** GitHub answered, but not with a token we can use. */
  | "unusable-response"
  /** Belt and braces: the token came back narrower than it was requested. */
  | "narrower-than-requested";

export class MintError extends Error {
  readonly code: MintErrorCode;

  constructor(code: MintErrorCode, message: string) {
    super(message);
    this.name = "MintError";
    this.code = code;
  }
}

export interface MintedToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly repositories: readonly string[];
  readonly permissions: PermissionSet;
  /** sha256(token) truncated to 12 chars. The only form safe to log. */
  readonly fingerprint: string;
  /**
   * Redacts the token.
   *
   * A `MintedToken` is exactly the kind of object that ends up inside a log
   * line or an error payload. The secrets rule is that a token is referenced
   * only by its fingerprint, so the obvious accident is made impossible here
   * rather than left to every future caller to remember.
   */
  toJSON(): Record<string, unknown>;
}

/**
 * The permissions the token needs: the union over the grants, taking `write`
 * whenever any grant on that permission needs it.
 *
 * `metadata: read` is always included. Every installation has it, GitHub
 * expects it alongside `contents`, and including it cannot widen anything.
 */
export function requiredPermissions(m: ValidatedMandate): PermissionSet {
  const out: PermissionSet = { metadata: "read" };
  for (const g of unwrap(m).grants) {
    const op = getOperation(g.action);
    // A ValidatedMandate has been through validate(), which rejects an unknown
    // action, so this cannot be missing. Skipping rather than throwing keeps a
    // decision path from being the thing that crashes.
    if (op === undefined) continue;
    out[op.permission] = out[op.permission] === "write" || op.permissionLevel === "write"
      ? "write"
      : "read";
  }
  return out;
}

export interface TokenTarget {
  readonly owner: string;
  /** Bare repository names, which is what the access_tokens route accepts. */
  readonly names: readonly string[];
}

/**
 * The repositories to scope the token to.
 *
 * Measured against the real endpoint: `repositories` takes **bare names**. A
 * full `owner/name` is refused with "There is at least one repository that does
 * not exist or is not accessible to the parent installation" — a message that
 * sends you hunting for a permissions problem that is not there.
 *
 * So the owner has to be dropped, and dropping it silently is a hole: grants on
 * `acme/api` and `other/api` would collapse to the single name `api`, and the
 * token would be minted for whichever `api` the installation happens to cover.
 * One owner per mandate, checked, or nothing is minted.
 */
export function targetRepositories(m: ValidatedMandate): TokenTarget {
  const owners = new Set<string>();
  const names = new Set<string>();

  for (const g of unwrap(m).grants) {
    for (const r of g.resources) {
      if (r.includes("*")) {
        throw new MintError(
          "not-mintable",
          `cannot mint a token for pattern ${JSON.stringify(r)}: a token scopes to concrete `
          + `repositories, so resources must be owner/name at mint time`,
        );
      }
      const parts = r.split("/");
      const [owner, name] = parts;
      if (parts.length !== 2 || owner === undefined || name === undefined
          || owner.length === 0 || name.length === 0) {
        throw new MintError("not-mintable", `resource ${JSON.stringify(r)} is not owner/name`);
      }
      owners.add(owner);
      names.add(name);
    }
  }

  if (owners.size !== 1) {
    throw new MintError(
      "not-mintable",
      `a token is scoped to one installation, so one mandate cannot span owners `
      + `${[...owners].sort().join(", ")}`,
    );
  }
  const owner = [...owners][0];
  if (owner === undefined) throw new MintError("not-mintable", "the mandate names no repository");
  return { owner, names: [...names] };
}

// The response is data from outside the trust boundary, so it is parsed, not
// asserted. A 201 whose body is not what we expect is a reject, not a token.
const TokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
  permissions: z.record(z.string(), z.string()).optional(),
  repositories: z.array(z.object({ name: z.string() })).optional(),
});

const ErrorBody = z.object({ message: z.string() });

/** GitHub's own wording for a refusal, which is what a reviewer needs to see. */
const githubMessage = (data: unknown): string => {
  const parsed = ErrorBody.safeParse(data);
  return parsed.success ? parsed.data.message : JSON.stringify(data).slice(0, 300);
};

export const fingerprint = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 12);

/**
 * R6: an installation token scoped to the mandate's repositories and to the
 * permissions its grants need.
 *
 * Measured against the real endpoint, which corrects this task's premise. The
 * plan expected GitHub to *silently drop* permissions the installation lacks.
 * It does not — it refuses with 422 and says which way it failed:
 *
 *   "The permissions requested are not granted to this installation."
 *   "The level of access for permissions requested are not granted to this installation."
 *
 * So the real failure is loud, and the job here is to surface it with GitHub's
 * own wording rather than to detect a silent narrowing. The narrowing check
 * below is kept anyway, and is unreachable today: it costs nothing and it is
 * the difference between fail-closed and fail-open if that behaviour ever
 * changes.
 */
export async function mintToken(deps: MintDeps, m: ValidatedMandate): Promise<MintedToken> {
  const permissions = requiredPermissions(m);
  const target = targetRepositories(m);

  // Measured: omitting `permissions` mints a token carrying EVERY permission
  // the installation holds. On this fixture that is `issues: write` the mandate
  // never asked for. An empty set must therefore never be sent as "no
  // preference" -- it would be read as "everything".
  if (Object.keys(permissions).length === 0) {
    throw new MintError(
      "not-mintable",
      "refusing to request a token with no permissions: GitHub reads an absent permission set "
      + "as every permission the installation holds",
    );
  }

  const res = await deps.asApp(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: deps.installationId, repositories: target.names, permissions },
  );

  if (res.status !== 201) {
    throw new MintError(
      "refused",
      `GitHub refused to mint a token (${res.status}): ${githubMessage(res.data)} `
      + `[requested ${JSON.stringify(permissions)} on ${target.owner}/`
      + `{${target.names.join(",")}}]`,
    );
  }

  const parsed = TokenResponseSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new MintError(
      "unusable-response",
      `GitHub answered 201 with a body this cannot use: `
      + parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  const data = parsed.data;
  const granted = data.permissions ?? {};
  const narrower = Object.entries(permissions).filter(([k, want]) => {
    const got = granted[k];
    if (got === undefined) return true;
    return want === "write" && got !== "write";
  });
  if (narrower.length > 0) {
    throw new MintError(
      "narrower-than-requested",
      `the installation did not grant ${narrower.map(([k, v]) => `${k}:${v}`).join(", ")}; `
      + `a token narrower than the mandate assumed produces confusing mid-run failures`,
    );
  }

  const repositories = (data.repositories ?? []).map((r) => r.name);
  const redacted = {
    token: "[redacted]",
    fingerprint: fingerprint(data.token),
    expiresAt: data.expires_at,
    repositories,
    permissions,
  };

  return {
    token: data.token,
    expiresAt: data.expires_at,
    repositories,
    permissions,
    fingerprint: fingerprint(data.token),
    toJSON: () => redacted,
  };
}

/**
 * Revokes a token, for the PRD's lifecycle step 8.
 *
 * Measured: `DELETE /installation/token` answers 204, is idempotent, and is
 * **eventually consistent** — the token kept working for about two to four
 * seconds afterwards. Revocation is therefore real but not immediate, which is
 * why it is not the control the mandate's expiry rests on: the proxy refusing
 * every call past `expiresAt` is. The enforcement report has to say so.
 */
export async function revokeToken(deps: MintDeps, token: string): Promise<void> {
  const res = await deps.asInstallation("DELETE /installation/token", token);
  if (res.status !== 204) {
    throw new MintError(
      "refused",
      `GitHub refused to revoke token sha256 ${fingerprint(token)} (${res.status}): `
      + githubMessage(res.data),
    );
  }
}
