import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { compileEgress } from "@mandate-dev/compiler";
import { MandateSchema, markValidated } from "@mandate-dev/schema";
import { listenForAgent, type AgentListener } from "./listen.js";

/**
 * The sandboxed agent reaching `mandate serve` on the host, against a real
 * container (Task 5.1, PR a).
 *
 * The path is: agent (uid `agent`, no network) -> `mandate-mcp.mjs` over stdio
 * -> a container-local Unix socket -> `mandate-relay.mjs` (uid `relay`, one
 * iptables hole to the host port) -> TCP with the secret handshake ->
 * `listenForAgent` on the host. Each hop was chosen by probing Docker Desktop
 * 29.7.2: a host Unix socket bind-mounted in returns ENOTSUP, and a host
 * listener on 127.0.0.1 is reachable from every container.
 *
 * Docker Desktop only. On Linux `host.docker.internal` needs
 * `--add-host=host.docker.internal:host-gateway` and a host listener on
 * 127.0.0.1 is not reachable from a container at all, so serve would have to
 * bind the bridge address. That is unprobed, and a path nobody has run is not
 * one to claim.
 *
 *   MANDATE_SANDBOX=1 pnpm --filter @mandate-dev/cli test relay
 */
const enabled = process.env["MANDATE_SANDBOX"] === "1" && process.platform === "darwin";

const SANDBOX_DIR = fileURLToPath(new URL("../../../sandbox", import.meta.url));
const IMAGE = "mandate-sandbox-test";
const HOST_ALIAS = "host.docker.internal";

const squidConf = compileEgress(markValidated(MandateSchema.parse({
  mandate: "relay-test", task: "t", requestedBy: "user:a", expiresInMinutes: 60, ceiling: "c@v1",
  grants: [{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
  destinations: { allow: ["github.com/acme/api"] },
}), {
  ceilingId: "c@v1", userLevel: "push", checkedAt: "2026-10-09T00:00:00.000Z", grantProofs: [],
})).squidConf;

/** serve's stand-in: the real listener, in front of a server with a known name. */
async function hostServe(secret: string): Promise<{ listener: AgentListener; connects: () => number }> {
  let connects = 0;
  const listener = await listenForAgent({
    host: "127.0.0.1", port: 0, secret,
    connect: async (t) => {
      connects += 1;
      const s = new Server({ name: "host-serve", version: "0" }, { capabilities: { tools: {} } });
      s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      await s.connect(t);
    },
  });
  return { listener, connects: () => connects };
}

/**
 * Asynchronous on purpose. The host listener runs in this same process, so a
 * synchronous `docker run` blocks the event loop it needs to accept the relay's
 * connection -- the first version did exactly that, and every relay check
 * timed out for a reason that had nothing to do with the relay.
 */
async function docker(args: readonly string[]): Promise<{ status: number; output: string }> {
  return new Promise((resolve) => {
    execFile("docker", [...args], { encoding: "utf8", timeout: 90_000 }, (err, stdout, stderr) => {
      const status = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ status, output: `${stdout}${stderr}` });
    });
  });
}

const parseChecks = (output: string): Record<string, string> => {
  const checks: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = /^((?:proxy|direct|env|proc|relay)\.[a-z0-9-]+)=(.+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) checks[m[1]] = m[2];
  }
  return checks;
};

async function runSandbox(opts: {
  port: number; secret: string; entrypoint?: string; otherPort?: number;
  network?: string; v6Target?: string;
}): Promise<{ status: number; output: string; checks: Record<string, string> }> {
  const args = [
    "run", "--rm", "--cap-add=NET_ADMIN",
    "-e", `MANDATE_SQUID_CONF=${squidConf}`,
    "-e", `MANDATE_RELAY_TARGET=${HOST_ALIAS}:${opts.port}`,
    "-e", `MANDATE_RELAY_SECRET=${opts.secret}`,
  ];
  if (opts.entrypoint !== undefined) {
    args.push("-v", `${opts.entrypoint}:/usr/local/bin/entrypoint.sh:ro`);
  }
  if (opts.otherPort !== undefined) {
    args.push("-e", `MANDATE_VERIFY_HOST_OTHER_PORT=${opts.otherPort}`);
  }
  if (opts.network !== undefined) args.push("--network", opts.network);
  if (opts.v6Target !== undefined) args.push("-e", `MANDATE_VERIFY_V6_TARGET=${opts.v6Target}`);
  args.push(IMAGE, "node", "/usr/local/lib/mandate-verify.mjs");
  const { status, output } = await docker(args);
  return { status, output, checks: parseChecks(output) };
}

