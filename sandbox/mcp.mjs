// What the agent's MCP config names as its server command inside the sandbox:
//
//   { "command": "node", "args": ["/usr/local/lib/mandate-mcp.mjs"] }
//
// It joins the agent's stdio to the relay's socket and nothing else. It holds
// no secret and makes no decision; `mandate serve` on the host does both.
import net from "node:net";

const socket = net.connect("/run/mandate/mcp.sock");
socket.on("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (e) => {
  console.error(`mandate-mcp: cannot reach the relay: ${e.code ?? e.message}`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
