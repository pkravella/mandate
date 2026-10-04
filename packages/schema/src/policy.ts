import { getOperation } from "@mandate-dev/catalog";

// Contract-level facts about what a mandate must restrict. These live in
// `schema` rather than in the validator's lint module because two packages
// need them and they describe the contract, not one checker's opinion of it:
// the validator rejects a mandate that omits them (R4), and the writer has to
// include them or every mandate it proposes is rejected. One definition, two
// readers.

/**
 * The minimum a grant that writes files must exclude.
 *
 * Note the dotenv pattern is the character-wise form, not the segment-aware
 * basename form. A Cedar ceiling expresses path patterns character-wise, so
 * its dotenv deny means "any path containing .env". The PRD's example mandate
 * uses the segment-aware form, which is strictly weaker and does not validate.
 *
 * (Written as line comments deliberately: the segment-aware pattern contains
 * the sequence that terminates a block comment.)
 */
export const SENSITIVE_PATHS: readonly string[] = [".github/workflows/**", "**.env**"];

/**
 * Operations that create outward-facing side effects and therefore need a
 * `max`. Every member must list "max" in its catalog `constrainable` set,
 * otherwise a checker demands a field the schema refuses and the grant becomes
 * unsatisfiable. An invariant test in the validator pins that.
 */
export const SIDE_EFFECTING: ReadonlySet<string> = new Set([
  "pull_request.create", "pull_request.comment", "pull_request.update",
  "pull_request.review", "pull_request.merge", "pull_request.close",
  "issue.create", "issue.comment", "issue.update", "issue.close",
  "issue.label", "issue.assign",
  "actions.write", "releases.write", "repo.create", "repo.fork", "gist.write",
]);

/**
 * Whether a grant on this action puts bytes into the repository, and so is
 * held to the branch and deny-path rules. Unknown actions are not file writes:
 * they are rejected elsewhere, and answering "yes" here would make the
 * rejection message about the wrong thing.
 */
export function writesFiles(action: string): boolean {
  const op = getOperation(action);
  return op !== undefined && op.permissionLevel === "write" && op.resourceType === "path";
}
