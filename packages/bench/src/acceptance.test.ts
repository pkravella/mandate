import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_IMAGE, ACCEPTANCE_TIMEOUT_S, acceptanceArgv, interpretAcceptanceExit } from "./acceptance.js";

/**
 * Where a task's acceptance command runs.
 *
 * It runs the agent's own files: the test and source the agent pushed to its
 * branch. It ran them on the host, with the harness's whole environment
 * (ANTHROPIC_API_KEY, LEASTPILOT_APP_KEY_PATH) and the App's private key readable
 * on disk -- so an injected agent, the attacker the threat model assumes, could
 * take the key through a "test" it wrote. Found reviewing Phase 6. It now runs
 * in a container with no network, no capabilities, a read-only root and only
 * the scratch directory mounted, read-only. Probed against Docker Desktop:
 * no host credential variables, no host path, DNS fails, /work not writable.
 */
describe("acceptanceArgv", () => {
  const argv = acceptanceArgv("/tmp/mandate-accept-x", "node --test test/retry.test.js", "c1");

  it("gives the container no network, no capabilities and a read-only root", () => {
    expect(argv).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL", "--read-only"]));
    expect(argv.join(" ")).toContain("--security-opt no-new-privileges");
  });

  it("mounts only the scratch directory, read-only", () => {
    const mounts = argv.flatMap((a, i) => (a === "-v" || a === "--volume" || a === "--mount" ? [argv[i + 1]] : []));
    expect(mounts).toEqual(["/tmp/mandate-accept-x:/work:ro"]);
  });

  it("passes nothing from the host environment", () => {
    for (const flag of ["-e", "--env", "--env-file", "--privileged", "--pid", "--ipc"]) {
      expect(argv, flag).not.toContain(flag);
    }
  });

  // The command is one argv element, handed to bash inside the container --
  // never spliced into a host shell line.
  it("runs the command, bounded by a timeout, as a single argument", () => {
    expect(argv.slice(-6)).toEqual([
      ACCEPTANCE_IMAGE, "timeout", String(ACCEPTANCE_TIMEOUT_S), "bash", "-c", "node --test test/retry.test.js",
    ]);
  });

  it("names the container, so a run cut short can be removed", () => {
    expect(argv.slice(0, 4)).toEqual(["run", "--rm", "--name", "c1"]);
  });
});

describe("interpretAcceptanceExit", () => {
  it("passes on 0 and fails on a test failure", () => {
    expect(interpretAcceptanceExit(0)).toEqual({ passed: true, detail: "" });
    expect(interpretAcceptanceExit(1)).toEqual({ passed: false, detail: "exit 1" });
  });

  it("says a timeout was a timeout", () => {
    expect(interpretAcceptanceExit(124).detail).toMatch(/timed out after \d+ s/);
  });

  // 125 is docker's own failure (a daemon that is not running, an image that
  // cannot be pulled): the task was not judged, and the evidence must say so.
  it("does not report a container that never ran as a failed test", () => {
    const r = interpretAcceptanceExit(125);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/container could not run/);
  });

  it("treats no exit status at all as not passed", () => {
    expect(interpretAcceptanceExit(null).passed).toBe(false);
  });
});

// Acceptance runs on the agent sandbox's own Node, and Dependabot bumps only the
// Dockerfile: #71 moved the sandbox to Node 24 while this stayed on 22, and
// nothing failed. Now the bump fails here until both move.
describe("ACCEPTANCE_IMAGE", () => {
  it("is the agent sandbox's base image", () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL("../../cli/sandbox/Dockerfile", import.meta.url)), "utf8",
    );
    const from = /^FROM\s+(\S+)/m.exec(dockerfile)?.[1];
    expect(from).toBeDefined();
    expect(ACCEPTANCE_IMAGE).toBe(from);
  });
});
