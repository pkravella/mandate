import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPermissionDiff, renderRejections } from "../diff.js";
import { prepareMandate, type PrepareArgs } from "../prepare.js";
import type { AuthorityDeps } from "../authority.js";
import {
  checkSandboxInputs, CONTAINER_MCP_CONFIG, defaultStartServe, runSandboxed,
  type SandboxArgs, type StartServe,
} from "../sandbox.js";

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
export interface RunArgs extends PrepareArgs, SandboxArgs {
  /** The agent command and its arguments, after `--`. */
  readonly agent: readonly string[];
  /**
   * Run the agent in the sandbox container instead of on the host. Off by
   * default while it is new; see sandbox.ts for what it changes.
   */
  readonly sandbox?: boolean | undefined;
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
  /** Starts `mandate serve --listen` on the host, for --sandbox. Injected so tests mint nothing. */
  readonly startServe?: StartServe;
  /** The repository the sandbox clones HEAD from. Defaults to the process's. */
  readonly cwd?: string;
  /** Defaults to `process.platform`; --sandbox refuses off macOS. */
  readonly platform?: string;
  /** The operator's environment. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether to give the container a TTY. Defaults to whether stdin is one. */
  readonly tty?: boolean;
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

  // Checked before validation: none of these needs the mandate, and a run
  // that is going to be refused should not get as far as reading it.
  if (args.sandbox === true) {
    const refusal = checkSandboxInputs(args, deps.platform ?? process.platform);
    if (refusal !== undefined) {
      log(refusal);
      return 2;
    }
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

  /**
   * The entry point the agent's config will name.
   *
   * `../index.js` is right in the shipped layout — `dist/commands/run.js` sits
   * beside `dist/index.js` — and wrong anywhere that layout does not hold, such
   * as a checkout that has not been built. Checked rather than assumed, because
   * the failure otherwise surfaces as a MODULE_NOT_FOUND thrown inside the
   * agent's MCP client, followed by "Connection closed": two errors, neither of
   * which names the actual problem. Measured on the first live run.
   */
  const self = deps.selfPath ?? fileURLToPath(new URL("../index.js", import.meta.url));
  if (!existsSync(self)) {
    log(
      `Cannot find the mandate entry point at ${self}, so the agent would be given a `
      + "config naming a file that does not exist. Run `pnpm build`, or pass the built "
      + "entry point explicitly.",
    );
    return 2;
  }
  const serveArgs = serveArgvFor(args, self);

  if (args.sandbox === true) {
    if (!args.agent.slice(1).some((a) => a.includes(MCP_CONFIG_PLACEHOLDER))) {
      log(
        `The agent command does not mention ${MCP_CONFIG_PLACEHOLDER}, so it will only find `
        + "the enforced server if it reads MANDATE_MCP_CONFIG from the environment.",
      );
    }
    return runSandboxed({
      mandate: prepared.mandate,
      serveArgv: serveArgs,
      args,
      agent: [command, ...args.agent.slice(1).map(
        (a) => a.split(MCP_CONFIG_PLACEHOLDER).join(CONTAINER_MCP_CONFIG),
      )],
      cwd: deps.cwd ?? process.cwd(),
      env: deps.env ?? process.env,
      tty: deps.tty ?? process.stdin.isTTY === true,
      startServe: deps.startServe ?? defaultStartServe,
      launch: deps.launch ?? defaultLaunch,
    }, log);
  }

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

/**
 * `<entry> serve` on the same inputs `mandate run` validated, every path
 * absolute.
 *
 * Without the sandbox the agent spawns this from its own working directory, so
 * a relative path would resolve against the agent's cwd rather than the
 * operator's: at best the ceiling is not found, at worst a different file with
 * the same relative name is enforced in place of the one that was approved.
 * Found by running the real binary rather than the test stub. With the sandbox,
 * `mandate run` starts it itself, from the same argv.
 */
function serveArgvFor(args: RunArgs, self: string): string[] {
  return [
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
}
