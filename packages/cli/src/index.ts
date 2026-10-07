#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runValidate, type ValidateArgs } from "./commands/validate.js";
import { githubResolver, resolveAuthority, USER_LEVELS } from "./authority.js";
import { runWiden } from "./commands/widen.js";

export { runValidate, type ValidateArgs } from "./commands/validate.js";
export {
  githubResolver, resolveAuthority, USER_LEVELS,
  type AuthorityDeps, type AuthoritySource, type ResolveAuthority, type ResolvedAuthority,
} from "./authority.js";
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
    .option(
      "--repo <owner/name>",
      "read --as's permission from GitHub; needs MANDATE_APP_ID, "
      + "MANDATE_INSTALLATION_ID and MANDATE_APP_KEY_PATH",
    )
    .option(
      "--level <level>",
      `assert --as's permission level (${USER_LEVELS.join("|")}); labelled unverified in the `
      + "output. Pass this or --repo, not both",
    )
    .option("--repositories <n>", "organization repository count for the authority-cut baseline")
    .option("--no-color", "plain output")
    .action(async (file: string, opts: {
      ceiling: string; schema: string; ceilingDestinations: string;
      as: string; level?: string; repo?: string;
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
        ...(opts.level === undefined ? {} : { level: opts.level }),
        ...(opts.repo === undefined ? {} : { repo: opts.repo }),
        ...(repositories === undefined ? {} : { repositories }),
        ...(opts.color === undefined ? {} : { color: opts.color }),
      };
      const resolve = githubResolver();
      process.exitCode = await runValidate(
        args, (s) => { console.log(s); },
        resolve === undefined ? {} : { resolve },
      );
    });

  program
    .command("widen")
    .description("re-validate a mandate with a widen request applied (R10)")
    .argument("<mandate>", "the current mandate YAML")
    .argument("<request>", "the pause record the proxy emitted, or a bare widen request")
    .requiredOption("--ceiling <path>", "Cedar ceiling policy file")
    .requiredOption("--schema <path>", "Cedar schema file")
    .requiredOption(
      "--ceiling-destinations <path>",
      "the ceiling's allowed-destination list; an empty file permits no destination",
    )
    .requiredOption("--as <login>", "the requesting user's GitHub login")
    .option(
      "--repo <owner/name>",
      "read --as's permission from GitHub; needs MANDATE_APP_ID, "
      + "MANDATE_INSTALLATION_ID and MANDATE_APP_KEY_PATH",
    )
    .option(
      "--level <level>",
      `assert --as's permission level (${USER_LEVELS.join("|")}); labelled unverified in the `
      + "output. Pass this or --repo, not both",
    )
    .action(async (mandateFile: string, requestFile: string, opts: {
      ceiling: string; schema: string; ceilingDestinations: string;
      as: string; level?: string; repo?: string;
    }) => {
      // The same decision as `validate`, taken by the same function. A widen
      // re-validates the whole mandate from scratch, so it must be decided
      // against the same authority and say so the same way.
      const resolve = githubResolver();
      const resolved = await resolveAuthority(
        { as: opts.as, level: opts.level, repo: opts.repo },
        resolve === undefined ? {} : { resolve },
      );
      if ("error" in resolved) {
        console.log(resolved.error);
        process.exitCode = 2;
        return;
      }
      const code = runWiden({
        mandateFile, requestFile,
        ceiling: opts.ceiling, schema: opts.schema,
        destinations: opts.ceilingDestinations, as: opts.as,
        level: resolved.authority.level,
      }, (s) => { console.log(s); });
      console.log(resolved.provenance);
      process.exitCode = code;
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
