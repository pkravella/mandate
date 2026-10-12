import { readFileSync } from "node:fs";
import { githubAppDeps } from "@mandate-dev/compiler";
import {
  APPROVE_COMMAND, approvalDigest, approvalLine, proofOf, type ValidatedMandate,
} from "@mandate-dev/schema";

/**
 * R5's approval, where the review already happens: a comment on the issue or
 * pull request, by the requester, carrying exactly `/mandate approve <digest>`
 * on a line of its own (see `approvalDigest`). `serve` and `run` refuse to mint
 * without one when given `--approval`.
 *
 * GitHub is the store. A comment records who wrote it and when, and the
 * digest makes it content-addressed, so nothing here has to be kept anywhere
 * else -- and the approval sits beside the permission diff it approves.
 */
export interface ApprovalComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export type ApprovalCheck =
  | { readonly ok: true; readonly comment: ApprovalComment }
  | { readonly ok: false; readonly reason: string };

/** Reads every comment on an issue or pull request. Injected for tests. */
export type ApprovalReader = (ref: ApprovalRef) => Promise<readonly ApprovalComment[]>;

const REF = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;

/** `owner/repo#number`, or undefined. */
export function parseApprovalRef(s: string): ApprovalRef | undefined {
  const m = REF.exec(s);
  if (m === null) return undefined;
  return { owner: m[1] ?? "", repo: m[2] ?? "", number: Number(m[3]) };
}

const DIGEST_LINE = new RegExp(`^${APPROVE_COMMAND.replace(/[/]/g, "\\/")} ([0-9a-f]{64})$`);

/**
 * The first comment that approves `digest` for `requester`, or why none does.
 *
 * The line must stand alone: a quoted line (`> /mandate approve ...`), one in
 * inline backticks or one inside a sentence is someone talking about an
 * approval, not giving one. A line inside a fenced code block does count --
 * only the requester's comments count at all, so that can only be the
 * requester approving. An edited comment is refused outright, because a
 * repository admin can edit anyone's comment: an edited approval is one its
 * author may never have written. "Edited" is updated_at differing from
 * created_at, which GitHub gives to the second, so an edit within the same
 * second is not seen; GraphQL's edit history would see it (not yet used).
 */
export function findApproval(
  comments: readonly ApprovalComment[], digest: string, requester: string,
): ApprovalCheck {
  const login = requester.replace(/^user:/, "").toLowerCase();
  const notes: string[] = [];
  for (const c of comments) {
    const approved = c.body.split(/\r?\n/).map((l) => l.trim())
      .map((l) => DIGEST_LINE.exec(l)?.[1]).filter((d) => d !== undefined);
    if (approved.length === 0) continue;
    if (c.author.toLowerCase() !== login) {
      notes.push(`comment ${c.id} is by ${c.author}, not the requester ${login}`);
      continue;
    }
    if (c.updatedAt !== c.createdAt) {
      notes.push(`comment ${c.id} was edited after it was posted, so it may not be ${c.author}'s`);
      continue;
    }
    if (!approved.includes(digest)) {
      notes.push(
        `comment ${c.id} approves a different digest: the mandate, the ceiling it was proved `
        + "against or its requester has changed since",
      );
      continue;
    }
    return { ok: true, comment: c };
  }
  return {
    ok: false,
    reason: `no approval by ${login} of this mandate. ${login} approves it by commenting, on a line `
      + `of its own: ${approvalLine(digest)}${notes.length === 0 ? "" : `\n  ${notes.join("\n  ")}`}`,
  };
}

/**
 * The real reader, or undefined when the App is not configured: a token for
 * the one repository with `issues: read` and `pull_requests: read` only, the
 * comments read page by page, and the token revoked on the way out --
 * githubResolver's pattern.
 *
 * Both permissions, probed 2026-10-12: an `issues: read` token reads an
 * issue's comments and is refused (403) on a pull request's, through the same
 * endpoint -- and a pull request is where an approval is most often given.
 */
