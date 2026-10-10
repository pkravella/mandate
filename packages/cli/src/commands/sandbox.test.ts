import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runRun, MCP_CONFIG_PLACEHOLDER, type RunArgs, type RunDeps } from "./run.js";
import { CONTAINER_MCP_CONFIG, refusedPassEnv, type ServeHandle } from "../sandbox.js";

/**
 * `mandate run --sandbox` (Task 5.1 b), offline: docker, serve and the host
 * platform are injected; git and the workspace are real.
 *
 * The properties under test are the ones the sandbox exists for. The App key
 * and any token in the operator's environment do not reach the container;
 * serve is started by `mandate run`, on the host, never by the agent; every
 * secret reaches docker through its environment by name, never through argv,
 * which every process on the host can read; and nothing is minted for a run
 * that was going to be refused anyway.
 */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "mandate-sandbox-test-"));
const SELF = join(tmp, "mandate-entry.js");
writeFileSync(SELF, "// stands in for dist/index.js\n");
const MANDATE = join(tmp, "m.yaml");
writeFileSync(MANDATE, `
mandate: fix-issue-42
task: "Fix issue #42 and open a PR"
requestedBy: user:alice
expiresInMinutes: 30
ceiling: org-policy@v12
grants:
  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }
destinations:
  allow: ["github.com/acme/api"]
`);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A clean repository to run from. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mandate-sandbox-repo-"));
  git(dir, "init", "-q", "-b", "agent/42-fix");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const args = (over: Partial<RunArgs> = {}): RunArgs => ({
  file: MANDATE, ceiling: fixture("ceilings/org-policy-v12.cedar"),
  schema: fixture("ceilings/schema.cedarschema"),
  destinations: fixture("ceilings/org-policy-v12.destinations"),
  as: "alice", level: "push",
  agent: ["claude", "--mcp-config", MCP_CONFIG_PLACEHOLDER, "-p", "fix #42"],
  sandbox: true, image: "acme/agent:1", agentEgress: ["api.anthropic.com"],
  passEnv: ["ANTHROPIC_API_KEY"],
  ...over,
});

interface Recorded {
  serve?: { argv: readonly string[]; env: Readonly<Record<string, string>> };
  served: boolean;
  stopped: boolean;
  docker?: { command: string; argv: readonly string[]; env: Readonly<Record<string, string>> };
  configAtLaunch?: string;
  /** Whether serve was still running when docker was launched. */
  serveLiveAtLaunch?: boolean;
}

/** The operator's environment: a model key to pass, and credentials that must not travel. */
const HOST_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "sk-ant-PASSED",
  GITHUB_TOKEN: "ghp_PLANTED",
  MANDATE_APP_KEY_PATH: "/Users/op/.mandate/app.pem",
  MANDATE_APP_ID: "5182699",
};

async function sandboxRun(
  over: Partial<RunArgs> = {}, deps: Partial<RunDeps> = {},
): Promise<{ code: number; out: string; rec: Recorded }> {
  const out: string[] = [];
  const rec: Recorded = { served: false, stopped: false };
  const code = await runRun(args(over), (s) => out.push(s), {
    selfPath: SELF,
    cwd: repo(),
    platform: "darwin",
    env: HOST_ENV,
    startServe: async (argv, env): Promise<ServeHandle> => {
      rec.serve = { argv, env };
      rec.served = true;
      return { port: 47999, stop: async () => { rec.stopped = true; return 0; } };
    },
    launch: async (command, argv, env) => {
      rec.docker = { command, argv, env };
      rec.serveLiveAtLaunch = rec.served && !rec.stopped;
      const cfg = argv.find((a) => a.endsWith(":/run/mandate-config:ro"));
      const hostDir = cfg?.slice(0, cfg.indexOf(":"));
      if (hostDir !== undefined && existsSync(join(hostDir, "mcp.json"))) {
        rec.configAtLaunch = readFileSync(join(hostDir, "mcp.json"), "utf8");
      }
      return 7;
    },
    ...deps,
  });
  return { code, out: out.join("\n"), rec };
}

/** The value after a flag, for every occurrence of it. */
const valuesOf = (argv: readonly string[], flag: string): string[] =>
  argv.flatMap((a, i) => (a === flag && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));

