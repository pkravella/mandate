#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { runValidate, type ValidateArgs } from "./commands/validate.js";
import { githubResolver, resolveAuthority, USER_LEVELS } from "./authority.js";
import { runServe } from "./commands/serve.js";
import { runRun, MCP_CONFIG_PLACEHOLDER } from "./commands/run.js";
import { githubAppDeps, type MintDeps } from "@mandate-dev/compiler";
import { runWiden } from "./commands/widen.js";

export { runValidate, type ValidateArgs } from "./commands/validate.js";
export {
  openSession, dockerUpstream, type Session, type SessionOptions,
} from "./session.js";
export { runServe, type ServeArgs, type ServeDeps } from "./commands/serve.js";
export {
  runRun, MCP_CONFIG_PLACEHOLDER, type RunArgs, type RunDeps,
} from "./commands/run.js";
export { prepareMandate, type PrepareArgs, type Prepared } from "./prepare.js";
export {
  githubResolver, resolveAuthority, USER_LEVELS,
  type AuthorityDeps, type AuthoritySource, type ResolveAuthority, type ResolvedAuthority,
} from "./authority.js";
export {
  authorityCut, derivedNotGrantedNotable, renderPermissionDiff, renderRejections,
  BASELINE_TOKEN, type AuthorityCut, type DiffOptions, type LayerCut,
} from "./diff.js";


/**
 * The flags every command that reads a mandate takes.
 *
 * Declared once because `validate`, `serve` and `run` must name them
 * identically: an operator who validated with one spelling and served with
 * another would be enforcing a mandate they never approved.
 */
const mandateOptions = (c: Command): Command => c
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
  );

/**
 * The App credentials `serve` needs to mint. Absent is a clear refusal rather
 * than a failure inside the first request.
 */
const appDeps = (): MintDeps | undefined => {
  const appId = process.env["MANDATE_APP_ID"];
  const installationId = process.env["MANDATE_INSTALLATION_ID"];
  const privateKeyPath = process.env["MANDATE_APP_KEY_PATH"];
  if (appId === undefined || installationId === undefined || privateKeyPath === undefined) {
    return undefined;
  }
  return githubAppDeps({ appId, installationId: Number(installationId), privateKeyPath });
};

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

  mandateOptions(
    program
      .command("serve")
      .description("serve an enforced MCP server for one mandate (what an agent spawns)")
      .requiredOption("--mandate <file>", "the validated mandate YAML"),
  )
    .option("--trace <path>", "write the action graph here when the session ends (R8)")
    .option(
      "--listen <ip:port>",
      "serve one sandboxed agent over TCP instead of stdio; the relay presents MANDATE_RELAY_SECRET",
    )
    .option("--ready-file <path>", "with --listen: write {host, port} here once listening")
    .action(async (opts: {
      mandate: string; ceiling: string; schema: string; ceilingDestinations: string;
      as: string; level?: string; repo?: string; trace?: string;
      listen?: string; readyFile?: string;
    }) => {
      // stdout is the JSON-RPC stream. Every diagnostic goes to stderr, or the
      // agent sees a parse error instead of a tool list.
      const log = (m: string): void => { process.stderr.write(`${m}\n`); };
      const github = appDeps();
      if (github === undefined) {
        log(
          "mandate serve needs GitHub App credentials to mint the agent's token. Set "
          + "MANDATE_APP_ID, MANDATE_INSTALLATION_ID and MANDATE_APP_KEY_PATH.",
        );
        process.exitCode = 2;
        return;
      }
      const resolve = githubResolver();
      process.exitCode = await runServe({
        file: opts.mandate, ceiling: opts.ceiling, schema: opts.schema,
        destinations: opts.ceilingDestinations, as: opts.as,
        ...(opts.level === undefined ? {} : { level: opts.level }),
        ...(opts.repo === undefined ? {} : { repo: opts.repo }),
        ...(opts.trace === undefined ? {} : { trace: opts.trace }),
        ...(opts.listen === undefined ? {} : { listen: opts.listen }),
        ...(opts.readyFile === undefined ? {} : { readyFile: opts.readyFile }),
      }, log, {
        github,
        ...(resolve === undefined ? {} : { resolve }),
        // From the environment, never a flag: argv is readable by every process.
        relaySecret: process.env["MANDATE_RELAY_SECRET"],
      });
    });

  mandateOptions(
    program
      .command("run")
      .description("validate a mandate, then launch an agent that can only reach GitHub through it")
      .requiredOption("--mandate <file>", "the mandate YAML")
      .argument("[agent...]", `the agent command, after --. Use ${MCP_CONFIG_PLACEHOLDER} where it wants the MCP config path`),
  )
    .option("--trace <path>", "write the action graph here when the session ends (R8)")
    .option("--diff", "print the permission diff before launching")
    .action(async (agent: string[], opts: {
      mandate: string; ceiling: string; schema: string; ceilingDestinations: string;
      as: string; level?: string; repo?: string; trace?: string; diff?: boolean;
    }) => {
      const resolve = githubResolver();
      process.exitCode = await runRun({
        file: opts.mandate, ceiling: opts.ceiling, schema: opts.schema,
        destinations: opts.ceilingDestinations, as: opts.as, agent,
        ...(opts.level === undefined ? {} : { level: opts.level }),
        ...(opts.repo === undefined ? {} : { repo: opts.repo }),
        ...(opts.trace === undefined ? {} : { trace: opts.trace }),
        ...(opts.diff === undefined ? {} : { diff: opts.diff }),
      }, (m) => { console.log(m); }, resolve === undefined ? {} : { resolve });
    });

  // exitOverride makes commander throw where it would have called
  // process.exit, and nothing caught it: help, --version and every usage error
  // printed a stack trace and exited 1. By the time it throws, commander has
  // already written the help, the version or its error message, so only the
  // exit code is left to decide -- 0 for what was asked for, and 2 for bad
  // input, as every command documents. 1 means a refused mandate, and a
  // mistyped flag must not read as one.
  try {
    program.parse(argv, { from: "user" });
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    process.exitCode = e.code === "commander.helpDisplayed" || e.code === "commander.version"
      ? 0
      : 2;
  }
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