export function githubApprovalReader(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readKey: (path: string) => string = (path) => readFileSync(path, "utf8"),
  makeDeps: typeof githubAppDeps = githubAppDeps,
): ApprovalReader | undefined {
  const appId = env["MANDATE_APP_ID"];
  const installationId = env["MANDATE_INSTALLATION_ID"];
  const keyPath = env["MANDATE_APP_KEY_PATH"];
  if (appId === undefined || installationId === undefined || keyPath === undefined) return undefined;
  const id = Number(installationId);
  if (!Number.isInteger(id) || id <= 0) return undefined;

  return async (ref) => {
    const deps = makeDeps({ appId, installationId: id, privateKey: readKey(keyPath) });
    const res = await deps.asApp("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: id, repositories: [ref.repo], permissions: { issues: "read", pull_requests: "read" },
    });
    const token = (res.data as { readonly token?: unknown }).token;
    if (typeof token !== "string") throw new Error(`GitHub did not return a usable token (status ${res.status})`);
    try {
      const out: ApprovalComment[] = [];
      for (let page = 1; ; page++) {
        const r = await deps.asInstallation(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", token,
          { owner: ref.owner, repo: ref.repo, issue_number: ref.number, per_page: 100, page },
        );
        if (r.status !== 200 || !Array.isArray(r.data)) {
          throw new Error(`could not read the comments on ${ref.owner}/${ref.repo}#${ref.number} (status ${r.status})`);
        }
        for (const c of r.data as readonly Record<string, unknown>[]) {
          const user = c["user"] as { readonly login?: unknown } | null | undefined;
          if (typeof c["id"] !== "number" || typeof user?.login !== "string" || typeof c["body"] !== "string"
            || typeof c["created_at"] !== "string" || typeof c["updated_at"] !== "string") continue;
          out.push({
            id: c["id"], author: user.login, body: c["body"],
            createdAt: c["created_at"], updatedAt: c["updated_at"],
          });
        }
        if (r.data.length < 100) return out;
      }
    } finally {
      try {
        await deps.asInstallation("DELETE /installation/token", token);
      } catch {
        // Expires within the hour regardless; see githubResolver.
      }
    }
  };
}

/** What `serve` records about the approval it found, and the audit log keeps. */
export interface ApprovalRecord {
  /** `owner/repo#number`. */
  readonly issue: string;
  readonly comment: number;
  readonly by: string;
  readonly at: string;
  readonly digest: string;
}

/**
 * The input check `serve` and `run` make before anything else: a reference
 * they can read, and a way to read it.
 */
export function approvalInputs(
  approval: string | undefined, reader: ApprovalReader | undefined,
): { readonly ref?: ApprovalRef } | { readonly error: string } {
  if (approval === undefined) return {};
  const ref = parseApprovalRef(approval);
  if (ref === undefined) {
    return { error: `--approval takes owner/repo#number, the issue or pull request the approval is on; got ${JSON.stringify(approval)}` };
  }
  if (reader === undefined) {
    return {
      error: "--approval reads the approval from GitHub, which needs MANDATE_APP_ID, "
        + "MANDATE_INSTALLATION_ID and MANDATE_APP_KEY_PATH (and the App's issues and pull_requests read)",
    };
  }
  return { ref };
}

/** Whether the validated mandate's requester approved it on `ref`. */
export async function requireApproval(
  mandate: ValidatedMandate, ref: ApprovalRef, reader: ApprovalReader,
): Promise<
  | { readonly ok: true; readonly record: ApprovalRecord }
  /** 1: not approved. 2: the approval could not be read, so nothing is known. */
  | { readonly ok: false; readonly code: 1 | 2; readonly message: string }
> {
  const digest = approvalDigest(mandate, proofOf(mandate).ceilingSha256, mandate.requestedBy);
  const issue = `${ref.owner}/${ref.repo}#${ref.number}`;
  let comments: readonly ApprovalComment[];
  try {
    comments = await reader(ref);
  } catch (e) {
    return { ok: false, code: 2, message: `Could not read the approval on ${issue}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const found = findApproval(comments, digest, mandate.requestedBy);
  if (!found.ok) return { ok: false, code: 1, message: `Not approved on ${issue}: ${found.reason}` };
  return {
    ok: true,
    record: { issue, comment: found.comment.id, by: found.comment.author, at: found.comment.createdAt, digest },
  };
}
