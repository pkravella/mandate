// The sandbox end of the agent's MCP channel. Runs as uid `relay`, the only
// uid with a route to the host, and only to `mandate serve`'s one port.
//
//   agent --stdio--> mandate-mcp.mjs --/run/mandate/mcp.sock--> this
//         --TCP + secret--> mandate serve --listen, on the host
//
// The agent never sees the secret: it is in this process's environment, which
// another uid cannot read, and the entrypoint strips it before the agent starts.
// It would gain nothing by having it -- this relay already forwards for it --
// but every other container on a Docker Desktop host can reach serve's port,
// and the secret is what tells serve this connection is the agent's.
import { chmodSync, rmSync } from "node:fs";
import net from "node:net";

const SOCKET = "/run/mandate/mcp.sock";
const HANDSHAKE_PREFIX = "MANDATE-RELAY/1 ";

const target = process.env["MANDATE_RELAY_TARGET"] ?? "";
const secret = process.env["MANDATE_RELAY_SECRET"] ?? "";
delete process.env["MANDATE_RELAY_SECRET"];

const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(target);
if (m === null || secret.length === 0) {
  console.error(`mandate-relay: need MANDATE_RELAY_TARGET as ip:port and MANDATE_RELAY_SECRET`);
  process.exit(1);
}
const [, host, port] = m;

rmSync(SOCKET, { force: true });
// The socket is created by bind(), with this process's umask, before listen's
// callback can chmod it -- and the entrypoint starts the agent as soon as the
// socket exists. Found reviewing Phase 5: in that gap the agent could find it
// unwritable. Created world-writable from the start; the directory is the
// access boundary.
process.umask(0);
const server = net.createServer((agent) => {
  const upstream = net.connect(Number(port), host, () => {
    // Written before any agent byte is piped, so it is always the first line.
    upstream.write(`${HANDSHAKE_PREFIX}${secret}\n`);
    agent.pipe(upstream);
    upstream.pipe(agent);
  });
  const drop = () => { agent.destroy(); upstream.destroy(); };
  agent.on("error", drop);
  upstream.on("error", (e) => {
    console.error(`mandate-relay: cannot reach mandate serve at ${host}:${port}: ${e.code ?? e.message}`);
    drop();
  });
  agent.on("close", drop);
  upstream.on("close", drop);
});
server.listen(SOCKET, () => {
  // The agent connects as another uid. The directory is the access boundary:
  // only the agent and this relay exist to reach it.
  chmodSync(SOCKET, 0o666);
});
