// Runs inside the sandbox as `agent` and prints one `name=result` line per
// check. The integration test asserts on these lines; a human can run it with
//
//   docker run --rm --cap-add=NET_ADMIN -e MANDATE_SQUID_CONF="..." \
//     mandate-sandbox node /usr/local/lib/mandate-verify.mjs
//
// Raw sockets on purpose: no HTTP client, no proxy-agent library, nothing that
// could succeed or fail for a reason other than the rules under test.
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
    : [["direct.allowed-host-ip", () => direct(allowedIp, 443)]]),
  // No DNS of its own.
  ["direct.dns", () => direct("1.1.1.1", 53)],
];

for (const [name, run] of checks) {
  console.log(`${name}=${await run()}`);
}