describe("mandate run --sandbox", () => {
  it("runs the agent in docker and returns its exit code", async () => {
    const { code, rec } = await sandboxRun();
    expect(code).toBe(7);
    expect(rec.docker?.command).toBe("docker");
    const argv = rec.docker?.argv ?? [];
    expect(argv.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(argv).toContain("--cap-add=NET_ADMIN");
    // The image, then the agent's own command.
    const at = argv.indexOf("acme/agent:1");
    expect(at).toBeGreaterThan(0);
    expect(argv.slice(at + 1)).toEqual(["claude", "--mcp-config", CONTAINER_MCP_CONFIG, "-p", "fix #42"]);
  });

  // The integration point flips: the agent cannot spawn serve, because serve
  // needs the App key and the agent must never be able to read it.
  it("starts serve itself, on the host, listening for the relay, before docker", async () => {
    const { rec } = await sandboxRun();
    const serveArgv = rec.serve?.argv ?? [];
    expect(serveArgv).toContain("serve");
    expect(valuesOf(serveArgv, "--listen")).toEqual(["127.0.0.1:0"]);
    expect(valuesOf(serveArgv, "--ready-file")).toHaveLength(1);
    expect(rec.serveLiveAtLaunch).toBe(true);
    expect(rec.stopped).toBe(true);
  });

  it("gives serve the App credentials and the relay secret, through its environment", async () => {
    const { rec } = await sandboxRun();
    expect(rec.serve?.env["MANDATE_APP_KEY_PATH"]).toBe("/Users/op/.mandate/app.pem");
    expect(rec.serve?.env["MANDATE_RELAY_SECRET"]).toMatch(/^[0-9a-f]{64}$/);
  });

  // An init process as PID 1, so the agent is not: PID 1 ignores signals it
  // installs no handler for, and docker stop then waits ten seconds to kill it.
  it("runs the container with an init process", async () => {
    const { rec } = await sandboxRun();
    expect(rec.docker?.argv).toContain("--init");
  });

  it("names every container variable in argv and puts no value there", async () => {
    const { rec } = await sandboxRun();
    const argv = rec.docker?.argv ?? [];
    expect(valuesOf(argv, "-e").sort()).toEqual([
      "ANTHROPIC_API_KEY", "MANDATE_MCP_CONFIG", "MANDATE_RELAY_SECRET",
      "MANDATE_RELAY_TARGET", "MANDATE_SQUID_CONF",
    ]);
    const secret = rec.serve?.env["MANDATE_RELAY_SECRET"] ?? "";
    const joined = argv.join(" ");
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain("sk-ant-PASSED");
    expect(joined).not.toContain("http_port");
  });

  it("hands docker the same secret serve was given, and the relay target serve listens on", async () => {
    const { rec } = await sandboxRun();
    const env = rec.docker?.env ?? {};
    expect(env["MANDATE_RELAY_SECRET"]).toBe(rec.serve?.env["MANDATE_RELAY_SECRET"]);
    expect(env["MANDATE_RELAY_TARGET"]).toBe("host.docker.internal:47999");
    expect(env["MANDATE_MCP_CONFIG"]).toBe(CONTAINER_MCP_CONFIG);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-PASSED");
  });

  it("does not pass the operator's GitHub token or App credentials into the container", async () => {
    const { rec } = await sandboxRun();
    const named = valuesOf(rec.docker?.argv ?? [], "-e");
    for (const n of ["GITHUB_TOKEN", "MANDATE_APP_KEY_PATH", "MANDATE_APP_ID"]) {
      expect(named, n).not.toContain(n);
    }
  });

  it("compiles egress with the operator's agent hosts and no GitHub host at all", async () => {
    const { rec } = await sandboxRun();
    const conf = rec.docker?.env["MANDATE_SQUID_CONF"] ?? "";
    const acl = /^acl mandate_allowed dstdomain -n (.*)$/m.exec(conf)?.[1]?.split(" ") ?? [];
    // github.com is the mandate's destination, and the agent reaches it only
    // through serve: an open github.com is where a leaked credential would push.
    expect(acl.sort()).toEqual(["api.anthropic.com"]);
  });

  it("mounts a clone of HEAD read-only, never the checkout itself", async () => {
    const cwd = repo();
    const { rec } = await sandboxRun({}, { cwd });
    const mounts = valuesOf(rec.docker?.argv ?? [], "-v");
    const ws = mounts.find((v) => v.endsWith(":/mnt/mandate-workspace:ro"));
    expect(ws).toBeDefined();
    expect(ws?.startsWith(cwd)).toBe(false);
    expect(mounts.every((v) => v.endsWith(":ro"))).toBe(true);
  });

  it("writes an MCP config naming the in-container shim, with nothing secret in it", async () => {
    const { rec } = await sandboxRun();
    const cfg = JSON.parse(rec.configAtLaunch ?? "{}") as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers["github"]).toEqual({ command: "node", args: ["/usr/local/lib/mandate-mcp.mjs"] });
    const secret = rec.serve?.env["MANDATE_RELAY_SECRET"] ?? "";
    expect(rec.configAtLaunch).not.toContain(secret);
  });

  it("removes its temporary files when the agent exits", async () => {
    const { rec } = await sandboxRun();
    const mounts = valuesOf(rec.docker?.argv ?? [], "-v");
    for (const m of mounts) expect(existsSync(m.slice(0, m.indexOf(":"))), m).toBe(false);
  });

  // serve holds a live token. If docker cannot start, the token still has to
  // go back, which is serve's shutdown path.
  it("stops serve even when docker fails to launch", async () => {
    let stopped = false;
    await runRun(args(), () => undefined, {
      selfPath: SELF, cwd: repo(), platform: "darwin", env: HOST_ENV,
      startServe: async () => ({ port: 1, stop: async () => { stopped = true; return 0; } }),
      launch: async () => { throw new Error("no docker"); },
    }).catch(() => undefined);
    expect(stopped).toBe(true);
  });
});

