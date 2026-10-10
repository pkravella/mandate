import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCP_CONFIG_PLACEHOLDER, runRun } from "./commands/run.js";
import { listenForAgent } from "./listen.js";
import type { ServeHandle } from "./sandbox.js";

/**
 * `mandate run --sandbox`, end to end against a real container (Task 5.1 b).
 *
 * Real: git, the workspace clone, docker, the entrypoint, squid, iptables, the
 * relay, and `mandate run`'s own argv and environment. Stood in: `mandate
 * serve`, replaced by the real listener in front of a fake server, so nothing
 * is minted and nothing costs money.
 *
 * The agent is a shell script that reports what it can see. Credentials are
 * planted where an operator's machine really has them -- a token in the
 * environment, a credential in the checkout's remote, an ignored `.env`, a
 * hook -- and the script reports whether any of them reached it.
 *
 *   MANDATE_SANDBOX=1 pnpm --filter @mandate-dev/cli test sandbox.docker
 */
const enabled = process.env["MANDATE_SANDBOX"] === "1" && process.platform === "darwin";

const SANDBOX_DIR = fileURLToPath(new URL("../../../sandbox", import.meta.url));
const IMAGE = "mandate-sandbox-test";
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** The operator's checkout, with every credential an operator really has around it. */
function operatorRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mandate-e2e-repo-"));
  git(dir, "init", "-q", "-b", "agent/42-fix");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "committed\n");
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", "https://x-access-token:ghp_PLANTED_REMOTE@github.com/acme/api.git");
  writeFileSync(join(dir, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho PLANTED-HOOK\n", { mode: 0o755 });
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=ghp_PLANTED_DOTENV\n");
  return dir;
}

const mandateFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "mandate-e2e-m-")), "m.yaml");
  writeFileSync(path, `
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
  return path;
};

/**
 * What the "agent" reports, one `name=value` per line. `$1` is the MCP config
 * path, substituted for {mcpConfig} by `mandate run`.
 */
const AGENT_SCRIPT = `
echo "ws.pwd=$(pwd)"
echo "ws.readme=$(cat README.md)"
test -e .env && echo ws.dotenv=PRESENT || echo ws.dotenv=absent
echo "ws.remotes=$(git remote | wc -l | tr -d ' ')"
grep -q PLANTED .git/config && echo ws.config-credential=PRESENT || echo ws.config-credential=absent
test -e .git/hooks/post-checkout && echo ws.hook=PRESENT || echo ws.hook=absent
touch written-by-agent && echo ws.writable=yes || echo ws.writable=no
test -n "$GITHUB_TOKEN" && echo env.github-token=PRESENT || echo env.github-token=absent
test -n "$MANDATE_APP_KEY_PATH" && echo env.app-key=PRESENT || echo env.app-key=absent
echo "env.passed=$ANTHROPIC_API_KEY"
test -f "$1" && echo config.arg=exists || echo config.arg=missing
test "$1" = "$MANDATE_MCP_CONFIG" && echo config.env=matches || echo config.env=differs
node /usr/local/lib/mandate-verify.mjs
`;

/** serve's stand-in: the real listener, holding the secret run gave it. */
const fakeServe = (seen: { secret?: string; connects: number }) =>
  async (_argv: readonly string[], env: Readonly<Record<string, string>>): Promise<ServeHandle> => {
    const secret = env["MANDATE_RELAY_SECRET"] ?? "";
    seen.secret = secret;
    const listener = await listenForAgent({
      host: "127.0.0.1", port: 0, secret,
      connect: async (t) => {
        seen.connects += 1;
        const s = new Server({ name: "host-serve", version: "0" }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
        await s.connect(t);
      },
    });
    return { port: listener.port, stop: async () => { await listener.close(); return 0; } };
  };

describe.skipIf(!enabled)("mandate run --sandbox, against a real container", { timeout: 180_000 }, () => {
  beforeAll(() => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, SANDBOX_DIR], { stdio: "pipe" });
  }, 600_000);

  it("runs the agent in a clean clone, with only what was named, connected to serve", async () => {
    const seen: { secret?: string; connects: number } = { connects: 0 };
    let output = "";
    let dockerArgv: readonly string[] = [];
    const log: string[] = [];
    const code = await runRun({
      file: mandateFile(), ceiling: fixture("ceilings/org-policy-v12.cedar"),
      schema: fixture("ceilings/schema.cedarschema"),
      destinations: fixture("ceilings/org-policy-v12.destinations"),
      as: "alice", level: "push",
      agent: ["sh", "-c", AGENT_SCRIPT, "agent", MCP_CONFIG_PLACEHOLDER],
      sandbox: true, image: IMAGE, passEnv: ["ANTHROPIC_API_KEY"],
    }, (s) => log.push(s), {
      selfPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
      cwd: operatorRepo(),
      tty: false,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-e2e",
        GITHUB_TOKEN: "ghp_PLANTED_ENV",
        MANDATE_APP_KEY_PATH: "/nonexistent/app.pem",
      },
      startServe: fakeServe(seen),
      // Real docker, with its output captured instead of inherited. Async: the
      // listener shares this event loop.
      launch: (command, argv, env) => new Promise((resolve) => {
        dockerArgv = argv;
        execFile(command, [...argv], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 },
          (err, stdout, stderr) => {
            output = `${stdout}${stderr}`;
            resolve(err === null ? 0 : typeof err.code === "number" ? err.code : 1);
          });
      }),
    });

    const checks: Record<string, string> = {};
    for (const line of output.split("\n")) {
      const m = /^([a-z]+\.[a-z0-9-]+)=(.*)$/.exec(line.trim());
      if (m?.[1] !== undefined && m[2] !== undefined) checks[m[1]] = m[2];
    }
    const why = `${log.join("\n")}\n${output}`;

    expect(code, why).toBe(0);
    // The agent's MCP session reached serve through the relay, once.
    expect(checks["relay.mcp"], why).toBe("ok:host-serve");
    expect(seen.connects).toBe(1);
    // A clone of HEAD, copied to a directory the agent owns.
    expect(checks["ws.pwd"], why).toBe("/home/agent/workspace");
    expect(checks["ws.readme"], why).toBe("committed");
    expect(checks["ws.writable"], why).toBe("yes");
    // Nothing planted on the host side reached it.
    expect(checks["ws.dotenv"], why).toBe("absent");
    expect(checks["ws.remotes"], why).toBe("0");
    expect(checks["ws.config-credential"], why).toBe("absent");
    expect(checks["ws.hook"], why).toBe("absent");
    expect(checks["env.github-token"], why).toBe("absent");
    expect(checks["env.app-key"], why).toBe("absent");
    expect(checks["env.relay-secret"], why).toBe("absent");
    // What was named did reach it.
    expect(checks["env.passed"], why).toBe("sk-ant-e2e");
    expect(checks["config.arg"], why).toBe("exists");
    expect(checks["config.env"], why).toBe("matches");
    // And the run's argv never carried the secret.
    expect(dockerArgv.join(" ")).not.toContain(seen.secret ?? "unset");
  });
});
