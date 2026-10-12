import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Runs a task's acceptance command against the agent's work.
 *
 * The command runs the agent's own files -- the source and tests it pushed --
 * so it is untrusted code. It used to run on the host, with the harness's whole
 * environment (ANTHROPIC_API_KEY, LEASTPILOT_APP_KEY_PATH) and the App's private
 * key readable on disk: an injected agent, the attacker the threat model
 * assumes, could take the key through a "test" it wrote. Found reviewing
 * Phase 6.
 */
export interface AcceptanceRun { readonly passed: boolean; readonly detail: string }
export type AcceptanceRunner = (dir: string, command: string) => AcceptanceRun;

/** The sandbox image's own base, so acceptance runs on the agent's Node. */
export const ACCEPTANCE_IMAGE = "node:24-bookworm-slim";
export const ACCEPTANCE_TIMEOUT_S = 120;

/**
 * No network, no capabilities, no privilege escalation, a read-only root with
 * a scratch /tmp, bounded processes and memory, and the scratch directory as
 * the only mount, read-only. Nothing from the host environment: `docker run`
 * passes a variable only when told to, and nothing here tells it. Probed
 * against Docker Desktop 29.7.2: no host credential variables inside, no host
 * path (/Users, /private, /var/folders absent), DNS fails, /work unwritable --
 * and a seeded bug still fails its test while the reference fix passes.
 */
export function acceptanceArgv(dir: string, command: string, name: string): string[] {
  return [
    "run", "--rm", "--name", name,
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", "512m",
    "--read-only", "--tmpfs", "/tmp",
    "-v", `${dir}:/work:ro`, "-w", "/work",
    ACCEPTANCE_IMAGE, "timeout", String(ACCEPTANCE_TIMEOUT_S), "bash", "-c", command,
  ];
}

/**
 * What an exit status means. 124 is `timeout`; 125 and above are docker's own
 * failures (no daemon, no image) -- the work was never judged, and the evidence
 * has to say that rather than read as a failed test.
 */
export function interpretAcceptanceExit(status: number | null): AcceptanceRun {
  if (status === 0) return { passed: true, detail: "" };
  if (status === 124) return { passed: false, detail: `timed out after ${ACCEPTANCE_TIMEOUT_S} s` };
  if (status !== null && status >= 125) {
    return { passed: false, detail: `the acceptance container could not run (exit ${status}); not judged` };
  }
  return { passed: false, detail: status === null ? "no exit status" : `exit ${status}` };
}

/** The default runner: the command in a locked-down container. */
export const dockerAcceptance: AcceptanceRunner = (dir, command) => {
  const name = `mandate-accept-${randomUUID()}`;
  try {
    execFileSync("docker", acceptanceArgv(dir, command, name), {
      stdio: "pipe",
      // Past the in-container timeout, so this fires only if docker hangs.
      timeout: (ACCEPTANCE_TIMEOUT_S + 60) * 1000,
    });
    return interpretAcceptanceExit(0);
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    return interpretAcceptanceExit(typeof status === "number" ? status : null);
  } finally {
    // A run cut short by the outer timeout can leave its container behind.
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
};
