import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileEgress, EgressCompileError } from "@mandate-dev/compiler";
import type { ValidatedMandate } from "@mandate-dev/schema";
import { prepareWorkspace, WorkspaceError } from "./workspace.js";

/**
 * `mandate run --sandbox`: the agent in the container, `mandate serve` on the
 * host (Task 5.1 b).
 *
 * Without the sandbox the agent spawns serve itself, from an MCP config, with
 * the environment `mandate run` gave it -- which names the App key, readable by
 * the agent's own uid. Here the agent cannot spawn serve: `mandate run` starts
 * it on the host, listening for the container's relay, and the container is
 * built from an allowlist:
 *
 * - its working copy is a clone of HEAD, mounted read-only and copied in, so no
 *   host `.git`, hook or ignored `.env` reaches it (workspace.ts);
 * - its environment is the relay's channel plus the variables the operator
 *   names with `--pass-env`, and a name that is a known credential is refused;
 * - its egress is the mandate's destinations plus the operator's agent hosts,
 *   without the GitHub API hosts it no longer needs (egress.ts).
 *
 * Every value reaches docker through its environment, named in argv as
 * `-e NAME`. argv is readable by every process on the host.
 */

/** Where the agent's MCP config is inside the container. */
export const CONTAINER_MCP_CONFIG = "/run/mandate-config/mcp.json";
const CONTAINER_CONFIG_DIR = "/run/mandate-config";
/** The read-only mount of the clone; the entrypoint copies it to the agent's home. */
const CONTAINER_WORKSPACE_MOUNT = "/mnt/mandate-workspace";
/** The agent's MCP command inside the container. Holds no secret. */
const CONTAINER_SHIM = "/usr/local/lib/mandate-mcp.mjs";
/** How the container reaches the host. Docker Desktop's name for it. */
const RELAY_HOST = "host.docker.internal";

export interface ServeHandle {
  /** The port serve listens on, read from its ready file. */
  readonly port: number;
  /** Signals serve to end the session -- trace, then revoke -- and resolves with its exit code. */
  stop(): Promise<number>;
}

/** Starts `mandate serve --listen` on the host. Injected so tests mint nothing. */
export type StartServe = (
  argv: readonly string[], env: Readonly<Record<string, string>>, abort?: AbortSignal,
) => Promise<ServeHandle>;

export interface SandboxArgs {
  readonly image?: string | undefined;
  readonly agentEgress?: readonly string[] | undefined;
  readonly passEnv?: readonly string[] | undefined;
}

/**
 * Variables that must never be passed into the sandbox, whatever the operator
 * asks. Each is a credential the sandbox exists to keep from the agent, or
 * one of Mandate's own.
 */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "SSH_AUTH_SOCK",
]);

/** Why `name` may not be passed into the sandbox, or undefined if it may. */
export function refusedPassEnv(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return `--pass-env ${JSON.stringify(name)} is not a variable name; pass the name and set `
      + "the value in your environment, so it never appears in a command line";
  }
  // Exact names were not enough -- HOMEBREW_GITHUB_API_TOKEN is a GitHub token
  // so any name mentioning GitHub, or in the GH_ family, is refused too. The
  // operator is trusted; this is the refusal saying what it claims to cover.
  if (CREDENTIAL_NAMES.has(name) || /GITHUB/i.test(name) || /(^|_)GH_/i.test(name)) {
    return `--pass-env ${name} would hand the agent a credential the sandbox exists to keep from it`;
  }
  if (name.startsWith("MANDATE_")) {
    return `--pass-env ${name}: Mandate's own variables -- the App credentials, the relay `
      + "secret -- never enter the sandbox";
  }
  return undefined;
}

