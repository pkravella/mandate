import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog, loadAuditKey } from "@leastpilot/proxy";
import { describe, expect, it } from "vitest";

/**
 * The built binary, run as an operator or a script would run it.
 *
 * Every command documents the same exit codes -- 0 accepted, 1 refused, 2 bad
 * input -- and scripts branch on them. `program.exitOverride()` made commander
 * throw on help, version and every usage error, and nothing caught it, so all
 * of those printed a stack trace and exited 1: `leastpilot --version` failed, and
 * a mistyped flag read as a refused mandate. Measured on the built binary,
 * which is the only place the uncaught throw shows -- an in-process test of
 * `main()` sees an exception, not an exit code.
 */
const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const leastpilot = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  // Fails rather than skips: a test that silently does nothing when the build
  // is missing is the kind of control this project keeps finding inert. CI runs
  // `pnpm typecheck` (tsc --build, which emits dist/) before `pnpm test`.
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing; run \`pnpm build\` first`);
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A Node stack frame, which an operator should never see from a usage mistake. */
const STACK_FRAME = /^\s+at /m;

describe("the leastpilot binary's exit codes", () => {
  // `leastpilot help` and `leastpilot help <command>` too: found reviewing Phase 5,
  // commander raises those as commander.help with exitCode 0, and only
  // helpDisplayed was mapped to 0.
  //
  // One test per invocation. All six in one test spawned the binary six times
  // against one 5 s timeout: ~1.1 s idle, but past 5 s under a full parallel
  // `pnpm test`, where it failed while the code was fine.
  it.each([
    "--help", "validate --help", "serve --help", "run --help", "help", "help validate",
  ])("prints help and exits 0: leastpilot %s", (line) => {
    const r = leastpilot(...line.split(" "));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: leastpilot/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });

  it("prints the version and exits 0", () => {
    const r = leastpilot("--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });

  // 2, not 1: 1 means the mandate was refused, and a script has to be able to
  // tell "your mandate grants too much" from "you typed the command wrong".
  it("exits 2 on a missing required option, naming it, with no stack trace", () => {
    const r = leastpilot("validate", "m.yaml");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/required option '--ceiling <path>' not specified/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });

  it("exits 2 on an unknown command, with no stack trace", () => {
    const r = leastpilot("nosuchcmd");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown command 'nosuchcmd'/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });

  it("exits 2 with usage when given no command, with no stack trace", () => {
    const r = leastpilot();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^Usage: leastpilot/);
    expect(r.stderr).not.toMatch(STACK_FRAME);
  });
});

describe("leastpilot audit, through the binary", () => {
  it.each(["audit --help", "audit verify --help", "audit keygen --help"])(
    "prints help and exits 0: leastpilot %s", (line) => {
      const r = leastpilot(...line.split(" "));
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^Usage: leastpilot audit/);
    },
  );

  it.each(["serve --help", "run --help"])("offers --audit-log: leastpilot %s", (line) => {
    expect(leastpilot(...line.split(" ")).stdout).toContain("--audit-log <path>");
  });

  // The key reaches serve from LEASTPILOT_AUDIT_KEY_PATH and is checked before
  // anything else needs the network: an RSA key (the App's kind) is refused.
  it("serve reads the audit key from LEASTPILOT_AUDIT_KEY_PATH and refuses an RSA one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-audit-env-"));
    const rsa = join(dir, "app.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs1", format: "pem" }).toString(), { mode: 0o600 });
    const r = spawnSync(process.execPath, [
      BIN, "serve", "--mandate", "m.yaml", "--ceiling", "c", "--schema", "s",
      "--ceiling-destinations", "d", "--as", "alice", "--level", "push",
      "--audit-log", join(dir, "audit.jsonl"),
    ], {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "", LEASTPILOT_APP_ID: "1", LEASTPILOT_INSTALLATION_ID: "1",
        LEASTPILOT_APP_KEY_PATH: rsa, LEASTPILOT_AUDIT_KEY_PATH: rsa,
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is an rsa key/);
  });

  // The whole outside-the-repository path: make a key, sign a log with it the
  // way serve does, check the log with only the public half.
  it("makes a key, and verifies a log signed with it using only the public key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-audit-bin-"));
    const key = join(dir, "audit.pem");
    const made = leastpilot("audit", "keygen", "--out", key);
    expect(made.status).toBe(0);
    expect(made.stdout).toContain(`${key}.pub`);

    const log = join(dir, "audit.jsonl");
    const sink = AuditLog.create(log, loadAuditKey(key));
    sink.open({
      mandate: "m", task: "t", requestedBy: "user:alice", expiresInMinutes: 5, ceiling: "c",
      grants: [{ action: "contents.read", enforcedBy: "token", resources: ["acme/api"] }],
      destinations: { allow: [] },
    });
    sink.seal();

    const ok = leastpilot("audit", "verify", log, "--public-key", `${key}.pub`);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^Intact/);

    const missing = leastpilot("audit", "verify", log);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/required option '--public-key <path>'/);
  });
});

