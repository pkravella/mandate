import { randomBytes } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HANDSHAKE_PREFIX, ListenError, listenForAgent, type AgentListener } from "./listen.js";

/**
 * The sandboxed agent reaches `mandate serve` over TCP, because a host Unix
 * socket bind-mounted into a container returns ENOTSUP on Docker Desktop
 * (probed). And on Docker Desktop a host listener on 127.0.0.1 is reachable
 * from *every* container, seen as 127.0.0.1 -- so arriving is not evidence of
 * being the agent. The secret is what is.
 */

const secret = (): string => randomBytes(32).toString("hex");

/** A client transport over a socket that has already sent the handshake. */
class SocketTransport implements Transport {
  readonly #buf = new ReadBuffer();
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (m: JSONRPCMessage) => void;
  constructor(private readonly socket: net.Socket) {}
  async start(): Promise<void> {
    this.socket.on("data", (d: Buffer) => {
      this.#buf.append(d);
      for (let m = this.#buf.readMessage(); m !== null; m = this.#buf.readMessage()) {
        this.onmessage?.(m);
      }
    });
    this.socket.on("close", () => this.onclose?.());
  }
  async send(m: JSONRPCMessage): Promise<void> { this.socket.write(serializeMessage(m)); }
  async close(): Promise<void> { this.socket.destroy(); }
}

const fakeServer = (): Server => {
  const s = new Server({ name: "fake-serve", version: "0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "get_file_contents", inputSchema: { type: "object" as const } }],
  }));
  return s;
};

const open: AgentListener[] = [];
afterEach(async () => { for (const l of open.splice(0)) await l.close(); });

/**
 * A fresh Server per transport, and a count of how many were connected.
 *
 * Not one shared Server: the SDK's `Protocol.connect` throws "Already
 * connected" on a second transport, so a shared fake enforces single-session
 * by itself and every one of the listener's own guards survived deletion
 * against it. Production has that backstop only while the first transport is
 * attached; once it closes, the SDK would accept another.
 */
const listen = async (s: string, opts: { handshakeTimeoutMs?: number } = {}) => {
  let connects = 0;
  const l = await listenForAgent({
    host: "127.0.0.1", port: 0, secret: s,
    connect: async (t) => { connects += 1; await fakeServer().connect(t); },
    ...opts,
  });
  open.push(l);
  return Object.assign(l, { connects: () => connects });
};

const dial = (l: AgentListener): Promise<net.Socket> => new Promise((resolve, reject) => {
  const sock = net.connect(l.port, l.host, () => resolve(sock));
  sock.on("error", reject);
});

/** Resolves when the peer closes the socket, with whatever it sent first. */
const closedWith = (sock: net.Socket): Promise<string> => new Promise((resolve) => {
  let got = "";
  sock.on("data", (d: Buffer) => { got += d.toString("utf8"); });
  sock.on("close", () => resolve(got));
});

const agentOver = async (sock: net.Socket): Promise<Client> => {
  const c = new Client({ name: "agent", version: "0" });
  await c.connect(new SocketTransport(sock));
  return c;
};

