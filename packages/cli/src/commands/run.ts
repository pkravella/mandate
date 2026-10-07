import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPermissionDiff, renderRejections } from "../diff.js";
import { prepareMandate, type PrepareArgs } from "../prepare.js";
import type { AuthorityDeps } from "../authority.js";

/**
 * `mandate run` — validate a mandate, then launch an agent that can only reach
 * GitHub through it.
 *
 * It does not drive Claude Code, or Codex, or any particular agent. It writes
 * an MCP server config pointing at `mandate serve` and launches the command the
 * operator gives it:
 *
 *   mandate run --mandate m.yaml ... -- claude --mcp-config {mcpConfig} -p "fix #42"
 *
 * The plan said this command "runs `mandate run`" and never said what that was.
 * Driving a named agent would have meant a bespoke adapter per vendor, only
 * testable by paying a real agent to run, and a claim that stops being true the
 * moment a vendor changes its flags. Every MCP client already knows how to
 * start a server from a config, so being that server is the whole integration —
 * and it is what makes PRD goal 5, vendor neutrality, true rather than
 * aspirational.
 *
 * The honest cost of this choice: Mandate guarantees the agent's *only* GitHub
 * authority is the mandate's, but it cannot stop an agent that has another
 * credential of its own. That is R9b's job — the sandbox — and
 * docs/enforced-where.md says so.
 *
 * `{mcpConfig}` is substituted in the agent's argv, and `MANDATE_MCP_CONFIG` is
 * set in its environment, so an agent that takes a flag and one that reads an
 * env var are both reachable without Mandate knowing which is which.
 */
export interface RunArgs extends PrepareArgs {
  /** The agent command and its arguments, after `--`. */
  readonly agent: readonly string[];
  /** Where to write the action graph. R8. */
  readonly trace?: string | undefined;
  /** Print the permission diff before launching. */
  readonly diff?: boolean | undefined;
}

export interface RunDeps extends AuthorityDeps {
  /**
   * Launches the agent. Injected so the command is testable without an agent:
   * the default spawns a real subprocess, and a test can assert on what it
   * would have been handed.
   */
  readonly launch?: (
    command: string, argv: readonly string[], env: Readonly<Record<string, string>>,
  ) => Promise<number>;
  /** Path to the `mandate` entry point the config should point at. */
  readonly selfPath?: string;
}

/** The placeholder substituted with the config path in the agent's argv. */
export const MCP_CONFIG_PLACEHOLDER = "{mcpConfig}";

const defaultLaunch = (
  command: string, argv: readonly string[], env: Readonly<Record<string, string>>,
): Promise<number> =>
  new Promise<number>((resolve) => {
    const child = spawn(command, [...argv], {
      // The agent inherits the terminal. It is an interactive tool and the
      // operator is watching it; capturing its output to re-print would only
      // break its rendering.
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => resolve(signal !== null ? 128 : code ?? 0));
  });

/** Returns the process exit code: the agent's, or 1 refused, or 2 bad input. */
export async function runRun(
  args: RunArgs, log: (s: string) => void, deps: RunDeps = {},
): Promise<number> {
  const command = args.agent[0];
  if (command === undefined) {
    log(
      "No agent command. Put it after `--`, for example:\n"
      + `  mandate run --mandate m.yaml ... -- claude --mcp-config ${MCP_CONFIG_PLACEHOLDER} `
      + '-p "fix issue 42"',
    );
    return 2;
  }

  // Validated BEFORE anything is launched and before a token could be minted.
  // The agent must never start against a mandate that was not proved to sit
  // inside the ceiling, because at that point its authority is unbounded by
  // anything Mandate decided.
  const prepared = await prepareMandate(args, deps);
  if (!prepared.ok) {
    if (prepared.code === 1) {
      log(renderRejections(prepared.rejections, prepared.proposed));
      log(prepared.provenance);
      log("Nothing was minted and no agent was launched.");
      return 1;
    }
    log(prepared.message);
    return 2;
  }

  log(prepared.provenance);
  if (args.diff === true) log(renderPermissionDiff(prepared.proposed, { color: false }));

  const self = deps.selfPath ?? fileURLToPath(new URL("../index.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "mandate-run-"));
  const configPath = join(dir, "mcp.json");

  /**
   * The config names the mandate and the ceiling, never the token.
   *
   * `mandate serve` mints its own credential in its own process, so the file
   * the agent reads — and can read, since it is handed the path — carries no
   * secret. Writing a token here would put a live repository-scoped credential
   * on disk, readable by the very process whose authority it is meant to bound.
   */
  /**
   * Every path is resolved here, because the agent spawns `mandate serve`
   * itself from whatever working directory it happens to have. A relative path
   * would resolve against the agent's cwd rather than the operator's: at best
   * the ceiling is not found, at worst a different file with the same relative
   * name is loaded and enforced in place of the one that was approved.
   *
   * Found by running the real binary rather than the test stub, which had been
   * passing absolute fixture paths and so could not see it.
   */
  const serveArgs = [
    self, "serve",
    "--mandate", resolve(args.file),
    "--ceiling", resolve(args.ceiling),
    "--schema", resolve(args.schema),
    "--ceiling-destinations", resolve(args.destinations),
    "--as", args.as,
    ...(args.repo !== undefined ? ["--repo", args.repo] : []),
    ...(args.level !== undefined ? ["--level", args.level] : []),
    ...(args.trace !== undefined ? ["--trace", resolve(args.trace)] : []),
  ];
  const config = {
    mcpServers: {
      github: { command: process.execPath, args: serveArgs },
    },
  };

  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const argv = args.agent.slice(1).map(
      (a) => a.split(MCP_CONFIG_PLACEHOLDER).join(configPath),
    );
    if (!args.agent.slice(1).some((a) => a.includes(MCP_CONFIG_PLACEHOLDER))) {
      log(
        `The agent command does not mention ${MCP_CONFIG_PLACEHOLDER}, so it will only find `
        + "the enforced server if it reads MANDATE_MCP_CONFIG from the environment. If it "
        + "takes a flag instead, pass the placeholder where the path belongs.",
      );
    }

    log(`Launching ${command} with the enforced server at ${configPath}.`);
    const code = await (deps.launch ?? defaultLaunch)(
      command, argv, { MANDATE_MCP_CONFIG: configPath },
    );
    log(`${command} exited ${code}.`);
    return code;
  } finally {
    // The config is a temporary file naming the operator's paths. It carries no
    // secret, but leaving a directory per run in the temp dir is litter.
    rmSync(dir, { recursive: true, force: true });
  }
}
