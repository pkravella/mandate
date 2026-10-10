import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { markValidated, parseMandateYaml, type ValidatedMandate } from "@mandate-dev/schema";
import type { MintDeps } from "@mandate-dev/compiler";
import { openSession } from "./session.js";

/**
 * The enforced session: mint, compile, connect upstream, build the proxy.
 *
 * The tear-down is the part worth testing hardest. A session holds a live
 * repository-scoped token, so every path out of `openSession` — including the
 * ones that throw partway through — has to give it back.
 */
const MANDATE_YAML = `
mandate: fix-issue-42
task: "Fix issue #42 and open a PR"
requestedBy: user:alice
expiresInMinutes: 30
ceiling: org-policy@v12
grants:
  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-fix"]
    paths: ["src/**"]
    denyPaths: [".github/workflows/**"]
destinations:
  allow: ["github.com/acme/api"]
`;

/**
 * A mandate marked validated directly. `openSession` takes a
 * `ValidatedMandate` precisely so it cannot be handed model output, and the
 * brand's constructor is the validator's — so a test that wants one either
 * runs the validator or does this. Doing it here keeps the session's own
 * behaviour under test rather than the validator's.
 */
const mandate = (): ValidatedMandate => markValidated(parseMandateYaml(MANDATE_YAML), {
  ceilingId: "org-policy@v12", ceilingSha256: "0".repeat(64),
  userLevel: "push",
  checkedAt: new Date().toISOString(),
  grantProofs: [],
});

interface FakeGithub {
  readonly deps: MintDeps;
  readonly calls: string[];
  readonly revoked: () => boolean;
}

const fakeGithub = (opts: { mintFails?: boolean; tokenLifeMs?: number } = {}): FakeGithub => {
  const calls: string[] = [];
  let revoked = false;
  return {
    calls,
    revoked: () => revoked,
    deps: {
      installationId: 1,
      asApp: async (route) => {
        calls.push(route);
        if (opts.mintFails === true) {
          return { status: 403, data: { message: "refused" } };
        }
        return {
          status: 201,
          data: {
            token: "ghs_faketoken",
            expires_at: new Date(Date.now() + (opts.tokenLifeMs ?? 3_600_000)).toISOString(),
            permissions: { contents: "write", metadata: "read" },
            // Bare names, which is what the endpoint really returns: measured
            // in Phase 2 and enforced by TokenResponseSchema.
            repositories: [{ name: "api" }],
          },
        };
      },
      asInstallation: async (route) => {
        calls.push(route);
        if (route === "DELETE /installation/token") revoked = true;
        return { status: 204, data: null };
      },
    },
  };
};

interface FakeUpstream {
  readonly connect: (token: string) => Promise<Client>;
  readonly tokenSeen: () => string | undefined;
  readonly closed: () => boolean;
}

const fakeUpstream = (opts: { connectFails?: boolean } = {}): FakeUpstream => {
  let tokenSeen: string | undefined;
  let closed = false;
  return {
    tokenSeen: () => tokenSeen,
    closed: () => closed,
    connect: async (token) => {
      tokenSeen = token;
      if (opts.connectFails === true) throw new Error("docker is not running");
      const server = new Server(
        { name: "fake-github", version: "0" }, { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "get_file_contents", description: "reads", inputSchema: { type: "object" } },
          { name: "merge_pull_request", description: "merges", inputSchema: { type: "object" } },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "fake-upstream", version: "0" });
      const realClose = client.close.bind(client);
      client.close = async (): Promise<void> => { closed = true; await realClose(); };
      await Promise.all([server.connect(a), client.connect(b)]);
      return client;
    },
  };
};

const agentFor = async (session: { proxy: Server }): Promise<Client> => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "agent", version: "0" });
  await Promise.all([session.proxy.connect(a), agent.connect(b)]);
  return agent;
};

describe("openSession", () => {
  it("mints a token, compiles rules and hands the upstream exactly that token", async () => {
    const gh = fakeGithub();
    const up = fakeUpstream();
    const session = await openSession({ mandate: mandate(), github: gh.deps, upstream: up.connect });

    expect(session.rules.mandateId).toBe("fix-issue-42");
    expect(session.rules.destinations).toEqual(["github.com/acme/api"]);
    expect(up.tokenSeen()).toBe(session.minted.token);
    await session.close();
  });

  it("enforces the mandate through the proxy it returns", async () => {
    const gh = fakeGithub();
    const session = await openSession({
      mandate: mandate(), github: gh.deps, upstream: fakeUpstream().connect,
    });
    const agent = await agentFor(session);

    // The mandate grants no merge, so the tool is never offered.
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_file_contents");
    expect(names).not.toContain("merge_pull_request");

    // And a write outside the granted paths is refused with its clause.
    const denied = await agent.callTool({
      name: "create_or_update_file",
      arguments: { owner: "acme", repo: "api", branch: "agent/42-fix", path: ".github/workflows/ci.yml" },
    });
    expect(denied.isError).toBe(true);
    await session.close();
  });

  it("reports every decision it took to the caller", async () => {
    const seen: string[] = [];
    const session = await openSession({
      mandate: mandate(), github: fakeGithub().deps, upstream: fakeUpstream().connect,
      onDecision: (d) => seen.push(`${d.kind}:${d.tool}`),
    });
    const agent = await agentFor(session);
    await agent.callTool({ name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "src/a.ts" } });
    expect(seen).toContain("allow:get_file_contents");
    await session.close();
  });
});