/** Input checks that need nothing minted or validated. A message, or undefined. */
export function checkSandboxInputs(args: SandboxArgs, platform: string): string | undefined {
  if (args.image === undefined || args.image.length === 0) {
    return "--sandbox needs --image: an image built FROM mandate-sandbox with your agent installed";
  }
  if (platform !== "darwin") {
    return "--sandbox runs on macOS (Docker Desktop) only for now. On Linux the relay needs "
      + "host-gateway and serve must bind the bridge address; that path is unprobed, and "
      + "Mandate does not claim a sandbox nobody has run";
  }
  for (const name of args.passEnv ?? []) {
    const why = refusedPassEnv(name);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** Polls for serve's ready file, or its exit. Minting takes a GitHub round trip. */
export const defaultStartServe: StartServe = (argv, env, abort) => new Promise((resolve, reject) => {
  const readyAt = argv.indexOf("--ready-file");
  const readyFile = readyAt === -1 ? undefined : argv[readyAt + 1];
  if (readyFile === undefined) {
    reject(new Error("serve was started without --ready-file"));
    return;
  }
  // stdout is unused in listen mode; stderr is the operator's view of serve.
  const child = spawn(process.execPath, [...argv], { env: { ...env }, stdio: ["ignore", "ignore", "inherit"] });
  let exitCode: number | undefined;
  const exited = new Promise<number>((r) => {
    child.on("close", (code, signal) => { exitCode = signal !== null ? 128 : code ?? 0; r(exitCode); });
  });
  child.on("error", (e) => reject(e));
  abort?.addEventListener("abort", () => {
    // serve listens for SIGTERM from before it mints, so this revokes.
    if (exitCode === undefined) child.kill("SIGTERM");
    reject(new Error("interrupted while mandate serve was starting"));
  });

  const deadline = Date.now() + 60_000;
  const poll = (): void => {
    if (exitCode !== undefined) {
      reject(new Error(`mandate serve exited ${exitCode} before it was listening`));
      return;
    }
    if (existsSync(readyFile)) {
      const { port } = JSON.parse(readFileSync(readyFile, "utf8")) as { port: number };
      resolve({
        port,
        stop: async () => {
          if (exitCode === undefined) child.kill("SIGTERM");
          return exited;
        },
      });
      return;
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      reject(new Error("mandate serve did not start listening within 60 s"));
      return;
    }
    setTimeout(poll, 50);
  };
  poll();
});

export interface SandboxRun {
  readonly mandate: ValidatedMandate;
  /** `<entry> serve ...` as `mandate run` would have put in the agent's config. */
  readonly serveArgv: readonly string[];
  readonly args: SandboxArgs;
  /** The agent command, `{mcpConfig}` already substituted with the container path. */
  readonly agent: readonly string[];
  readonly cwd: string;
  /** The operator's environment. serve gets all of it; the container gets what is named. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tty: boolean;
  readonly startServe: StartServe;
  readonly launch: (
    command: string, argv: readonly string[], env: Readonly<Record<string, string>>,
    abort?: AbortSignal,
  ) => Promise<number>;
  /** Where SIGINT, SIGTERM and SIGHUP arrive. The process, outside tests. */
  readonly signals: NodeJS.EventEmitter;
}

/** Signals that end a sandboxed run cleanly rather than by the default action. */
const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** The conventional exit status for a run ended by SIGINT. */
const INTERRUPTED = 130;

/** Returns the agent's exit code, or 2 if the sandbox could not be set up. */
export async function runSandboxed(r: SandboxRun, log: (s: string) => void): Promise<number> {
  // Found reviewing Phase 5: with no handlers, Ctrl-C or a `kill` ended this
  // process by the default action, so no `finally` below ran -- the workspace
  // copy stayed in $TMPDIR and a serve that was not also signalled kept a live
  // token. Handled here, the signal aborts whatever is in progress and the
  // finallys do the rest: docker stopped, serve stopped (which revokes), files
  // removed.
  const interrupted = new AbortController();
  const onInterrupt = (): void => interrupted.abort();
  for (const s of INTERRUPTS) r.signals.on(s, onInterrupt);
  const dir = mkdtempSync(join(tmpdir(), "mandate-sandbox-"));
  try {
    let workspace;
    let egress;
    try {
      workspace = prepareWorkspace(r.cwd, dir);
      egress = compileEgress(r.mandate, {
        githubInfrastructure: false, agentHosts: r.args.agentEgress ?? [],
      });
    } catch (e) {
      if (e instanceof WorkspaceError || e instanceof EgressCompileError) {
        log(e.message);
        return 2;
      }
      throw e;
    }

    const configDir = join(dir, "config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "mcp.json"), `${JSON.stringify({
      mcpServers: { github: { command: "node", args: [CONTAINER_SHIM] } },
    }, null, 2)}\n`, "utf8");

    const passed: Record<string, string> = {};
    for (const name of r.args.passEnv ?? []) {
      const value = r.env[name];
      if (value === undefined) log(`--pass-env ${name} is not set here, so the agent will not have it.`);
      else passed[name] = value;
    }

    log(
      `Sandbox: image ${r.args.image ?? ""}, a clone of ${workspace.head.slice(0, 12)}`
      + `${workspace.branch === undefined ? "" : ` (${workspace.branch})`}, egress to `
      + `${egress.aclEntries.join(" ")}`
      + `${Object.keys(passed).length === 0 ? "" : `, passing ${Object.keys(passed).join(", ")}`}.`,
    );

    const secret = randomBytes(32).toString("hex");
    const hostEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.env)) if (v !== undefined) hostEnv[k] = v;
    const serve = await (async () => {
      try {
        return await r.startServe(
          [...r.serveArgv, "--listen", "127.0.0.1:0", "--ready-file", join(dir, "serve-ready.json")],
          { ...hostEnv, MANDATE_RELAY_SECRET: secret },
          interrupted.signal,
        );
      } catch (e) {
        log(`mandate serve did not start: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    })();
    if (serve === undefined) return interrupted.signal.aborted ? INTERRUPTED : 2;

    try {
      if (interrupted.signal.aborted) {
        log("Interrupted before the agent started.");
        return INTERRUPTED;
      }
      const containerEnv: Record<string, string> = {
        MANDATE_SQUID_CONF: egress.squidConf,
        MANDATE_RELAY_TARGET: `${RELAY_HOST}:${serve.port}`,
        MANDATE_RELAY_SECRET: secret,
        MANDATE_MCP_CONFIG: CONTAINER_MCP_CONFIG,
        ...passed,
      };
      const argv = [
        // --init: an init process as PID 1, so the agent is not -- PID 1
        // ignores signals it has no handler for, and `docker stop` then waits
        // ten seconds and kills it.
        "run", "--rm", "-i", "--init", ...(r.tty ? ["-t"] : []), "--cap-add=NET_ADMIN",
        ...Object.keys(containerEnv).flatMap((name) => ["-e", name]),
        "-v", `${workspace.path}:${CONTAINER_WORKSPACE_MOUNT}:ro`,
        "-v", `${configDir}:${CONTAINER_CONFIG_DIR}:ro`,
        r.args.image ?? "",
        ...r.agent,
      ];
      return await r.launch("docker", argv, containerEnv, interrupted.signal);
    } finally {
      const code = await serve.stop();
      log(`mandate serve exited ${code}.`);
    }
  } finally {
    for (const s of INTERRUPTS) r.signals.off(s, onInterrupt);
    rmSync(dir, { recursive: true, force: true });
  }
}