describe("listenForAgent", () => {
  it("binds the address it was given, on an ephemeral port", async () => {
    const l = await listen(secret());
    expect(l.host).toBe("127.0.0.1");
    expect(l.port).toBeGreaterThan(0);
  });

  it("serves MCP to a connection that presents the secret", async () => {
    const s = secret();
    const l = await listen(s);
    const sock = await dial(l);
    sock.write(`${HANDSHAKE_PREFIX}${s}\n`);
    const agent = await agentOver(sock);
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_file_contents"]);
    await agent.close();
  });

  // The relay writes the handshake and the client's first request back to
  // back, and TCP may deliver them in one chunk. Bytes after the newline belong
  // to MCP and must not be lost with the handshake.
  it("keeps MCP bytes that arrive in the same chunk as the handshake", async () => {
    const s = secret();
    const l = await listen(s);
    const sock = await dial(l);
    const init = serializeMessage({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a", version: "0" } },
    });
    const reply = new Promise<string>((resolve) => {
      sock.once("data", (d: Buffer) => resolve(d.toString("utf8")));
    });
    sock.write(`${HANDSHAKE_PREFIX}${s}\n${init}`);
    expect(JSON.parse(await reply)).toMatchObject({ id: 1, result: { serverInfo: { name: "fake-serve" } } });
    sock.destroy();
  });

  it("closes a connection with the wrong secret without answering it", async () => {
    const l = await listen(secret());
    const sock = await dial(l);
    const done = closedWith(sock);
    sock.write(`${HANDSHAKE_PREFIX}${secret()}\n`);
    expect(await done).toBe("");
  });

  it("closes a connection that never sends the handshake line", async () => {
    const l = await listen(secret(), { handshakeTimeoutMs: 50 });
    const sock = await dial(l);
    expect(await closedWith(sock)).toBe("");
  });

  // Another container got there first with a wrong guess. The agent's
  // connection after it must still be served, or any container on the machine
  // could deny the agent its tools by connecting early.
  it("still serves the agent after a failed attempt", async () => {
    const s = secret();
    const l = await listen(s);
    const intruder = await dial(l);
    const refused = closedWith(intruder);
    intruder.write(`${HANDSHAKE_PREFIX}${secret()}\n`);
    await refused;
    const sock = await dial(l);
    sock.write(`${HANDSHAKE_PREFIX}${s}\n`);
    const agent = await agentOver(sock);
    expect((await agent.listTools()).tools).toHaveLength(1);
    await agent.close();
  });

  // One mandate, one session. A second authenticated connection would be a
  // second agent sharing the first one's authority and quota.
  it("accepts exactly one authenticated connection", async () => {
    const s = secret();
    const l = await listen(s);
    const first = await dial(l);
    first.write(`${HANDSHAKE_PREFIX}${s}\n`);
    const agent = await agentOver(first);
    await agent.listTools();

    const second = await new Promise<string>((resolve) => {
      const sock = net.connect(l.port, l.host);
      sock.on("error", (e: NodeJS.ErrnoException) => resolve(`error:${e.code ?? ""}`));
      sock.on("connect", () => {
        sock.write(`${HANDSHAKE_PREFIX}${s}\n`);
        void closedWith(sock).then((got) => resolve(`closed:${got}`));
      });
    });
    expect(second === "closed:" || second === "error:ECONNREFUSED").toBe(true);
    expect(l.connects()).toBe(1);
    await agent.close();
  });

  // Two connections both mid-handshake, both then presenting the secret: the
  // first to finish wins and the second must not become a second session.
  it("drops a connection that was mid-handshake when another authenticated", async () => {
    const s = secret();
    const l = await listen(s);
    const first = await dial(l);
    const second = await dial(l);
    second.write(HANDSHAKE_PREFIX);
    const secondDone = closedWith(second);
    first.write(`${HANDSHAKE_PREFIX}${s}\n`);
    const agent = await agentOver(first);
    await agent.listTools();
    second.write(`${s}\n`);
    expect(await secondDone).toBe("");
    expect(l.connects()).toBe(1);
    await agent.close();
  });

  // A peer streaming bytes with no newline is not sending a handshake, and is
  // closed on size rather than allowed to fill memory until the timeout.
  it("closes a peer whose first line is longer than any handshake", async () => {
    const l = await listen(secret(), { handshakeTimeoutMs: 60_000 });
    const sock = await dial(l);
    const done = closedWith(sock);
    sock.write("x".repeat(1024));
    expect(await done).toBe("");
  });

  // After the agent's connection ends the session is over. A reconnect is a new
  // session with a new token, which is `mandate run`'s to start, not this
  // listener's to accept.
  it("does not accept a new connection after the first one closed", async () => {
    const s = secret();
    const l = await listen(s);
    const first = await dial(l);
    first.write(`${HANDSHAKE_PREFIX}${s}\n`);
    const agent = await agentOver(first);
    await agent.listTools();
    first.destroy();
    await l.ended;
    const again = await new Promise<string>((resolve) => {
      const sock = net.connect(l.port, l.host);
      sock.on("error", (e: NodeJS.ErrnoException) => resolve(`error:${e.code ?? ""}`));
      sock.on("connect", () => {
        sock.write(`${HANDSHAKE_PREFIX}${s}\n`);
        void closedWith(sock).then((got) => resolve(`closed:${got}`));
      });
    });
    expect(again === "closed:" || again === "error:ECONNREFUSED").toBe(true);
    expect(l.connects()).toBe(1);
  });

  it("resolves ended when the authenticated connection closes", async () => {
    const s = secret();
    const l = await listen(s);
    let ended = false;
    void l.ended.then(() => { ended = true; });
    const sock = await dial(l);
    sock.write(`${HANDSHAKE_PREFIX}${s}\n`);
    const agent = await agentOver(sock);
    await agent.listTools();
    expect(ended).toBe(false);
    sock.destroy();
    await l.ended;
    expect(ended).toBe(true);
  });

  it("does not resolve ended for a connection that failed the handshake", async () => {
    const l = await listen(secret());
    let ended = false;
    void l.ended.then(() => { ended = true; });
    const sock = await dial(l);
    const done = closedWith(sock);
    sock.write(`${HANDSHAKE_PREFIX}wrong\n`);
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(false);
  });

  it("refuses a secret shorter than 32 bytes of hex", async () => {
    await expect(listenForAgent({
      host: "127.0.0.1", port: 0, secret: "ab".repeat(31), connect: async () => undefined,
    })).rejects.toThrow(ListenError);
    await expect(listenForAgent({
      host: "127.0.0.1", port: 0, secret: "", connect: async () => undefined,
    })).rejects.toThrow(ListenError);
  });

  // A wildcard bind would put the session on every interface the host has,
  // the LAN included. The secret still gates it, but there is no reason to
  // offer it there.
  it("refuses a wildcard address", async () => {
    for (const host of ["0.0.0.0", "::"]) {
      await expect(listenForAgent({
        host, port: 0, secret: secret(), connect: async () => undefined,
      })).rejects.toThrow(/wildcard/);
    }
  });
});
