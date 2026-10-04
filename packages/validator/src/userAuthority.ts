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
 * Reads the requester's effective permission on the repository.
 *
 * Any failure resolves to `none`, which denies every grant: a 404 because the
 * user cannot see the repository, a network error, or a level string we do not
 * recognise. Guessing higher on an error would turn an outage into an
 * over-grant.
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
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      { owner, repo: name, username: login },
    );
    const raw = (res.data as { readonly permission?: unknown }).permission;
    const level = LEVELS.find((l) => l === raw);
    return { login, level: level ?? "none" };
  } catch {
    return { login, level: "none" };
  }
}
