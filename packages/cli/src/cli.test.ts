import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The built binary, run as an operator or a script would run it.
 *
 * Every command documents the same exit codes -- 0 accepted, 1 refused, 2 bad
 * input -- and scripts branch on them. `program.exitOverride()` made commander
 * throw on help, version and every usage error, and nothing caught it, so all
 * of those printed a stack trace and exited 1: `mandate --version` failed, and
 * a mistyped flag read as a refused mandate. Measured on the built binary,
 * which is the only place the uncaught throw shows -- an in-process test of
 * `main()` sees an exception, not an exit code.
 */
const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const mandate = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  // Fails rather than skips: a test that silently does nothing when the build
  // is missing is the kind of control this project keeps finding inert. CI runs
  // `pnpm typecheck` (tsc --build, which emits dist/) before `pnpm test`.
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing; run \`pnpm build\` first`);
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A Node stack frame, which an operator should never see from a usage mistake. */
const STACK_FRAME = /^\s+at /m;

describe("the mandate binary's exit codes", () => {
  it("prints help and exits 0", () => {
    for (const args of [["--help"], ["validate", "--help"], ["serve", "--help"], ["run", "--help"]]) {
      const r = mandate(...args);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout, args.join(" ")).toMatch(/^Usage: mandate/);
      expect(r.stderr, args.join(" ")).not.toMatch(STACK_FRAME);
    }
  });

  it("prints the version and exits 0", () => {
    const r = mandate("--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });

  // 2, not 1: 1 means the mandate was refused, and a script has to be able to
  // tell "your mandate grants too much" from "you typed the command wrong".
  it("exits 2 on a missing required option, naming it, with no stack trace", () => {
    const r = mandate("validate", "m.yaml");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/required option '--ceiling <path>' not specified/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });

  it("exits 2 on an unknown command, with no stack trace", () => {
    const r = mandate("nosuchcmd");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown command 'nosuchcmd'/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });

  it("exits 2 with usage when given no command, with no stack trace", () => {
    const r = mandate();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^Usage: mandate/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });
});
