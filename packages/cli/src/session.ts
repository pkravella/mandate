import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { proofOf, type ValidatedMandate } from "@mandate-dev/schema";
import {
  capToCredential, compileRules, mintToken, revokeToken,
  type MintDeps, type MintedToken, type ProxyRules,
} from "@mandate-dev/compiler";
import {
  createProxyServer, makeArgumentEnforcer, Recorder, type Decision,
} from "@mandate-dev/proxy";

/**
 * Opens an enforced session around a validated mandate: mint, compile, connect
 * the upstream, build the proxy.
 *
 * This exists because there were about to be two of it. The whole sequence
 * already lived inside `runBench`, entangled with corpus iteration, ground
 * truth and cost accounting, and `mandate run` needs exactly the same five
 * steps. Writing a second copy is the mistake that invalidated a $0.97
 * benchmark sweep in Phase 3 — two copies of the task prompt, one of which
 * asked for a pull request — and here the stakes are higher than a prompt: if
 * the benchmark and the command drift, the published numbers describe something
 * other than what the command enforces.
 *
 * The caller connects the returned `Server` to whatever transport it needs. The
 * benchmark pairs it with an in-memory client; `mandate serve` serves it on
 * stdio, because that is how an agent spawns an MCP server.
 */
export interface SessionOptions {
  readonly mandate: ValidatedMandate;
  readonly github: MintDeps;
  /**
   * Connects the upstream MCP server the proxy sits in front of, given the
   * minted token.
   *
   * Injectable, and that is the point: it was a hardcoded `docker run` inside
   * `runBench`, which is the single reason the harness that produces the
   * published metrics had no offline test. A fake upstream here makes the whole
   * loop testable for nothing.
   */
  readonly upstream?: (token: string) => Promise<Client>;
  readonly onDecision?: (d: Decision) => void;
}

export interface Session {
  readonly rules: ProxyRules;
  readonly minted: MintedToken;
  readonly proxy: Server;
  readonly upstream: Client;
  /**
   * The action graph for this session.
   *
   * Always present, not an option. R8 is "record every call", so a session that
   * does not record is not an enforced session — and the recorder needs the
   * compiled `mandateHash` to tag its header, which only exists once the rules
   * are compiled. Making the caller build it meant either passing the hash out
   * before the session existed or compiling the rules twice, and a derived
   * value computed in two places is one that drifts.
   */
  readonly recorder: Recorder;
  /**
   * Revokes the token and closes the upstream. Idempotent, and never throws:
   * a session that cannot be torn down must not mask the result of the work it
   * was holding open, and the token expires within the hour regardless.
   */
  close(): Promise<void>;
}

/** The real upstream: `github-mcp-server` in Docker, holding only this token. */
export const dockerUpstream = (image = "ghcr.io/github/github-mcp-server:latest") =>
  async (token: string): Promise<Client> => {
    const transport = new StdioClientTransport({
      command: "docker",
      // The token reaches the container through the environment, never through
      // argv, which is world-readable in a process list.
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", image],
      env: {
        ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: token,
      } as Record<string, string>,
    });
    const client = new Client({ name: "mandate-upstream", version: "0.1.0" });
    await client.connect(transport);
    return client;
  };

export async function openSession(opts: SessionOptions): Promise<Session> {
  const minted = await mintToken(opts.github, opts.mandate);

  // Everything after the mint has to be able to give the token back. A throw
  // between here and the return would otherwise leave a live repository-scoped
  // token with nothing holding a reference to it.
  let upstream: Client | undefined;
  try {
    // The earlier of the two clocks: a mandate that would outlive its token
    // ends a margin before the token does, rather than allowing calls the
    // upstream can only answer with a 401. See capToCredential.
    const rules = capToCredential(compileRules(opts.mandate), minted.expiresAt);
    upstream = await (opts.upstream ?? dockerUpstream())(minted.token);

    // The proof's first reader: which ceiling the mandate was proved against,
    // by label and by content, goes in the one record that persists.
    const proof = proofOf(opts.mandate);
    const recorder = new Recorder({
      mode: "enforced", mandateId: rules.mandateId, mandateHash: rules.mandateHash,
      ceiling: { label: proof.ceilingId, sha256: proof.ceilingSha256 },
    });
    const proxy = createProxyServer({
      rules,
      upstream,
      enforceArguments: makeArgumentEnforcer(rules),
      recorder,
      ...(opts.onDecision === undefined ? {} : { onDecision: opts.onDecision }),
    });

    const connected = upstream;
    let closed = false;
    return {
      rules,
      minted,
      proxy,
      recorder,
      upstream: connected,
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          await connected.close();
        } catch {
          // Nothing useful to do; the revoke below is the part that matters.
        }
        await revokeToken(opts.github, minted.token).catch(() => undefined);
      },
    };
  } catch (e) {
    if (upstream !== undefined) await upstream.close().catch(() => undefined);
    await revokeToken(opts.github, minted.token).catch(() => undefined);
    throw e;
  }
}
