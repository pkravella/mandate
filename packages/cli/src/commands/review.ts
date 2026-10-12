import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { atLeast, type UserLevel } from "@mandate-dev/catalog";
import { approvalDigest, approvalLine, proofOf, type ProposedMandate } from "@mandate-dev/schema";
import { loadCeiling, validate, type Ceiling } from "@mandate-dev/validator";
import { WriterError, type WriteRequest } from "@mandate-dev/writer";
import { parseApprovalRef, type ApprovalRef } from "../approval.js";
import { resolveAuthority, USER_LEVELS, type ResolveAuthority } from "../authority.js";
import { renderPermissionDiff, renderRejections } from "../diff.js";
import { ceilingLabel } from "../prepare.js";

/**
 * `mandate review` -- R5's other half: a requester asks for a mandate, the
 * writer proposes one, the validator proves it, and the permission diff is
 * posted on the issue or pull request with the line that approves it
 * (`serve --approval` checks that line before anything is minted).
 *
 * It spends a model call on a comment, so the order is the point. Everything
 * that can refuse without the model refuses first: the commenter's level, read
 * from GitHub and never asserted, against a minimum the operator sets; and a
 * limit on how many mandates the App has written on the repository in the last
 * hour, counted from the App's own comments.
 *
 * Exit 0 posted a mandate to approve; 1 refused (level, limit, the writer, or
 * the validator); 2 bad input.
 */
export interface ReviewArgs {
  /** The task text, from a file: in a workflow it is the comment's body, and never a shell argument. */
  readonly taskFile: string;
  /** `owner/repo#number`: where the request was made and the diff is posted. */
  readonly on: string;
  /** The commenter, whose authority the mandate is validated against. */
  readonly as: string;
  /** Where the commenter's level is read. Must be the repository `on` is in. */
  readonly repo?: string | undefined;
  /** Refused: the level must be read, not asserted. Present to say so. */
  readonly level?: string | undefined;
  readonly ceiling: string;
  readonly schema: string;
  readonly destinations: string;
  /** The least level allowed to request a mandate. Default `push`. */
  readonly minLevel?: string | undefined;
  /** Mandates the App may write on the repository per hour. Default 10. */
  readonly maxPerHour?: number | undefined;
  /** Post the comment. Without it the comment is printed instead. */
  readonly post?: boolean | undefined;
}

export interface RecentComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

/** GitHub, as `review` uses it. Injected for tests. */
export interface ReviewComments {
  /** The App's own login, `<slug>[bot]`: the only author whose review comments count. */
  botLogin(): Promise<string>;
  /** Every issue and pull-request comment on the repository created or updated since `since`. */
  since(owner: string, repo: string, since: string): Promise<readonly RecentComment[]>;
  post(on: ApprovalRef, body: string): Promise<{ readonly id: number; readonly url: string }>;
}

export interface ReviewDeps {
  readonly resolve?: ResolveAuthority | undefined;
  /** The writer. Paid. */
  readonly write?: ((req: WriteRequest) => Promise<ProposedMandate>) | undefined;
  readonly comments?: ReviewComments | undefined;
  readonly now?: () => Date;
}

/** Opens every comment `review` posts, so the rate limit can count them. */
export const REVIEW_MARKER = "<!-- mandate-review";

export const DEFAULT_MIN_LEVEL: UserLevel = "push";
export const DEFAULT_MAX_PER_HOUR = 10;

const HOUR_MS = 60 * 60 * 1000;

