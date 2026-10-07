import type { UserLevel } from "@mandate-dev/catalog";

export interface UserAuthority {
  readonly login: string;
  readonly level: UserLevel;
}

export interface OctokitLike {
  request(route: string, params: Readonly<Record<string, unknown>>): Promise<{ readonly data: unknown }>;
}

const LEVELS: readonly UserLevel[] = ["none", "pull", "triage", "push", "maintain", "admin"];

/**
 * The legacy vocabulary `permission` is documented to use, mapped onto ours.
 *
 * This translation is the whole reason this module is not three lines. The
 * endpoint's `permission` field returns `admin | write | read | none`, while
 * `UserLevel` — which the catalog's `minUserLevel` is expressed in — is
 * `none | pull | triage | push | maintain | admin`. Matching the raw string
 * against `UserLevel` therefore resolved a collaborator with write access to
 * `none`, because "write" is not one of our strings. That denies every grant:
 * fail-closed, so never a breach, but it would have meant the function that
 * closes D2's user-authority check rejected everyone it was asked about.
 *
 * `write` and `read` have no finer meaning in this field. `triage` and
 * `maintain` cannot be expressed in it at all, which is why `role_name` is
 * preferred below.
 */
const LEGACY: Readonly<Record<string, UserLevel>> = {
  admin: "admin",
  write: "push",
  read: "pull",
  none: "none",
};

/**
 * Whether a login is safe to interpolate into the route.
 *
 * The login is a path parameter, so one containing a separator or a query
 * character addresses a different endpoint. GitHub logins are alphanumeric with
 * single hyphens, so refusing anything else cannot reject a real user — and a
 * login we will not send is `none`, not an unchecked request.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads the requester's effective permission on the repository.
 *
 * Both fields of the response are consulted, finer first:
 *
 *   - `role_name` carries the fine-grained role, and is the only field in which
 *     `triage` and `maintain` appear at all. An organization using custom
 *     repository roles returns the custom role's own name here, which is in no
 *     vocabulary — so an unrecognised `role_name` falls through rather than
 *     resolving `none`, because the custom role's base permission is exactly
 *     what the legacy field reports.
 *   - `permission` is the legacy field, translated through `LEGACY`.
 *
 * Any failure resolves to `none`, which denies every grant: a 404 because the
 * user cannot see the repository, a network error, a response shape we do not
 * recognise, or a login we are not willing to put in a URL. Guessing higher on
 * an error would turn an outage into an over-grant.
 */
export async function fetchUserAuthority(
  octokit: OctokitLike,
  repo: string,
  login: string,
): Promise<UserAuthority> {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    return { login, level: "none" };
  }
  if (!LOGIN.test(login)) return { login, level: "none" };

  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      { owner, repo: name, username: login },
    );
    // Redundant and kept deliberately: every non-record body already resolves
    // to `none` without it, because the property reads below give `undefined`
    // (a string, a number, an array) or throw into the catch (`null`). A
    // mutation removing it survives, and that is recorded rather than worked
    // around. It stays because "none because the shape was wrong" and "none
    // because a TypeError was swallowed" are different failures, and only the
    // first survives someone later tightening the catch.
    if (!isRecord(res.data)) return { login, level: "none" };

    const roleName = res.data["role_name"];
    if (typeof roleName === "string") {
      const fine = LEVELS.find((l) => l === roleName);
      if (fine !== undefined) return { login, level: fine };
      // A custom role. Fall through to the legacy field for its base level.
    }

    const permission = res.data["permission"];
    if (typeof permission !== "string") return { login, level: "none" };
    return { login, level: LEGACY[permission] ?? "none" };
  } catch {
    return { login, level: "none" };
  }
}