/** The real entrypoint with one edit, so a control differs in exactly one rule. */
function entrypointWith(name: string, edit: (src: string) => string): string {
  const src = readFileSync(join(SANDBOX_DIR, "entrypoint.sh"), "utf8");
  const out = edit(src);
  expect(out, `${name} must change the entrypoint`).not.toBe(src);
  const path = join(tmpdir(), `mandate-${name}-entrypoint.sh`);
  writeFileSync(path, out, "utf8");
  chmodSync(path, 0o755);
  return path;
}

const secret = (): string => randomBytes(32).toString("hex");

/** A plain listener on another host port, so "one port" can be told from "the host". */
async function otherHostPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = net.createServer((c) => c.end());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return { port: addr.port, close: () => new Promise((r) => srv.close(() => r())) };
}

/**
 * An IPv6-enabled network with a listener, as in the compiler's sandbox test.
 * The relay uid's IPv6 REJECT is invisible on the default bridge, where eth0
 * has IPv6 disabled -- the same blind spot that hid the agent's v6 leak.
 */
const V6_NETWORK = "mandate-relay-v6-test";
const V6_LISTENER = "mandate-relay-v6-listener";

async function startV6Listener(): Promise<string> {
  await stopV6Listener();
  await docker(["network", "create", "--ipv6", V6_NETWORK]);
  await docker([
    "run", "-d", "--rm", "--name", V6_LISTENER, "--network", V6_NETWORK,
    "--entrypoint", "node", IMAGE, "-e",
    'require("net").createServer((c) => c.end("hi")).listen(47814, "::")',
  ]);
  const { output } = await docker([
    "inspect", V6_LISTENER, "--format",
    "{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}",
  ]);
  const addr = output.trim();
  if (addr === "") throw new Error(`${V6_LISTENER} has no IPv6 address`);
  return `${addr} 47814`;
}

async function stopV6Listener(): Promise<void> {
  await docker(["rm", "-f", V6_LISTENER]);
  await docker(["network", "rm", V6_NETWORK]);
}

/**
 * The real rules, with the command run as `relay` instead of `agent`. Every
 * other check runs as the agent; this is the only way to see what the relay's
 * own hole admits. Not a weakened sandbox -- the same rules, a different seat.
 */
const AS_RELAY = (src: string): string =>
  src.replace("setpriv --reuid=agent --regid=agent", "setpriv --reuid=relay --regid=relay");

describe.skipIf(!enabled)("the sandbox relay, against a real container", { timeout: 120_000 }, () => {
  beforeAll(() => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, SANDBOX_DIR], { stdio: "pipe" });
  }, 600_000);

  it("carries the agent's MCP session to serve on the host", async () => {
    const s = secret();
    const { listener, connects } = await hostServe(s);
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: s });
      expect(checks["relay.mcp"], output).toBe("ok:host-serve");
      expect(connects()).toBe(1);
    } finally { await listener.close(); }
  });

  // The hole is the relay uid's, not the agent's. An agent that could reach the
  // port itself could skip the relay, and with it nothing would change -- but
  // it would also mean the agent's uid had network, which it must not.
  it("leaves the agent unable to reach serve's port directly", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: s });
      expect(checks["direct.relay-target"], output).toMatch(/^blocked:/);
    } finally { await listener.close(); }
  });

  it("keeps the secret out of the agent's environment and out of its reach", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: s });
      expect(checks["env.relay-secret"], output).toBe("absent");
      expect(checks["proc.relay-environ"], output).toMatch(/^unreadable:/);
    } finally { await listener.close(); }
  });

  it("gives the relay uid serve's one port and nothing else", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    const other = await otherHostPort();
    try {
      const { checks, output } = await runSandbox({
        port: listener.port, secret: s, otherPort: other.port,
        entrypoint: entrypointWith("as-relay", AS_RELAY),
      });
      // Its hole: the port serve listens on.
      expect(checks["direct.relay-target"], output).toBe("LEAKED");
      // Not the host: another port there, with a listener on it, is refused.
      expect(checks["direct.relay-host-other-port"], output).toMatch(/^blocked:/);
      // Not the internet.
      expect(checks["direct.unlisted-ip"], output).toMatch(/^blocked:/);
    } finally { await listener.close(); await other.close(); }
  });

  it("closes IPv6 to the relay uid as well", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    const v6Target = await startV6Listener();
    try {
      const { checks, output } = await runSandbox({
        port: listener.port, secret: s, network: V6_NETWORK, v6Target,
        entrypoint: entrypointWith("as-relay-v6", AS_RELAY),
      });
      expect(checks["direct.ipv6"], output).toMatch(/^blocked:/);
    } finally { await listener.close(); await stopV6Listener(); }
  });

  it("gets the agent nothing when the relay's secret is wrong", async () => {
    const { listener, connects } = await hostServe(secret());
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: secret() });
      expect(checks["relay.mcp"], output).toMatch(/^failed:/);
      expect(connects()).toBe(0);
    } finally { await listener.close(); }
  });

  it("refuses to start with a relay target and no secret", async () => {
    const { status, output } = await docker([
      "run", "--rm", "--cap-add=NET_ADMIN",
      "-e", `MANDATE_SQUID_CONF=${squidConf}`,
      "-e", `MANDATE_RELAY_TARGET=${HOST_ALIAS}:1`,
      IMAGE, "node", "/usr/local/lib/mandate-verify.mjs",
    ]);
    expect(status).not.toBe(0);
    expect(output).toMatch(/MANDATE_RELAY_SECRET/);
    expect(parseChecks(output)).toEqual({});
  });
});

