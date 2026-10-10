// Runs inside the sandbox as `agent` and prints one `name=result` line per
// check. The integration test asserts on these lines; a human can run it with
//
//   docker run --rm --cap-add=NET_ADMIN -e MANDATE_SQUID_CONF="..." \
//     mandate-sandbox node /usr/local/lib/mandate-verify.mjs
//
// Raw sockets on purpose: no HTTP client, no proxy-agent library, nothing that
// could succeed or fail for a reason other than the rules under test.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";

const TIMEOUT_MS = 10_000;

/** The status code squid answers a CONNECT with. */
const viaProxy = (host, port) => new Promise((resolve) => {
  const s = net.connect(3128, "127.0.0.1");
  let buf = "";
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(TIMEOUT_MS, () => done("timeout"));
  s.on("error", (e) => done(`proxy-unreachable:${e.code ?? e.message}`));
  s.on("connect", () => s.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`,
  ));
  s.on("data", (d) => {
    buf += d.toString("utf8");
    if (buf.includes("\r\n")) done(buf.split("\r\n")[0].split(" ")[1] ?? "unparsed");
  });
});

/** Whether a direct connection, bypassing the proxy entirely, gets out. */
const direct = (host, port) => new Promise((resolve) => {
  const s = net.connect(port, host);
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(TIMEOUT_MS, () => done("blocked:timeout"));
  s.on("error", (e) => done(`blocked:${e.code ?? e.message}`));
  s.on("connect", () => done("LEAKED"));
});

const allowedIp = process.env["MANDATE_VERIFY_ALLOWED_IP"];

// `addr port` of a listener reachable over IPv6. Passed in because there is no
// public IPv6 target every network can reach; the gated test stands one up on
// an IPv6-enabled Docker network, which is where the leak was measured.
const [v6Addr, v6Port] = (process.env["MANDATE_VERIFY_V6_TARGET"] ?? "").split(" ");

const checks = [
  // The proxy enforces the mandate's allowlist.
  ["proxy.allowed", () => viaProxy("github.com", 443)],
  ["proxy.subdomain-of-allowed", () => viaProxy("gist.github.com", 443)],
  ["proxy.unlisted", () => viaProxy("evil.example.com", 443)],
  ["proxy.allowed-host-other-port", () => viaProxy("github.com", 22)],
  // iptables makes the proxy the only route, so even an allowed host is
  // unreachable directly. By IP, because the agent has no DNS either.
  ["direct.unlisted-ip", () => direct("1.1.1.1", 443)],
  ...(allowedIp === undefined
    ? []
    : [
      ["direct.allowed-host-ip", () => direct(allowedIp, 443)],
      // The same address through the proxy. squid matches an IP-literal
      // request by its PTR record unless told not to, and a PTR says whatever
      // the address's owner wants -- an allowed host's IP must still be refused.
      ["proxy.allowed-host-ip", () => viaProxy(allowedIp, 443)],
    ]),
  // No DNS of its own.
  ["direct.dns", () => direct("1.1.1.1", 53)],
  // The same rules over IPv6. iptables alone covers IPv4 only, and on a Docker
  // network with IPv6 enabled the agent got straight out without it.
  ...(v6Addr === undefined || v6Addr === "" || v6Port === undefined
    ? []
    : [["direct.ipv6", () => direct(v6Addr, Number(v6Port))]]),
];

// The relay to `mandate serve`, when the sandbox was started with one. The
// entrypoint rewrites MANDATE_RELAY_TARGET to the resolved `ip:port`, because
// neither the agent nor the relay has a resolver.
const relayTarget = process.env["MANDATE_RELAY_TARGET"];

/** Whether an MCP initialize through the agent's shim gets an answer, and from whom. */
const relayMcp = () => new Promise((resolve) => {
  const child = spawn("node", ["/usr/local/lib/mandate-mcp.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const timer = setTimeout(() => { child.kill(); resolve("failed:timeout"); }, TIMEOUT_MS);
  child.stdout.on("data", (d) => {
    out += d.toString("utf8");
    const nl = out.indexOf("\n");
    if (nl === -1) return;
    clearTimeout(timer);
    child.kill();
    try {
      resolve(`ok:${JSON.parse(out.slice(0, nl)).result.serverInfo.name}`);
    } catch {
      resolve("failed:unparsed");
    }
  });
  child.stderr.on("data", (d) => { err += d.toString("utf8"); });
  child.on("close", () => { clearTimeout(timer); resolve(`failed:closed${err ? `:${err.trim().split("\n")[0]}` : ""}`); });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } },
  })}\n`);
});

/** Whether this uid can read the relay process's environment, where the secret is. */
const relayEnviron = () => {
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    let cmdline = "";
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (!cmdline.includes("mandate-relay.mjs")) continue;
    try {
      readFileSync(`/proc/${pid}/environ`);
      return "READABLE";
    } catch (e) {
      return `unreadable:${e.code ?? e.message}`;
    }
  }
  return "no-relay-process";
};

if (relayTarget !== undefined) {
  const [ip, port] = relayTarget.split(":");
  checks.push(
    // The hole is the relay uid's. The agent itself must not reach the port.
    // FIRST, while serve is still listening: it accepts one session and then
    // closes, so after relay.mcp this would read "refused" whatever the rules
    // said -- which is how the first version passed its negative control.
    ["direct.relay-target", () => direct(ip, Number(port))],
    ["relay.mcp", relayMcp],
    ["env.relay-secret", async () => (process.env["MANDATE_RELAY_SECRET"] === undefined ? "absent" : "PRESENT")],
    ["proc.relay-environ", async () => relayEnviron()],
  );
  // Another port on the same host, for a run made as the relay uid: its hole
  // is one port, not the host.
  const otherPort = process.env["MANDATE_VERIFY_HOST_OTHER_PORT"];
  if (otherPort !== undefined) {
    checks.push(["direct.relay-host-other-port", () => direct(ip, Number(otherPort))]);
  }
}

// What this process could regain. Found reviewing Phase 5: setpriv dropped the
// uid but left no_new_privs off and the bounding set full, so a setuid binary
// in the image would have come back with every capability the container has,
// NET_ADMIN -- the one that rewrites the firewall -- included.
const statusField = (name) => {
  const line = readFileSync("/proc/self/status", "utf8").split("\n").find((l) => l.startsWith(`${name}:`));
  return line === undefined ? "missing" : line.slice(name.length + 1).trim();
};
checks.push(
  ["proc.no-new-privs", async () => statusField("NoNewPrivs")],
  ["proc.cap-bounding", async () => statusField("CapBnd")],
);

// The proxy a well-behaved tool will use. Set by the entrypoint, not the image.
checks.push(["env.https-proxy", async () => process.env["HTTPS_PROXY"] ?? "unset"]);

for (const [name, run] of checks) {
  console.log(`${name}=${await run()}`);
}
