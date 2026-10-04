import { readFileSync } from "node:fs";
import { parseMandateYaml, type ProposedMandate } from "@mandate-dev/schema";
import { loadCeiling, validate, type Ceiling, type UserAuthority } from "@mandate-dev/validator";
import { renderPermissionDiff, renderRejections } from "../diff.js";

export interface ValidateArgs {
  readonly file: string;
  readonly ceiling: string;
  readonly schema: string;
  readonly as: string;
  readonly level: UserAuthority["level"];
  /** Organization repository count for the authority-cut baseline (D7). */
  readonly repositories?: number;
  readonly color?: boolean;
}

export const USER_LEVELS = ["none", "pull", "triage", "push", "maintain", "admin"] as const;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Returns the process exit code: 0 accepted, 1 rejected, 2 bad input. */
export function runValidate(args: ValidateArgs, log: (s: string) => void): number {
  if (!(USER_LEVELS as readonly string[]).includes(args.level)) {
    log(`--level must be one of ${USER_LEVELS.join(", ")}, not ${JSON.stringify(args.level)}`);
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
    );
  } catch (e) {
    log(`Could not load the ceiling: ${message(e)}`);
    return 2;
  }

  const result = validate(proposed, {
    ceiling,
    authority: { login: args.as, level: args.level },
  });
  if (!result.ok) {
    log(renderRejections(result.rejections, proposed));
    return 1;
  }

  log(renderPermissionDiff(proposed, {
    ...(args.color === undefined ? {} : { color: args.color }),
    ...(args.repositories === undefined ? {} : { repositories: args.repositories }),
  }));
  return 0;
}