export async function runReview(
  args: ReviewArgs, out: (s: string) => void, err: (s: string) => void, deps: ReviewDeps = {},
): Promise<number> {
  // ---- input, before anything touches the network ------------------------
  const on = parseApprovalRef(args.on);
  if (on === undefined) {
    err(`--on takes owner/repo#number, where the request was made; got ${JSON.stringify(args.on)}`);
    return 2;
  }
  if (args.level !== undefined) {
    err("review spends a model call on a comment, so the commenter's level is read from GitHub: pass --repo, not --level.");
    return 2;
  }
  if (args.repo === undefined) {
    err("review needs --repo, the repository the commenter's level is read on.");
    return 2;
  }
  if (`${on.owner}/${on.repo}`.toLowerCase() !== args.repo.toLowerCase()) {
    err(`--on ${args.on} is not in --repo ${args.repo}; the request and the mandate's repository must be the same.`);
    return 2;
  }
  const minLevel = args.minLevel ?? DEFAULT_MIN_LEVEL;
  if (!(USER_LEVELS as readonly string[]).includes(minLevel)) {
    err(`--min-level must be one of ${USER_LEVELS.join(", ")}`);
    return 2;
  }
  const maxPerHour = args.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
  if (!Number.isInteger(maxPerHour) || maxPerHour < 1) {
    err("--max-per-hour must be a whole number of at least 1");
    return 2;
  }
  if (deps.resolve === undefined || deps.comments === undefined) {
    err("review reads the commenter's level and posts to GitHub: set MANDATE_APP_ID, MANDATE_INSTALLATION_ID and MANDATE_APP_KEY_PATH.");
    return 2;
  }
  if (deps.write === undefined) {
    err("review writes a mandate with the model: set ANTHROPIC_API_KEY.");
    return 2;
  }
  let task: string;
  try {
    task = readFileSync(args.taskFile, "utf8").trim();
  } catch (e) {
    err(`Could not read the task from ${args.taskFile}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (task.length === 0) {
    err("The task is empty.");
    return 2;
  }
  let ceiling: Ceiling;
  try {
    ceiling = loadCeiling(
      ceilingLabel(args.ceiling), readFileSync(args.ceiling, "utf8"),
      readFileSync(args.schema, "utf8"), readFileSync(args.destinations, "utf8"),
    );
  } catch (e) {
    err(`Could not load the ceiling: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  // ---- who is asking: read, never asserted, before any model call -------
  const resolved = await resolveAuthority({ as: args.as, repo: args.repo }, { resolve: deps.resolve });
  if ("error" in resolved) {
    err(resolved.error);
    return 2;
  }
  err(resolved.provenance);
  const { login, level } = resolved.authority;
  if (!atLeast(level, minLevel as UserLevel)) {
    err(`${login} has ${level} on ${args.repo}; requesting a mandate needs ${minLevel}. Nothing was written.`);
    return 1;
  }

  // ---- how many the App has written this hour, from its own comments ------
  const now = (deps.now ?? (() => new Date()))();
  const from = new Date(now.getTime() - HOUR_MS);
  const bot = (await deps.comments.botLogin()).toLowerCase();
  const recent = await deps.comments.since(on.owner, on.repo, from.toISOString());
  const written = recent.filter((c) => c.author.toLowerCase() === bot
    && c.body.startsWith(REVIEW_MARKER) && Date.parse(c.createdAt) >= from.getTime()).length;
  if (written >= maxPerHour) {
    err(`The App has written ${written} mandate(s) on ${args.repo} in the last hour; the limit is ${maxPerHour}. Nothing was written.`);
    return 1;
  }

  // ---- the paid part ------------------------------------------------------
  const deliver = async (body: string): Promise<void> => {
    if (args.post === true) {
      const posted = await deps.comments!.post(on, body);
      err(`Posted ${posted.url}`);
    } else {
      out(body);
    }
  };

  let proposed: ProposedMandate;
  try {
    proposed = await deps.write({
      task, repo: args.repo, requestedBy: `user:${login}`, ceiling, issueNumber: on.number,
    });
  } catch (e) {
    if (!(e instanceof WriterError)) throw e;
    await deliver(writerFailedBody(login, e.message));
    err(`No mandate was written: ${e.message}`);
    return 1;
  }

  const decision = validate(proposed, { ceiling, authority: resolved.authority });
  if (!decision.ok) {
    await deliver(rejectedBody(login, renderRejections(decision.rejections, proposed)));
    err("The writer's proposal was rejected; nothing can be approved.");
    return 1;
  }

  const mandate = decision.mandate;
  const proof = proofOf(mandate);
  const digest = approvalDigest(mandate, proof.ceilingSha256, mandate.requestedBy);
  await deliver(approvalBody({
    login, level, repo: args.repo, digest,
    ceilingLabel: proof.ceilingId, ceilingSha256: proof.ceilingSha256,
    diff: renderPermissionDiff(proposed, { color: false }),
    // JSON first: it drops the ValidatedMandate's symbol brand.
    yaml: stringify(JSON.parse(JSON.stringify(mandate))),
  }));
  return 0;
}

/**
 * A fence longer than any run of backticks in what it holds, so text from a
 * comment cannot close it and write markdown under the App's name.
 */
const fenceFor = (...contents: readonly string[]): string => {
  const longest = Math.max(0, ...contents.flatMap((c) => [...c.matchAll(/`+/g)].map((m) => m[0].length)));
  return "`".repeat(Math.max(3, longest + 1));
};

function approvalBody(p: {
  readonly login: string; readonly level: string; readonly repo: string; readonly digest: string;
  readonly ceilingLabel: string; readonly ceilingSha256: string; readonly diff: string; readonly yaml: string;
}): string {
  const f = fenceFor(p.diff, p.yaml);
  return [
    `${REVIEW_MARKER} digest=${p.digest} -->`,
    `**A mandate for @${p.login}**, proved inside ceiling \`${p.ceilingLabel}\` `
    + `(sha256 \`${p.ceilingSha256}\`). ${p.login}'s level on ${p.repo}, ${p.level}, was read from GitHub.`,
    "",
    `${f}text`, p.diff.trimEnd(), f,
    "",
    "To approve exactly this mandate, reply with this line on its own:",
    "",
    `\`${approvalLine(p.digest)}\``,
    "",
    "Nothing is minted until you do. An edited mandate, another ceiling or another requester needs "
    + "a new approval. An approval stands until you delete your comment.",
    "",
    "<details><summary>The mandate</summary>",
    "",
    `${f}yaml`, p.yaml.trimEnd(), f,
    "",
    "</details>",
  ].join("\n");
}

function rejectedBody(login: string, rejections: string): string {
  const f = fenceFor(rejections);
  return [
    `${REVIEW_MARKER} digest=none -->`,
    `**No mandate for @${login}.** The validator rejected the writer's proposal, so there is nothing to approve.`,
    "",
    `${f}text`, rejections.trimEnd(), f,
  ].join("\n");
}

function writerFailedBody(login: string, message: string): string {
  const f = fenceFor(message);
  return [
    `${REVIEW_MARKER} digest=none -->`,
    `**No mandate was written for @${login}.** The writer stopped:`,
    "",
    `${f}text`, message, f,
  ].join("\n");
}
