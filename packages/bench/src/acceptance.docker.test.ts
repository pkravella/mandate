import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { dockerAcceptance } from "./acceptance.js";

/**
 * The acceptance container against real Docker. Free, but needs Docker, so it
 * is gated like the other sandbox suites:
 *
 *   LEASTPILOT_SANDBOX=1 pnpm --filter @leastpilot/bench exec vitest run src/acceptance.docker
 *
 * Each escape is checked twice: inside the container, where it must fail, and
 * on the host, where it must succeed -- a probe that can only fail proves
 * nothing about the container.
 */
const enabled = process.env["LEASTPILOT_SANDBOX"] === "1";
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

describe.skipIf(!enabled)("dockerAcceptance", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-accept-docker-"));
  cpSync(root("fixtures/bench/seed/retry-swallows-last-error"), dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "accept", private: true, type: "module" }));
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const onHost = (command: string): boolean => {
    try { execFileSync("bash", ["-c", command], { stdio: "ignore" }); return true; } catch { return false; }
  };

  it("fails the seeded bug and passes the reference fix", () => {
    expect(dockerAcceptance(dir, "node --test test/retry.test.js").passed).toBe(false);
    cpSync(root("fixtures/bench/reference/retry-swallows-last-error"), dir, { recursive: true });
    expect(dockerAcceptance(dir, "node --test test/retry.test.js")).toEqual({ passed: true, detail: "" });
  }, 120_000);

  it.each([
    ["read the App key", `test -r "${join(homedir(), ".mandate", "app.pem")}"`, "LEASTPILOT_APP_KEY_PATH"],
    ["see a host credential variable", '[ -n "$ANTHROPIC_API_KEY$LEASTPILOT_APP_KEY_PATH" ]', "ANTHROPIC_API_KEY"],
    ["reach the network", "node -e 'fetch(\"https://api.github.com\").then(()=>process.exit(0),()=>process.exit(1))'", undefined],
  ])("cannot %s, which the host can", (_what, command, needsEnv) => {
    // The control: skipped only if the host lacks the thing being guarded.
    if (needsEnv === undefined || process.env[needsEnv] !== undefined) expect(onHost(command)).toBe(true);
    expect(dockerAcceptance(dir, command).passed).toBe(false);
  }, 60_000);

  it("cannot write the directory it judges", () => {
    expect(dockerAcceptance(dir, "touch /work/pwned").passed).toBe(false);
  }, 60_000);
});