// Negative controls: each check above has to be able to fail.
describe.skipIf(!enabled)("the relay checks discriminate", { timeout: 120_000 }, () => {
  beforeAll(() => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, SANDBOX_DIR], { stdio: "pipe" });
  }, 600_000);

  it("carries nothing once the relay's iptables hole is removed", async () => {
    const s = secret();
    const { listener, connects } = await hostServe(s);
    const path = entrypointWith("no-relay-hole", (src) =>
      src.replace(/^(\s*)iptables -A OUTPUT -m owner --uid-owner relay -d .*$/m, "$1true"));
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: s, entrypoint: path });
      expect(checks["relay.mcp"], output).toMatch(/^failed:/);
      expect(connects()).toBe(0);
    } finally { await listener.close(); }
  });

  it("reaches another host port as the relay once the hole loses its --dport", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    const other = await otherHostPort();
    const path = entrypointWith("relay-any-port", (src) =>
      AS_RELAY(src).replace(' -p tcp --dport "$relay_port" -j ACCEPT', " -j ACCEPT"));
    try {
      const { checks, output } = await runSandbox({
        port: listener.port, secret: s, otherPort: other.port, entrypoint: path,
      });
      expect(checks["direct.relay-host-other-port"], output).toBe("LEAKED");
    } finally { await listener.close(); await other.close(); }
  });

  it("reaches the internet as the relay once its REJECT is removed", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    const path = entrypointWith("no-relay-reject", (src) =>
      AS_RELAY(src).replace(/^iptables -A OUTPUT -m owner --uid-owner relay -j REJECT$/m, "true"));
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: s, entrypoint: path });
      expect(checks["direct.unlisted-ip"], output).toBe("LEAKED");
    } finally { await listener.close(); }
  });

  it("reaches IPv6 as the relay once its ip6tables REJECT is removed", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    const v6Target = await startV6Listener();
    const path = entrypointWith("no-relay-v6-reject", (src) =>
      AS_RELAY(src).replace(/^(\s*)ip6tables -A OUTPUT -m owner --uid-owner relay -j REJECT$/m, "$1true"));
    try {
      const { checks, output } = await runSandbox({
        port: listener.port, secret: s, network: V6_NETWORK, v6Target, entrypoint: path,
      });
      expect(checks["direct.ipv6"], output).toBe("LEAKED");
    } finally { await listener.close(); await stopV6Listener(); }
  });

  it("lets the agent reach serve's port once the agent's REJECT is removed", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    const path = entrypointWith("no-agent-reject", (src) =>
      src.replace(/^iptables -A OUTPUT -m owner --uid-owner agent -j REJECT$/m, "true"));
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: s, entrypoint: path });
      expect(checks["direct.relay-target"], output).toBe("LEAKED");
    } finally { await listener.close(); }
  });

  it("hands the agent the secret once the entrypoint stops stripping it", async () => {
    const s = secret();
    const { listener } = await hostServe(s);
    const path = entrypointWith("no-env-strip", (src) =>
      src.replace(/ -u MANDATE_RELAY_SECRET/, ""));
    try {
      const { checks, output } = await runSandbox({ port: listener.port, secret: s, entrypoint: path });
      expect(checks["env.relay-secret"], output).toBe("PRESENT");
    } finally { await listener.close(); }
  });
});