describe("openSession — giving the token back", () => {
  it("revokes on close", async () => {
    const gh = fakeGithub();
    const up = fakeUpstream();
    const session = await openSession({ mandate: mandate(), github: gh.deps, upstream: up.connect });
    expect(gh.revoked()).toBe(false);

    await session.close();
    expect(gh.revoked()).toBe(true);
    expect(up.closed()).toBe(true);
  });

  it("is idempotent, so a close in a finally after a close is harmless", async () => {
    const gh = fakeGithub();
    const session = await openSession({
      mandate: mandate(), github: gh.deps, upstream: fakeUpstream().connect,
    });
    await session.close();
    const after = gh.calls.filter((c) => c === "DELETE /installation/token").length;
    await session.close();
    await session.close();
    expect(gh.calls.filter((c) => c === "DELETE /installation/token").length).toBe(after);
  });

  /**
   * The path that actually leaks. The token is minted first, so anything that
   * throws after it — Docker not running, an image that will not pull — would
   * otherwise leave a live repository-scoped token with nothing holding a
   * reference to it and 59 minutes to run.
   */
  it("revokes when connecting the upstream throws, and still reports the failure", async () => {
    const gh = fakeGithub();
    const up = fakeUpstream({ connectFails: true });
    await expect(openSession({
      mandate: mandate(), github: gh.deps, upstream: up.connect,
    })).rejects.toThrow("docker is not running");
    expect(gh.revoked(), "a token minted and then abandoned is a live credential").toBe(true);
  });

  it("does not revoke a token it never minted", async () => {
    const gh = fakeGithub({ mintFails: true });
    await expect(openSession({
      mandate: mandate(), github: gh.deps, upstream: fakeUpstream().connect,
    })).rejects.toThrow();
    expect(gh.calls).not.toContain("DELETE /installation/token");
  });

  it("survives a revoke that fails, because the work is already done", async () => {
    // A token that cannot be revoked still expires within the hour. Throwing
    // here would turn a cleanup problem into a failed run.
    const gh = fakeGithub();
    const deps: MintDeps = {
      ...gh.deps,
      asInstallation: async (route, token, params) => {
        if (route === "DELETE /installation/token") throw new Error("network");
        return gh.deps.asInstallation(route, token, params);
      },
    };
    const session = await openSession({
      mandate: mandate(), github: deps, upstream: fakeUpstream().connect,
    });
    await expect(session.close()).resolves.toBeUndefined();
  });

  // The proof's first reader. It is built by the validator and branded onto
  // the mandate; the trace header is where it reaches a record that persists.
  it("records the ceiling the mandate was proved against in the trace header", async () => {
    const gh = fakeGithub();
    const session = await openSession({ mandate: mandate(), github: gh.deps, upstream: fakeUpstream().connect });
    expect(session.recorder.graph().ceiling).toEqual({ label: "org-policy@v12", sha256: "0".repeat(64) });
    await session.close();
  });

  // Task 5.6. The session ends before its credential does, so the proxy never
  // allows a call the upstream can only answer with a 401.
  it("ends the session before a credential that would expire first", async () => {
    const gh = fakeGithub({ tokenLifeMs: 20 * 60_000 });
    const session = await openSession({ mandate: mandate(), github: gh.deps, upstream: fakeUpstream().connect });
    expect(session.rules.cappedBy?.credentialExpiresAt).toBe(session.minted.expiresAt);
    expect(Date.parse(session.rules.expiresAt)).toBeLessThan(Date.parse(session.minted.expiresAt));
    await session.close();
  });

  it("keeps the mandate's own clock when the credential outlasts it", async () => {
    const gh = fakeGithub();
    const session = await openSession({ mandate: mandate(), github: gh.deps, upstream: fakeUpstream().connect });
    expect(session.rules.cappedBy).toBeUndefined();
    await session.close();
  });

  it("never puts the token in the proxy rules", async () => {
    // The rules are written to disk for `mandate serve` to read. A token in
    // them would be a credential on disk with no reason to be there.
    const session = await openSession({
      mandate: mandate(), github: fakeGithub().deps, upstream: fakeUpstream().connect,
    });
    expect(JSON.stringify(session.rules)).not.toContain(session.minted.token);
    await session.close();
  });
});
