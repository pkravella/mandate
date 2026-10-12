import { openSync, closeSync, writeSync } from "node:fs";
import { parseMandateYaml } from "@leastpilot/schema";
import { parseApprovalRef, type ApprovalComment, type ApprovalReader } from "./approval.js";
import { REVIEW_MARKER } from "./commands/review.js";

/**
 * `leastpilot reviewed` -- the step between an approval and a run: the
 * mandate the approved digest names, taken from the App's own review comment
 * (R5). The approval comment carries only the digest.
 *
 * Safe to take from a comment because `serve --approval` re-derives the
 * digest from the file it is given, the ceiling and the requester: a mandate
 * altered on the way does not match the approval and nothing is minted. The
 * mandate is taken only from the App's own comment all the same, so a
 * lookalike posted by anyone else is never even read.
 */
export function extractReviewedMandate(
  comments: readonly ApprovalComment[], botLogin: string, digest: string,
): { readonly ok: true; readonly yaml: string; readonly comment: number }
  | { readonly ok: false; readonly reason: string } {
  const head = `${REVIEW_MARKER} digest=${digest} -->`;
  for (const c of comments) {
    if (c.author.toLowerCase() !== botLogin.toLowerCase() || !c.body.startsWith(head)) continue;
    const lines = c.body.split("\n");
    const summary = lines.indexOf("<details><summary>The mandate</summary>");
    if (summary === -1) continue;
    const openAt = lines.findIndex((l, i) => i > summary && /^`{3,}yaml$/.test(l));
    if (openAt === -1) continue;
    const fence = (lines[openAt] ?? "").replace(/yaml$/, "");
    const closeAt = lines.findIndex((l, i) => i > openAt && l === fence);
    if (closeAt === -1) continue;
    return { ok: true, yaml: lines.slice(openAt + 1, closeAt).join("\n"), comment: c.id };
  }
  return { ok: false, reason: `no review comment by ${botLogin} carries the mandate with digest ${digest}` };
}

export interface ReviewFetchArgs {
  /** `owner/repo#number`, where the review and the approval were posted. */
  readonly on: string;
  readonly digest: string;
  /** Written only if it does not exist. */
  readonly out: string;
  /**
   * Where to write the mandate's task, for the agent to read. A file, so the
   * task -- the requester's comment, in the end -- never becomes an argv line.
   */
  readonly taskOut?: string | undefined;
}

export interface ReviewFetchDeps {
  readonly comments?: ApprovalReader | undefined;
  readonly botLogin?: (() => Promise<string>) | undefined;
}

/** Exit 0 written, 1 no such reviewed mandate, 2 bad input. */
export async function runReviewFetch(
  args: ReviewFetchArgs, log: (s: string) => void, deps: ReviewFetchDeps,
): Promise<number> {
  const ref = parseApprovalRef(args.on);
  if (ref === undefined) {
    log(`--on takes owner/repo#number; got ${JSON.stringify(args.on)}`);
    return 2;
  }
  if (!/^[0-9a-f]{64}$/.test(args.digest)) {
    log("--digest is the 64 hex characters from the /leastpilot approve line.");
    return 2;
  }
  if (deps.comments === undefined || deps.botLogin === undefined) {
    log("review fetch reads the App's comments: set LEASTPILOT_APP_ID, LEASTPILOT_INSTALLATION_ID and LEASTPILOT_APP_KEY_PATH.");
    return 2;
  }
  let found: ReturnType<typeof extractReviewedMandate>;
  try {
    found = extractReviewedMandate(await deps.comments(ref), await deps.botLogin(), args.digest);
  } catch (e) {
    log(`Could not read the comments on ${args.on}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (!found.ok) {
    log(found.reason);
    return 1;
  }
  let task: string;
  try {
    task = parseMandateYaml(found.yaml).task;
  } catch (e) {
    log(`Review comment ${found.comment} does not hold a readable mandate: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  for (const [path, text] of [[args.out, found.yaml], ...(args.taskOut === undefined ? [] : [[args.taskOut, task]])] as const) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      log(`Could not create ${path}: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    try {
      writeSync(fd, `${text}\n`);
    } finally {
      closeSync(fd);
    }
  }
  log(`Wrote the mandate from review comment ${found.comment} to ${args.out}.`);
  return 0;
}