// Found reviewing Phase 5: `mandate run --sandbox` had no signal handling, so
// Ctrl-C or a `kill` ended it by the default action -- no `finally` ran, the
// temporary workspace stayed in $TMPDIR, and a serve that was not also
// signalled was left holding a live token.
describe("mandate run --sandbox, interrupted", () => {
  const interruptible = async (when: "serve" | "docker", signal: string) => {
    const signals = new EventEmitter();
    const rec: { stopped: boolean; launched: boolean; mounts: string[] } = { stopped: false, launched: false, mounts: [] };
    const code = await runRun(args(), () => undefined, {
      selfPath: SELF, cwd: repo(), platform: "darwin", env: HOST_ENV, signals,
      startServe: async () => {
        if (when === "serve") signals.emit(signal);
        return { port: 1, stop: async () => { rec.stopped = true; return 0; } };
      },
      launch: (_c, argv, _e, abort) => new Promise((resolve) => {
        rec.launched = true;
        rec.mounts = argv.flatMap((a, i) => (argv[i - 1] === "-v" ? [a.slice(0, a.indexOf(":"))] : []));
        abort?.addEventListener("abort", () => resolve(143));
        if (when === "docker") signals.emit(signal);
      }),
    });
    return { code, rec, signals };
  };

  it("stops docker, then serve, and removes its files, on SIGTERM while the agent runs", async () => {
    const { code, rec, signals } = await interruptible("docker", "SIGTERM");
    expect(rec.launched).toBe(true);
    expect(code).toBe(143);
    expect(rec.stopped).toBe(true);
    for (const m of rec.mounts) expect(existsSync(m), m).toBe(false);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not start docker when interrupted while serve is starting", async () => {
    const { code, rec, signals } = await interruptible("serve", "SIGINT");
    expect(rec.launched).toBe(false);
    expect(rec.stopped).toBe(true);
    expect(code).toBe(130);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("handles SIGHUP the same way", async () => {
    const { rec } = await interruptible("docker", "SIGHUP");
    expect(rec.stopped).toBe(true);
  });
});

describe("mandate run --sandbox refuses, before anything is minted", () => {
  const refused = async (over: Partial<RunArgs>, deps: Partial<RunDeps> = {}) => {
    const r = await sandboxRun(over, deps);
    expect(r.rec.served, "serve must not start, so nothing is minted").toBe(false);
    expect(r.rec.docker, "docker must not run").toBeUndefined();
    return r;
  };

  it("without --image", async () => {
    const { code, out } = await refused({ image: undefined });
    expect(code).toBe(2);
    expect(out).toMatch(/--image/);
  });

  it("off macOS, where the relay's path is unprobed", async () => {
    const { code, out } = await refused({}, { platform: "linux" });
    expect(code).toBe(2);
    expect(out).toMatch(/macOS/);
  });

  it("when asked to pass a credential into the container", async () => {
    for (const name of [
      "GITHUB_TOKEN", "GH_TOKEN", "MANDATE_APP_KEY_PATH", "MANDATE_RELAY_SECRET", "SSH_AUTH_SOCK",
      // Found reviewing Phase 5: the list was exact names only.
      "HOMEBREW_GITHUB_API_TOKEN", "GH_ENTERPRISE_TOKEN", "MY_GITHUB_PAT",
    ]) {
      const { code, out } = await refused({ passEnv: [name] });
      expect(code, name).toBe(2);
      expect(out, name).toContain(name);
    }
  });

  it("when --pass-env carries a value rather than a name", async () => {
    const { code } = await refused({ passEnv: ["ANTHROPIC_API_KEY=sk-ant-x"] });
    expect(code).toBe(2);
  });

  it("on an agent egress host that is not one concrete hostname", async () => {
    const { code, out } = await refused({ agentEgress: ["*.anthropic.com"] });
    expect(code).toBe(2);
    expect(out).toMatch(/agent egress/);
  });

  it("on a working tree with uncommitted changes", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "README.md"), "edited\n");
    const { code, out } = await refused({}, { cwd });
    expect(code).toBe(2);
    expect(out).toMatch(/uncommitted/);
  });

  it("on a mandate the validator rejects", async () => {
    const { code } = await refused({ file: fixture("overgrants/merge-granted.yaml") });
    expect(code).toBe(1);
  });
});

describe("refusedPassEnv", () => {
  it("allows an ordinary variable name", () => {
    expect(refusedPassEnv("ANTHROPIC_API_KEY")).toBeUndefined();
  });
});
