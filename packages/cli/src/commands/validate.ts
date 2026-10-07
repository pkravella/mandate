import { readFileSync } from "node:fs";
import { parseMandateYaml, type ProposedMandate } from "@mandate-dev/schema";
import { loadCeiling, validate, type Ceiling } from "@mandate-dev/validator";
import { renderPermissionDiff, renderRejections } from "../diff.js";
import { resolveAuthority, type AuthorityDeps } from "../authority.js";

export interface ValidateArgs {
  readonly file: string;
  readonly ceiling: string;
  readonly schema: string;
  /**
   * The ceiling's destination allowlist (R9). Required, not inferred from the
   * ceiling's path: destinations went unchecked until now precisely because
   * nothing made an operator aware the list existed, and an empty list permits
   * nothing. Point it at an empty file to say "no data may leave" deliberately.
   */
  readonly destinations: string;
  readonly as: string;
  /**
   * The repository to look the requester's level up on, as `owner/name`.
   *
   * Exactly one of `repo` and `level` must be given. This one makes the output
   * an authorisation record: the level is read from GitHub rather than asserted.
   */
  readonly repo?: string;
  /**
   * An ASSERTED level, which the output labels as unverified.
   *
   * A string, because that is what a command line supplies. `runValidate`
   * checks it against USER_LEVELS and returns exit 2 if it is not one — an
   * unrecognised value otherwise made `atLeast()` false for everything and
   * every grant was rejected for "user authority" with nothing naming the flag.
   *
   * It used to default to `push`, so every run asserted push authority and
   * nothing in the output said so. There is no default now: an operator who
   * has not said where the level came from has not been asked the question.
   */
  readonly level?: string;
  /** Organization repository count for the authority-cut baseline (D7). */
  readonly repositories?: number;
  readonly color?: boolean;
}

// USER_LEVELS and the authority decision live in ../authority.ts, because
// `widen` takes --as and --level too and two copies of an authority decision
// is how one of them stops matching the other.
export { USER_LEVELS, type ResolveAuthority } from "../authority.js";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Returns the process exit code: 0 accepted, 1 rejected, 2 bad input. */
export async function runValidate(
  args: ValidateArgs, log: (s: string) => void, deps: AuthorityDeps = {},
): Promise<number> {
  const resolved = await resolveAuthority(args, deps);
  if ("error" in resolved) {
    log(resolved.error);
    return 2;
  }

  let proposed: ProposedMandate;
  try {
    proposed = parseMandateYaml(readFileSync(args.file, "utf8"));
  } catch (e) {
    log(`Could not read a mandate from ${args.file}: ${message(e)}`);
    return 2;
  }

  let ceiling: Ceiling;
  try {
    ceiling = loadCeiling(
      proposed.ceiling,
      readFileSync(args.ceiling, "utf8"),
      readFileSync(args.schema, "utf8"),
      readFileSync(args.destinations, "utf8"),
    );
  } catch (e) {
    log(`Could not load the ceiling: ${message(e)}`);
    return 2;
  }

  const result = validate(proposed, { ceiling, authority: resolved.authority });
  if (!result.ok) {
    log(renderRejections(result.rejections, proposed));
    log(resolved.provenance);
    return 1;
  }

  log(resolved.provenance);
  log(renderPermissionDiff(proposed, {
    ...(args.color === undefined ? {} : { color: args.color }),
    ...(args.repositories === undefined ? {} : { repositories: args.repositories }),
  }));
  return 0;
}
