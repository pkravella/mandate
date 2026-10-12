import { readFileSync } from "node:fs";
import { githubAppDeps, type MintDeps } from "@leastpilot/compiler";
import type { RecentComment, ReviewComments } from "./commands/review.js";

/**
 * `review`'s GitHub, through the App: its own login, the repository's recent
 * comments, and the one write -- the comment it posts. Each call mints a token
 * for the one repository with only what that call needs and revokes it after,
 * githubResolver's pattern. Both `issues` and `pull_requests`, because an
 * issue-only token is refused on a pull request's comments (probed for 7.1a).
 *
 * Undefined when the App is not configured, so `review` refuses at the start
 * rather than failing after it has decided to spend.
 */
export function githubReviewComments(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readKey: (path: string) => string = (path) => readFileSync(path, "utf8"),
  makeDeps: typeof githubAppDeps = githubAppDeps,
): ReviewComments | undefined {
  const appId = env["LEASTPILOT_APP_ID"];
  const installationId = env["LEASTPILOT_INSTALLATION_ID"];
  const keyPath = env["LEASTPILOT_APP_KEY_PATH"];
  if (appId === undefined || installationId === undefined || keyPath === undefined) return undefined;
  const id = Number(installationId);
  if (!Number.isInteger(id) || id <= 0) return undefined;

  const deps = (): MintDeps => makeDeps({ appId, installationId: id, privateKey: readKey(keyPath) });

  const withToken = async <T>(
    d: MintDeps, repo: string, permissions: Record<string, string>, use: (token: string) => Promise<T>,
  ): Promise<T> => {
    const res = await d.asApp("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: id, repositories: [repo], permissions,
    });
    const token = (res.data as { readonly token?: unknown }).token;
    if (typeof token !== "string") throw new Error(`GitHub did not return a usable token (status ${res.status})`);
    try {
      return await use(token);
    } finally {
      try {
        await d.asInstallation("DELETE /installation/token", token);
      } catch {
        // Expires within the hour regardless; see githubResolver.
      }
    }
  };

  return {
    botLogin: async () => {
      const r = await deps().asApp("GET /app", {});
      const slug = (r.data as { readonly slug?: unknown } | null)?.slug;
      if (typeof slug !== "string") throw new Error(`could not read the App's slug (status ${r.status})`);
      return `${slug}[bot]`;
    },

    since: async (owner, repo, since) => {
      const d = deps();
      return withToken(d, repo, { issues: "read", pull_requests: "read" }, async (token) => {
        const out: RecentComment[] = [];
        for (let page = 1; ; page++) {
          const r = await d.asInstallation("GET /repos/{owner}/{repo}/issues/comments", token, {
            owner, repo, since, per_page: 100, page,
          });
          if (r.status !== 200 || !Array.isArray(r.data)) {
            throw new Error(`could not read ${owner}/${repo}'s recent comments (status ${r.status})`);
          }
          for (const c of r.data as readonly Record<string, unknown>[]) {
            const user = c["user"] as { readonly login?: unknown } | null | undefined;
            if (typeof user?.login !== "string" || typeof c["body"] !== "string"
              || typeof c["created_at"] !== "string") continue;
            out.push({ author: user.login, body: c["body"], createdAt: c["created_at"] });
          }
          if (r.data.length < 100) return out;
        }
      });
    },

    post: async (on, body) => {
      const d = deps();
      return withToken(d, on.repo, { issues: "write", pull_requests: "write" }, async (token) => {
        const r = await d.asInstallation("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", token, {
          owner: on.owner, repo: on.repo, issue_number: on.number, body,
        });
        const data = r.data as { readonly id?: unknown; readonly html_url?: unknown } | null;
        if (r.status !== 201 || typeof data?.id !== "number" || typeof data.html_url !== "string") {
          throw new Error(`could not post the comment on ${on.owner}/${on.repo}#${on.number} (status ${r.status})`);
        }
        return { id: data.id, url: data.html_url };
      });
    },
  };
}
