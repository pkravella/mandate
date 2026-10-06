#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runValidate, USER_LEVELS, type ValidateArgs } from "./commands/validate.js";

export { runValidate, USER_LEVELS, type ValidateArgs } from "./commands/validate.js";
export {
  authorityCut, derivedNotGrantedNotable, renderPermissionDiff, renderRejections,
  BASELINE_TOKEN, type AuthorityCut, type DiffOptions, type LayerCut,
} from "./diff.js";

/** Only runs when this file is the entry point, so importing it is side-effect free. */
export function main(argv: readonly string[]): void {
  const program = new Command();
  program.name("mandate").description("Task-scoped authority for AI agents").version("0.1.0");
  program.exitOverride();

  program
    .command("validate")
    .argument("<file>", "mandate YAML file")
    .requiredOption("--ceiling <path>", "Cedar ceiling policy file")
    .requiredOption("--schema <path>", "Cedar schema file")
    .requiredOption(
      "--ceiling-destinations <path>",
      "the ceiling's allowed-destination list; an empty file permits no destination",
    )
    .requiredOption("--as <login>", "the requesting user's GitHub login")
    .option("--level <level>", `the user's repository permission level (${USER_LEVELS.join("|")})`, "push")
    .option("--repositories <n>", "organization repository count for the authority-cut baseline")
    .option("--no-color", "plain output")
    .action((file: string, opts: {
      ceiling: string; schema: string; ceilingDestinations: string;
      as: string; level: string;
      repositories?: string; color?: boolean;
    }) => {
      const repositories = opts.repositories === undefined
        ? undefined
        : Number.parseInt(opts.repositories, 10);
      if (repositories !== undefined && (!Number.isInteger(repositories) || repositories < 1)) {
        console.log("--repositories must be a positive integer");
        process.exitCode = 2;
        return;
      }
      const args: ValidateArgs = {
        file, ceiling: opts.ceiling, schema: opts.schema,
        destinations: opts.ceilingDestinations, as: opts.as,
        level: opts.level,
        ...(repositories === undefined ? {} : { repositories }),
        ...(opts.color === undefined ? {} : { color: opts.color }),
      };
      process.exitCode = runValidate(args, (s) => { console.log(s); });
    });

  program.parse(argv, { from: "user" });
}

/**
 * Run only when this file is the process entry point, so the package can also
 * be imported (the Vitest alias resolves `@mandate-dev/cli` to this file).
 */
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) main(process.argv.slice(2));
