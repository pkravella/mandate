import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSandboxBuild, SANDBOX_DIR, type SandboxBuildDeps } from "./sandboxBuild.js";
import { checkSandboxInputs } from "../sandbox.js";

/**
 * `leastpilot sandbox build` (Task 9.1, the owner's option c).
 *
 * `--sandbox` needs an image built FROM mandate-sandbox, and that image was
 * built from `sandbox/` in the repository, which no npm package contained. So
 * an npm user could not use the control the threat model tells operators to
 * use first. The sandbox's source now ships in the CLI package, and this
 * command builds it from there. Docker is injected; scripts/pack-check.mjs
 * runs the installed binary against a stand-in docker.
 */
const calls: { cmd: string; args: readonly string[] }[] = [];
const deps = (status: number | "ENOENT" = 0): SandboxBuildDeps => ({
  spawn: (cmd, args) => {
    calls.push({ cmd, args });
    return status === "ENOENT" ? { error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) } : { status };
  },
  log: () => undefined,
});

describe("the sandbox's source", () => {
  it("is inside the CLI package, beside dist/, where npm packs it", () => {
    expect(SANDBOX_DIR).toBe(fileURLToPath(new URL("../../sandbox", import.meta.url)));
    for (const f of ["Dockerfile", "entrypoint.sh", "verify.mjs", "relay.mjs", "mcp.mjs"]) {
      expect(existsSync(join(SANDBOX_DIR, f)), f).toBe(true);
    }
  });

  it("is in the CLI package's files", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };
    expect(manifest.files).toContain("sandbox");
  });
});

describe("runSandboxBuild", () => {
  it("runs docker build on the packaged sandbox, tagged mandate-sandbox", () => {
    calls.length = 0;
    expect(runSandboxBuild({}, deps(0))).toBe(0);
    expect(calls).toEqual([{ cmd: "docker", args: ["build", "-t", "mandate-sandbox", SANDBOX_DIR] }]);
  });

  it("takes another tag", () => {
    calls.length = 0;
    runSandboxBuild({ tag: "my-sandbox:1" }, deps(0));
    expect(calls[0]?.args).toEqual(["build", "-t", "my-sandbox:1", SANDBOX_DIR]);
  });

  it("exits with docker's status when the build fails", () => {
    expect(runSandboxBuild({}, deps(1))).toBe(1);
  });

  it("exits 2, saying so, when there is no docker", () => {
    const lines: string[] = [];
    const code = runSandboxBuild({}, { ...deps("ENOENT"), log: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/docker/i);
  });
});

describe("--sandbox without --image", () => {
  it("says how to build the base image", () => {
    expect(checkSandboxInputs({}, "darwin")).toContain("leastpilot sandbox build");
  });
});

describe("leastpilot sandbox build, through the binary", () => {
  it("prints help and exits 0", () => {
    const bin = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
    if (!existsSync(bin)) throw new Error(`${bin} is missing; run \`pnpm build\` first`);
    const r = spawnSync(process.execPath, [bin, "sandbox", "build", "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: leastpilot sandbox build/);
    expect(r.stdout).toContain("--tag <name>");
  });
});
