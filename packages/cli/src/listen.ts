import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Where a sandboxed agent reaches `mandate serve`: one TCP connection, gated by
 * a secret.
 *
 * serve stays on the host because it holds the token, and the App key it mints
 * from. The agent is in a container, so the two need a channel, and the
 * obvious ones were probed on Docker Desktop 29.7.2 before this was written:
 *
 * - A host Unix socket bind-mounted into a container returns ENOTSUP. (macOS
 *   also caps a socket path at 104 bytes, which a scratch directory exceeds.)
 * - A host listener on 127.0.0.1 is reachable from **every** container through
 *   `host.docker.internal`, and the connection arrives looking like 127.0.0.1.
 *
 * So where a connection comes from proves nothing, and the first line has to.
 * After `MANDATE-RELAY/1 <secret>\n` the stream is MCP with stdio framing,
 * which is what the in-container relay forwards from the agent untouched.
 *
 * Exactly one connection is ever served. The session is one mandate's: a second
 * client would share its authority and spend its quota, and a reconnect is a
 * new session with a new token, which is `mandate run`'s to start.
 */
export const HANDSHAKE_PREFIX = "MANDATE-RELAY/1 ";

/** The handshake line is short; anything longer than this is not one. */
const MAX_HANDSHAKE_BYTES = 256;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export class ListenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListenError";
  }
}

export interface ListenOptions {
  /** A specific address. Loopback on Docker Desktop. */
  readonly host: string;
  /** 0 for an ephemeral port, read back from `AgentListener.port`. */
  readonly port: number;
  /** At least 32 random bytes, hex-encoded. */
  readonly secret: string;
  /** Called once, with the transport for the authenticated connection. */
  readonly connect: (transport: Transport) => Promise<void>;
  readonly handshakeTimeoutMs?: number;
}

export interface AgentListener {
  readonly host: string;
  readonly port: number;
  /** Resolves when the authenticated connection closes, or on `close()`. */
  readonly ended: Promise<void>;
  /** Stops listening and drops any connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * Compared as digests, so the comparison is constant-time whatever length the
 * peer sent: `timingSafeEqual` throws on unequal lengths, and a length check in
 * front of it would leak the length.
 */
const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

/** Throws unless `secret` is at least 32 bytes of hex. */
export function checkRelaySecret(secret: string): void {
  if (!/^[0-9a-f]{64,}$/i.test(secret)) {
    throw new ListenError(
      "the relay secret must be at least 32 random bytes, hex-encoded; anything a "
      + "container on this machine could guess would hand it the mandate's session",
    );
  }
}

/** Throws unless `host` is a specific IP address. */
export function checkListenHost(host: string): void {
  if (net.isIP(host) === 0) {
    throw new ListenError(`listen address ${JSON.stringify(host)} is not an IP address`);
  }
  if (host === "0.0.0.0" || host === "::") {
    throw new ListenError(
      `listen address ${host} is a wildcard; bind the one address the sandbox `
      + "reaches the host on, not every interface the host has",
    );
  }
}

/** `ip:port`, port 0 for ephemeral. IPv6 in brackets: `[::1]:0`. */
export function parseListenAddress(raw: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(raw);
  const host = m?.[1] ?? m?.[2];
  const port = Number(m?.[3]);
  if (host === undefined || !Number.isInteger(port) || port > 65535) {
    throw new ListenError(`listen address ${JSON.stringify(raw)} is not ip:port`);
  }
  checkListenHost(host);
  return { host, port };
}

export async function listenForAgent(opts: ListenOptions): Promise<AgentListener> {
  checkRelaySecret(opts.secret);
  checkListenHost(opts.host);

  const expected = `${HANDSHAKE_PREFIX}${opts.secret}`;
  const timeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const sockets = new Set<net.Socket>();
  let authenticated = false;
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((r) => { resolveEnded = r; });

  // No check for an already-authenticated listener here: `server.close()` runs
  // the moment one authenticates, and a closed server emits no connections.
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A peer that resets mid-handshake is not an error worth surfacing.
    socket.on("error", () => undefined);

    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > MAX_HANDSHAKE_BYTES) socket.destroy();
        return;
      }
      socket.off("data", onData);
      clearTimeout(timer);

      const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      // Two connections can both be mid-handshake, and only the first to finish
      // may win. This re-check and the destroy loop below each stop the second
      // on their own -- mutation-tested, each survives removal alone and the
      // pair does not. Both stay: the loop also frees half-open sockets at once
      // rather than at their timeout, and the re-check does not depend on it.
      if (authenticated || !sameSecret(line, expected)) {
        socket.destroy();
        return;
      }
      authenticated = true;
      // No further connections, and none left half-open from losing races.
      server.close();
      for (const other of sockets) if (other !== socket) other.destroy();

      socket.on("close", () => resolveEnded());
      // Whatever followed the newline is the start of the MCP stream.
      const rest = buf.subarray(nl + 1);
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      const transport = new StdioServerTransport(socket, socket);
      void opts.connect(transport).then(
        () => socket.resume(),
        () => socket.destroy(),
      );
    };
    socket.on("data", onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e) => reject(new ListenError(`cannot listen on ${opts.host}:${opts.port}: ${e.message}`)));
    server.listen(opts.port, opts.host, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new ListenError("the listener has no TCP address");
  }

  let closed = false;
  return {
    host: address.address,
    port: address.port,
    ended,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      resolveEnded();
    },
  };
}
