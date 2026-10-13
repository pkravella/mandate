import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `leastpilot sandbox build`: the sandbox's base image, from the source that
 * ships in this package (Task 9.1).
 *
 * The directory sits beside `dist/`, so it resolves the same way from a
 * checkout and from an npm install. The image it builds is the one
 * `--image` must be built FROM.
 */
export const SANDBOX_DIR = fileURLToPath(new URL("../../sandbox", import.meta.url));

/** The tag every example and doc builds on. */
export const SANDBOX_TAG = "mandate-sandbox";

export interface SandboxBuildArgs {
  readonly tag?: string | undefined;
}

export interface SandboxBuildDeps {
  /** Runs a command with the operator's terminal attached; docker's own progress is the output. */
  readonly spawn: (cmd: string, args: readonly string[]) => { status?: number | null; error?: Error };
  readonly log: (line: string) => void;
}

export const defaultSandboxBuildDeps: SandboxBuildDeps = {
  spawn: (cmd, args) => spawnSync(cmd, [...args], { stdio: "inherit" }),
  log: (line) => process.stderr.write(`${line}\n`),
};

/** Exit code: docker's own, or 2 when docker could not be started. */
export function runSandboxBuild(args: SandboxBuildArgs, deps: SandboxBuildDeps): number {
  const tag = args.tag ?? SANDBOX_TAG;
  deps.log(`Building ${tag} from ${SANDBOX_DIR}`);
  const r = deps.spawn("docker", ["build", "-t", tag, SANDBOX_DIR]);
  if (r.error !== undefined) {
    deps.log(`could not run docker: ${r.error.message}. The sandbox needs Docker Desktop.`);
    return 2;
  }
  return r.status ?? 1;
}