describe("leastpilot export gh-aw, through the binary", () => {
  it.each(["export --help", "export gh-aw --help"])("prints help and exits 0: leastpilot %s", (line) => {
    const r = leastpilot(...line.split(" "));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: leastpilot export/);
  });

  // stdout is the workflow and nothing else, so `> workflow.md` works.
  it("prints only the workflow block on stdout, and the provenance on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-export-bin-"));
    const file = join(dir, "fix.yaml");
    writeFileSync(file, [
      "mandate: fix-issue-42", 'task: "Fix issue #42"', "requestedBy: user:alice",
      "expiresInMinutes: 30", "ceiling: org-policy@v12", "grants:",
      '  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }',
      '  - { action: branch.create, enforcedBy: proxy, resources: ["acme/api"], branches: ["agent/42-fix"] }',
      '  - { action: contents.write, enforcedBy: proxy, resources: ["acme/api"], branches: ["agent/42-fix"], paths: ["src/**"], denyPaths: [".github/workflows/**", "**.env**"] }',
      '  - { action: pull_request.create, enforcedBy: proxy, resources: ["acme/api"], branches: ["agent/42-fix"], base: main, max: 1 }',
      'destinations: { allow: ["github.com/acme/api"] }', "",
    ].join("\n"));
    const fx = (n: string): string => fileURLToPath(new URL(`../../../fixtures/${n}`, import.meta.url));
    const r = leastpilot(
      "export", "gh-aw", "--mandate", file, "--ceiling", fx("ceilings/org-policy-v12.cedar"),
      "--schema", fx("ceilings/schema.cedarschema"),
      "--ceiling-destinations", fx("ceilings/org-policy-v12.destinations"), "--as", "alice", "--level", "push",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^---\n# Generated by `leastpilot export gh-aw`/);
    expect(r.stdout.trimEnd().endsWith("\n---")).toBe(true);
    expect(r.stderr).toMatch(/asserted/);
  });
});

describe("--approval, through the binary", () => {
  it.each(["serve --help", "run --help"])("offers --approval: leastpilot %s", (line) => {
    expect(leastpilot(...line.split(" ")).stdout).toContain("--approval <owner/repo#number>");
  });
});

describe("leastpilot review, through the binary", () => {
  it("prints help and exits 0", () => {
    const r = leastpilot("review", "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: leastpilot review/);
    expect(r.stdout).toContain("--task-file <file>");
  });

  // No credentials at all: refused at the start, before anything is spent.
  it("refuses without the App's credentials, exit 2", () => {
    const r = spawnSync(process.execPath, [
      BIN, "review", "--task-file", "/dev/null", "--on", "acme/api#1", "--as", "alice", "--repo", "acme/api",
      "--ceiling", "c", "--schema", "s", "--ceiling-destinations", "d",
    ], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/LEASTPILOT_APP_ID/);
  });
});
