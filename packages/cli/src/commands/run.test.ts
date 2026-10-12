import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MintDeps } from "@leastpilot/compiler";
import { parseJsonl, verifyAuditLog } from "@leastpilot/proxy";
import { runRun, MCP_CONFIG_PLACEHOLDER, type RunArgs } from "./run.js";
import { runServe, untilSignalled, type ServeArgs, type ServeDeps } from "./serve.js";
import { HANDSHAKE_PREFIX } from "../listen.js";
import type { Session } from "../session.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));

const CEILING = fixture("ceilings/org-policy-v12.cedar");
const SCHEMA = fixture("ceilings/schema.cedarschema");
const DESTINATIONS = fixture("ceilings/org-policy-v12.destinations");

const tmp = mkdtempSync(join(tmpdir(), "mandate-run-test-"));
const write = (name: string, body: string): string => {
  const path = join(tmp, name);
  writeFileSync(path, body, "utf8");
  return path;
};

/**
 * A stand-in for the built entry point. It has to exist on disk: `runRun`
 * checks, because a config naming a file that is not there fails inside the
 * agent as a MODULE_NOT_FOUND and then "Connection closed", neither of which
 * names the cause.
 */
const SELF = write("mandate-entry.js", "// stands in for dist/index.js\n");

const GOOD = write("good.yaml", `
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
    denyPaths: [".github/workflows/**", "**.env**"]
destinations:
  allow: ["github.com/acme/api"]
`);

const fakeGithub = (tokenLifeMs = 3_600_000): { deps: MintDeps; revokes: () => number; mints: () => number } => {
  let revokes = 0;
  let mints = 0;
  return {
    revokes: () => revokes,
    mints: () => mints,
    deps: {
      installationId: 1,
      asApp: async () => (mints += 1, {
        status: 201,
        data: {
          token: "ghs_fake", expires_at: new Date(Date.now() + tokenLifeMs).toISOString(),
          permissions: { contents: "write", metadata: "read" },
          repositories: [{ name: "api" }],
        },
      }),
      asInstallation: async (route: string) => {
        if (route === "DELETE /installation/token") revokes += 1;
        return { status: 204, data: null };
      },
    },
  };
};

const fakeUpstream = async (): Promise<Client> => {
  const server = new Server({ name: "fake", version: "0" }, { capabilities: { tools: {} } });
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
  const client = new Client({ name: "up", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const baseArgs = (over: Partial<RunArgs> = {}): RunArgs => ({
  file: GOOD, ceiling: CEILING, schema: SCHEMA, destinations: DESTINATIONS,
  as: "alice", level: "push", agent: ["my-agent", "--mcp", MCP_CONFIG_PLACEHOLDER],
  ...over,
});

interface Launched {
  command?: string;
  argv?: readonly string[];
  env?: Readonly<Record<string, string>>;
  configAtLaunch?: string;
}

const runWith = async (
  over: Partial<RunArgs> = {}, exitCode = 0,
): Promise<{ code: number; out: string; launched: Launched }> => {
  const chunks: string[] = [];
  const launched: Launched = {};
  const code = await runRun(baseArgs(over), (s) => chunks.push(s), {
    launch: async (command, argv, env) => {
      launched.command = command;
      launched.argv = argv;
      launched.env = env;
      // Read the config while the agent is "running", which is the only moment
      // it exists.
      const path = env["LEASTPILOT_MCP_CONFIG"];
      if (path !== undefined && existsSync(path)) {
        launched.configAtLaunch = readFileSync(path, "utf8");
      }
      return exitCode;
    },
    selfPath: SELF,
  });
  return { code, out: chunks.join("\n"), launched };
};

describe("leastpilot run", () => {
  it("passes --audit-log to serve as an absolute path", async () => {
    let config = "";
    const code = await runRun(baseArgs({ auditLog: "rel/audit.jsonl" }), () => undefined, {
      launch: async (_c, _a, env) => {
        config = readFileSync(env["LEASTPILOT_MCP_CONFIG"] ?? "", "utf8");
        return 0;
      },
      selfPath: SELF,
      env: { LEASTPILOT_AUDIT_KEY_PATH: auditKey().path },
    });
    expect(code).toBe(0);
    const args = (JSON.parse(config) as { mcpServers: { github: { args: string[] } } })
      .mcpServers.github.args;
    expect(args[args.indexOf("--audit-log") + 1]).toBe(resolve("rel/audit.jsonl"));
  });

  it("refuses an --audit-log that already exists before launching anything", async () => {
    let launched = false;
    const existing = write(`${randomBytes(4).toString("hex")}-old.jsonl`, "earlier evidence\n");
    const code = await runRun(baseArgs({ auditLog: existing }), () => undefined, {
      launch: async () => { launched = true; return 0; },
      selfPath: SELF,
      env: { LEASTPILOT_AUDIT_KEY_PATH: auditKey().path },
    });
    expect(code).toBe(2);
    expect(launched).toBe(false);
  });

  it("passes --approval to serve, and refuses before launching when it is missing", async () => {
    const chunks: string[] = [];
    let launched = false;
    const code = await runRun(baseArgs({ approval: "acme/api#42" }), (s) => chunks.push(s), {
      launch: async () => { launched = true; return 0; },
      selfPath: SELF,
      approvals: async () => [],
    });
    expect(code).toBe(1);
    expect(launched).toBe(false);
    expect(chunks.join("\n")).toMatch(/\/leastpilot approve [0-9a-f]{64}/);

    const line = /\/leastpilot approve [0-9a-f]{64}/.exec(chunks.join("\n"))?.[0] ?? "";
    let config = "";
    const ok = await runRun(baseArgs({ approval: "acme/api#42" }), () => undefined, {
      launch: async (_c, _a, env) => { config = readFileSync(env["LEASTPILOT_MCP_CONFIG"] ?? "", "utf8"); return 0; },
      selfPath: SELF,
      approvals: async () => [{ id: 1, author: "alice", body: line, createdAt: "t", updatedAt: "t" }],
    });
    expect(ok).toBe(0);
    const args = (JSON.parse(config) as { mcpServers: { github: { args: string[] } } }).mcpServers.github.args;
    expect(args[args.indexOf("--approval") + 1]).toBe("acme/api#42");
  });

  it("refuses --audit-log without LEASTPILOT_AUDIT_KEY_PATH before launching anything", async () => {
    const chunks: string[] = [];
    let launched = false;
    const code = await runRun(baseArgs({ auditLog: freshPath("audit.jsonl") }), (s) => chunks.push(s), {
      launch: async () => { launched = true; return 0; },
      selfPath: SELF,
      env: {},
    });
    expect(code).toBe(2);
    expect(launched).toBe(false);
    expect(chunks.join("\n")).toContain("LEASTPILOT_AUDIT_KEY_PATH");
  });

  it("validates before it launches anything", async () => {
    const { code, out, launched } = await runWith({
      file: fixture("overgrants/merge-granted.yaml"),
    });
    expect(code).toBe(1);
    expect(out).toContain("Mandate rejected");
    expect(out).toContain("no agent was launched");
    // The property that matters: an agent started against an unproved mandate
    // has authority nothing decided.
    expect(launched.command, "the agent must not start").toBeUndefined();
  });

  it("refuses with no agent command rather than launching a shell", async () => {
    const { code, out, launched } = await runWith({ agent: [] });
    expect(code).toBe(2);
    expect(out).toContain("No agent command");
    expect(launched.command).toBeUndefined();
  });

  it("launches the operator's command and returns its exit code", async () => {
    const { code, launched } = await runWith({}, 42);
    expect(launched.command).toBe("my-agent");
    expect(code).toBe(42);
  });

  it("substitutes the config path into the agent's arguments", async () => {
    const { launched } = await runWith();
    expect(launched.argv?.[0]).toBe("--mcp");
    expect(launched.argv?.[1]).toMatch(/mcp\.json$/);
    expect(launched.argv?.join(" ")).not.toContain(MCP_CONFIG_PLACEHOLDER);
  });

  it("also exports the path, for an agent that reads the environment", async () => {
    const { launched } = await runWith();
    expect(launched.env?.["LEASTPILOT_MCP_CONFIG"]).toMatch(/mcp\.json$/);
  });

  it("says so when the agent command never mentions the placeholder", async () => {
    const { out } = await runWith({ agent: ["my-agent", "-p", "fix it"] });
    expect(out).toContain(MCP_CONFIG_PLACEHOLDER);
    expect(out).toMatch(/only find the enforced server/);
  });

  it("writes a config that starts `leastpilot serve` on the same inputs", async () => {
    const { launched } = await runWith();
    const config = JSON.parse(launched.configAtLaunch ?? "{}") as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const args = config.mcpServers?.["github"]?.args ?? [];
    expect(args).toContain("serve");
    expect(args).toContain(SELF);
    // The same mandate and the same ceiling the operator just had validated.
    // A serve started on a different ceiling would enforce something nobody
    // approved.
    expect(args).toContain(GOOD);
    expect(args).toContain(CEILING);
    expect(args).toContain(DESTINATIONS);
  });

  /**
   * The agent spawns `leastpilot serve` itself, from whatever working directory it
   * happens to have. A relative path in the config resolves against the agent's
   * cwd, not the operator's, so the ceiling either is not found or — far worse —
   * a different file with the same relative name is loaded and enforced.
   *
   * Found by running the real binary rather than the stub: the config it wrote
   * carried `fixtures/ceilings/org-policy-v12.cedar` verbatim.
   */
  it("writes absolute paths, because the agent spawns serve from its own cwd", async () => {
    const relative: RunArgs = {
      ...baseArgs(),
      file: "rel/m.yaml",
      ceiling: "rel/c.cedar",
      schema: "rel/s.cedarschema",
      destinations: "rel/d.destinations",
      trace: "rel/t.jsonl",
    };
    const launched: Launched = {};
    // It will not validate — the files do not exist — but the config is written
    // before that matters only if paths are resolved at write time, so this
    // asserts on the argv the config WOULD carry by going through a mandate that
    // does exist with relative-looking inputs made absolute.
    await runRun({ ...relative, file: GOOD, ceiling: CEILING, schema: SCHEMA, destinations: DESTINATIONS },
      () => undefined, {
        launch: async (_c, _a, env) => {
          const path = env["LEASTPILOT_MCP_CONFIG"];
          if (path !== undefined) launched.configAtLaunch = readFileSync(path, "utf8");
          return 0;
        },
        selfPath: SELF,
      });
    const config = JSON.parse(launched.configAtLaunch ?? "{}") as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    const args = config.mcpServers?.["github"]?.args ?? [];
    const paths = args.filter((a) => a.includes("/") && !a.startsWith("--"));
    expect(paths.length).toBeGreaterThan(0);
    for (const a of paths) {
      expect(a.startsWith("/"), `${a} is not absolute`).toBe(true);
    }
    // The trace too: a relative trace path would be written wherever the agent
    // happened to be.
    expect(args).toContain(resolve("rel/t.jsonl"));
  });

  /**
   * The agent is handed the path to this file, so anything in it is readable by
   * the process whose authority it exists to bound. `leastpilot serve` mints in its
   * own process precisely so there is nothing here worth reading.
   */
  it("puts no credential in the config the agent can read", async () => {
    const { launched } = await runWith();
    const text = launched.configAtLaunch ?? "";
    expect(text).not.toContain("ghs_");
    expect(text.toLowerCase()).not.toContain("token");
    expect(text.toLowerCase()).not.toContain("private");
  });

  /**
   * The config is consumed by a process LeastPilot does not control, so a path in
   * it that does not resolve becomes two errors inside the agent — a
   * MODULE_NOT_FOUND and then "Connection closed" — neither of which names the
   * cause. Caught on the first live run, where the default resolved to
   * `src/index.js` under vitest instead of the built `dist/index.js`.
   */
  it("refuses when its own entry point does not exist, rather than naming it anyway", async () => {
    const chunks: string[] = [];
    let launched = false;
    const code = await runRun(baseArgs(), (s) => chunks.push(s), {
      launch: async () => { launched = true; return 0; },
      selfPath: "/nonexistent/mandate/index.js",
    });
    expect(code).toBe(2);
    expect(chunks.join("\n")).toContain("Cannot find the mandate entry point");
    expect(launched, "nothing should be launched against a config that cannot work").toBe(false);
  });

  it("removes the config once the agent exits", async () => {
    const { launched } = await runWith();
    const path = launched.env?.["LEASTPILOT_MCP_CONFIG"];
    expect(path).toBeDefined();
    expect(launched.configAtLaunch, "it must exist while the agent runs").toBeDefined();
    expect(existsSync(path ?? ""), "and not after").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// leastpilot serve
// ---------------------------------------------------------------------------

const serveArgs = (over: Partial<ServeArgs> = {}): ServeArgs => ({
  file: GOOD, ceiling: CEILING, schema: SCHEMA, destinations: DESTINATIONS,
  as: "alice", level: "push", ...over,
});

const serveWith = async (
  over: Partial<ServeArgs> = {}, deps: Partial<ServeDeps> = {},
  drive?: (agent: Client) => Promise<void>,
): Promise<{ code: number; out: string; revokes: number }> => {
  const chunks: string[] = [];
  const gh = fakeGithub();
  let connected: Client | undefined;
  const code = await runServe(serveArgs(over), (s) => chunks.push(s), {
    github: gh.deps,
    upstream: fakeUpstream,
    connect: async (session: Session) => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      const agent = new Client({ name: "agent", version: "0" });
      await Promise.all([session.proxy.connect(a), agent.connect(b)]);
      connected = agent;
    },
    until: async () => { if (drive !== undefined && connected !== undefined) await drive(connected); },
    ...deps,
  });
  return { code, out: chunks.join("\n"), revokes: gh.revokes() };
};

describe("leastpilot serve", () => {
  it("refuses a mandate outside the ceiling without minting or serving", async () => {
    const { code, out, revokes } = await serveWith({
      file: fixture("overgrants/merge-granted.yaml"),
    });
    expect(code).toBe(1);
    expect(out).toContain("no server was started");
    expect(revokes).toBe(0);
  });

  it("serves only the tools the mandate reaches", async () => {
    let names: string[] = [];
    const { code } = await serveWith({}, {}, async (agent) => {
      names = (await agent.listTools()).tools.map((t) => t.name);
    });
    expect(code).toBe(0);
    expect(names).toContain("get_file_contents");
    expect(names).not.toContain("merge_pull_request");
  });

  it("revokes the token when the session ends", async () => {
    const { revokes } = await serveWith();
    expect(revokes).toBe(1);
  });

  it("writes the action graph, and the strict parser reads it back", async () => {
    const trace = join(tmp, "trace.jsonl");
    await serveWith({ trace }, {}, async (agent) => {
      await agent.callTool({
        name: "get_file_contents",
        arguments: { owner: "acme", repo: "api", path: "src/a.ts" },
      });
    });
    const graph = parseJsonl(readFileSync(trace, "utf8"));
    expect(graph.mode).toBe("enforced");
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it("records a denial in the trace rather than dropping it", async () => {
    const trace = join(tmp, "denied.jsonl");
    await serveWith({ trace }, {}, async (agent) => {
      await agent.callTool({
        name: "create_or_update_file",
        arguments: {
          owner: "acme", repo: "api", branch: "agent/42-fix",
          path: ".github/workflows/ci.yml",
        },
      });
    });
    const graph = parseJsonl(readFileSync(trace, "utf8"));
    const denials = graph.nodes.filter((n) => n.decision === "deny");
    expect(denials.length).toBeGreaterThan(0);
    // R10: every pause names the clause it hit.
    expect(denials[0]?.clause).toBeDefined();
  });

  it("says plainly when the requester's level was only asserted", async () => {
    const { out } = await serveWith({ level: "push" });
    expect(out).toMatch(/asserted, not verified/);
  });

  /**
   * stdout is the JSON-RPC stream. One stray `console.log` and the agent sees a
   * parse error instead of a tool list, which presents as "LeastPilot does not
   * work" with nothing pointing at the cause.
   */
  it("writes no diagnostics to stdout", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("./serve.ts", import.meta.url)), "utf8",
    );
    expect(source).not.toMatch(/console\.(log|info|debug)\(/);
    expect(source).not.toMatch(/process\.stdout\.write/);
  });
});

// ---------------------------------------------------------------------------
// leastpilot serve --audit-log: R16
// ---------------------------------------------------------------------------

/** An Ed25519 audit key at 0600, and the public half an auditor would be given. */
const auditKey = (): { path: string; publicPem: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const path = join(tmp, `audit-${randomBytes(4).toString("hex")}.pem`);
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  return { path, publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const freshPath = (name: string): string => join(tmp, `${randomBytes(4).toString("hex")}-${name}`);

describe("leastpilot serve --audit-log", () => {
  const serveCounting = async (
    over: Partial<ServeArgs>, deps: Partial<ServeDeps>,
    drive?: (agent: Client) => Promise<void>,
  ): Promise<{ code: number; out: string; mints: number }> => {
    const chunks: string[] = [];
    const gh = fakeGithub();
    let connected: Client | undefined;
    const code = await runServe(serveArgs(over), (s) => chunks.push(s), {
      github: gh.deps,
      upstream: fakeUpstream,
      connect: async (session: Session) => {
        const [a, b] = InMemoryTransport.createLinkedPair();
        const agent = new Client({ name: "agent", version: "0" });
        await Promise.all([session.proxy.connect(a), agent.connect(b)]);
        connected = agent;
      },
      until: async () => { if (drive !== undefined && connected !== undefined) await drive(connected); },
      ...deps,
    });
    return { code, out: chunks.join("\n"), mints: gh.mints() };
  };

  it("refuses to start without LEASTPILOT_AUDIT_KEY_PATH, before anything is minted", async () => {
    const auditLog = freshPath("audit.jsonl");
    const { code, out, mints } = await serveCounting({ auditLog }, {});
    expect(code).toBe(2);
    expect(out).toContain("LEASTPILOT_AUDIT_KEY_PATH");
    expect(mints).toBe(0);
    expect(existsSync(auditLog)).toBe(false);
  });

  it("refuses the App's RSA key as the audit key, before anything is minted", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const appKey = join(tmp, "app.pem");
    writeFileSync(appKey, privateKey.export({ type: "pkcs1", format: "pem" }).toString(), { mode: 0o600 });
    const { code, out, mints } = await serveCounting(
      { auditLog: freshPath("audit.jsonl") }, { auditKeyPath: appKey },
    );
    expect(code).toBe(2);
    expect(out).toMatch(/rsa key/);
    expect(mints).toBe(0);
  });

  it("refuses to overwrite an existing log, before anything is minted", async () => {
    const auditLog = write(`${randomBytes(4).toString("hex")}-old.jsonl`, "earlier evidence\n");
    const { code, out, mints } = await serveCounting({ auditLog }, { auditKeyPath: auditKey().path });
    expect(code).toBe(2);
    expect(out).toMatch(/already exists/);
    expect(mints).toBe(0);
    expect(readFileSync(auditLog, "utf8")).toBe("earlier evidence\n");
  });

  it("writes a sealed log that verifies and holds the same decisions as the trace", async () => {
    const key = auditKey();
    const auditLog = freshPath("audit.jsonl");
    const trace = freshPath("trace.jsonl");
    const { code, out } = await serveCounting({ auditLog, trace }, { auditKeyPath: key.path }, async (agent) => {
      await agent.callTool({ name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "src/a.ts" } });
      await agent.callTool({ name: "merge_pull_request", arguments: { owner: "acme", repo: "api", pullNumber: 1 } });
    });
    expect(code).toBe(0);
    expect(out).toContain(`Sealed the audit log at ${auditLog}`);
    const v = verifyAuditLog(readFileSync(auditLog, "utf8"), key.publicPem);
    expect(v).toMatchObject({
      ok: true, sealed: true, sealedAs: "closed", mandateId: "fix-issue-42", unfinished: [],
    });
    if (!v.ok) return;
    expect(v.graph).toEqual(parseJsonl(readFileSync(trace, "utf8")));
    expect(v.graph.nodes.map((n) => n.decision)).toEqual(["allow", "deny"]);
  });

  // The case completion-only recording lost: the session ends while a call is
  // with GitHub. Its forwarded event is in the log whatever happens next.
  it("records a call still in flight when the session ends", async () => {
    const key = auditKey();
    const auditLog = freshPath("audit.jsonl");
    const hanging = async (): Promise<Client> => {
      const server = new Server({ name: "fake", version: "0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "get_file_contents", description: "reads", inputSchema: { type: "object" } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, () => new Promise<never>(() => undefined));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "up", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      return client;
    };
    const { code } = await serveCounting({ auditLog }, { auditKeyPath: key.path, upstream: hanging }, async (agent) => {
      void agent.callTool({ name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "src/a.ts" } })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(code).toBe(0);
    const v = verifyAuditLog(readFileSync(auditLog, "utf8"), key.publicPem);
    expect(v).toMatchObject({ ok: true, sealed: true });
    if (!v.ok) return;
    // Closing the upstream fails the pending call, and the seal comes after
    // the close, so the call ends as an upstream failure rather than unfinished.
    // (The --trace file, written before the close, does not have it.) A kill
    // leaves it unfinished instead; the verifier's own tests cover that.
    expect(v.unfinished).toEqual([]);
    expect(v.graph.nodes.map((n) => [n.outcome, n.paths])).toEqual([["upstream-failure", ["src/a.ts"]]]);
  });

  it("seals the log when the session cannot open, so the attempt is on record", async () => {
    const key = auditKey();
    const auditLog = freshPath("audit.jsonl");
    const { code } = await serveCounting({ auditLog }, {
      auditKeyPath: key.path,
      upstream: async () => { throw new Error("docker is not running"); },
    });
    expect(code).toBe(2);
    const v = verifyAuditLog(readFileSync(auditLog, "utf8"), key.publicPem);
    expect(v).toMatchObject({ ok: true, sealed: true, sealedAs: "never-opened", unfinished: [] });
    if (v.ok) expect(v.graph.nodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --approval: R5, the mandate refused unless its requester approved it
// ---------------------------------------------------------------------------

describe("leastpilot serve --approval", () => {
  type Comment = import("../approval.js").ApprovalComment;
  const at = "2026-10-12T10:00:00Z";
  const serveApproving = async (
    over: Partial<ServeArgs>, comments: readonly Comment[] | undefined,
    deps: Partial<ServeDeps> = {},
  ): Promise<{ code: number; out: string; mints: number; reads: string[] }> => {
    const chunks: string[] = [];
    const reads: string[] = [];
    const gh = fakeGithub();
    const code = await runServe(serveArgs(over), (s) => chunks.push(s), {
      github: gh.deps,
      upstream: fakeUpstream,
      connect: async () => undefined,
      until: async () => undefined,
      ...(comments === undefined ? {} : {
        approvals: async (ref) => { reads.push(`${ref.owner}/${ref.repo}#${ref.number}`); return comments; },
      }),
      ...deps,
    });
    return { code, out: chunks.join("\n"), mints: gh.mints(), reads };
  };
  /** The line the refusal tells the requester to post. */
  const lineFrom = (out: string): string => {
    const m = /\/leastpilot approve [0-9a-f]{64}/.exec(out);
    if (m === null) throw new Error(`no approve line in:\n${out}`);
    return m[0];
  };

  it("refuses to mint without an approval, and names the exact line to post", async () => {
    const { code, out, mints, reads } = await serveApproving({ approval: "acme/api#42" }, []);
    expect(code).toBe(1);
    expect(mints).toBe(0);
    expect(reads).toEqual(["acme/api#42"]);
    expect(out).toMatch(/no approval by alice/);
    expect(out).toMatch(/Nothing was minted/);
    lineFrom(out);
  });

  it("serves once the requester has posted that line", async () => {
    const line = lineFrom((await serveApproving({ approval: "acme/api#42" }, [])).out);
    const { code, out, mints } = await serveApproving({ approval: "acme/api#42" }, [
      { id: 9, author: "alice", body: line, createdAt: at, updatedAt: at },
    ]);
    expect(code).toBe(0);
    expect(mints).toBe(1);
    expect(out).toMatch(/Approved by alice in acme\/api#42 \(comment 9/);
  });

  it("refuses an approval of the same mandate by someone else", async () => {
    const line = lineFrom((await serveApproving({ approval: "acme/api#42" }, [])).out);
    const { code, mints } = await serveApproving({ approval: "acme/api#42" }, [
      { id: 9, author: "mallory", body: line, createdAt: at, updatedAt: at },
    ]);
    expect(code).toBe(1);
    expect(mints).toBe(0);
  });

  // The approval binds the ceiling: the same mandate proved against another
  // ceiling file is a different thing to approve.
  it("refuses an approval given under a different ceiling", async () => {
    const line = lineFrom((await serveApproving({ approval: "acme/api#42" }, [])).out);
    const other = write(`other-${randomBytes(3).toString("hex")}.cedar`, `${readFileSync(CEILING, "utf8")}\n// edited\n`);
    const { code, mints } = await serveApproving({ approval: "acme/api#42", ceiling: other }, [
      { id: 9, author: "alice", body: line, createdAt: at, updatedAt: at },
    ]);
    expect(code).toBe(1);
    expect(mints).toBe(0);
  });

  it("refuses a reference it cannot read, before anything else", async () => {
    const { code, out, reads } = await serveApproving({ approval: "acme/api" }, []);
    expect(code).toBe(2);
    expect(out).toMatch(/owner\/repo#number/);
    expect(reads).toEqual([]);
  });

  it("refuses --approval when nothing can read GitHub comments", async () => {
    const { code, out, mints } = await serveApproving({ approval: "acme/api#42" }, undefined);
    expect(code).toBe(2);
    expect(out).toMatch(/LEASTPILOT_APP_ID/);
    expect(mints).toBe(0);
  });

  // Nothing known is not "not approved": exit 2, and still nothing minted.
  it("mints nothing, and exits 2, when the approval cannot be read", async () => {
    const { code, out, mints } = await serveApproving({ approval: "acme/api#42" }, [], {
      approvals: async () => { throw new Error("HTTP 502"); },
    });
    expect(code).toBe(2);
    expect(out).toMatch(/Could not read the approval.*502/);
    expect(mints).toBe(0);
  });

  it("records the approval in the audit log's open event", async () => {
    const line = lineFrom((await serveApproving({ approval: "acme/api#42" }, [])).out);
    const key = auditKey();
    const auditLog = freshPath("audit.jsonl");
    const { code } = await serveApproving({ approval: "acme/api#42", auditLog }, [
      { id: 9, author: "alice", body: line, createdAt: at, updatedAt: at },
    ], { auditKeyPath: key.path });
    expect(code).toBe(0);
    const v = verifyAuditLog(readFileSync(auditLog, "utf8"), key.publicPem);
    expect(v).toMatchObject({
      ok: true,
      approval: { issue: "acme/api#42", comment: 9, by: "alice", at, digest: line.split(" ")[2] },
    });
  });
});

// ---------------------------------------------------------------------------
// leastpilot serve --listen: the sandboxed agent's transport
// ---------------------------------------------------------------------------

/**
 * Sends the handshake and each request as a line, and resolves with one parsed
 * response per request. Raw JSON-RPC rather than an SDK client: there is no
 * shared test-helper module, and two requests do not need one.
 */
const rpcOver = (port: number, secret: string, requests: readonly object[]): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const out: unknown[] = [];
    let buf = "";
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(`${HANDSHAKE_PREFIX}${secret}\n`);
      for (const r of requests) sock.write(`${JSON.stringify(r)}\n`);
    });
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        out.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      if (out.length === requests.length) { sock.end(); resolve(out); }
    });
    sock.on("close", () => { if (out.length < requests.length) resolve(out); });
  });

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a", version: "0" } },
};
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };

/** Polls for the ready file serve writes once it is listening. */
const readyPort = async (path: string): Promise<number> => {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) return (JSON.parse(readFileSync(path, "utf8")) as { port: number }).port;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`serve never wrote ${path}`);
};

describe("leastpilot serve --listen", () => {
  const relaySecret = randomBytes(32).toString("hex");
  const listenServe = (over: Partial<ServeArgs>, deps: Partial<ServeDeps> = {}) => {
    const gh = fakeGithub();
    const chunks: string[] = [];
    const done = runServe(serveArgs(over), (s) => chunks.push(s), {
      github: gh.deps, upstream: fakeUpstream, relaySecret, ...deps,
    });
    return { gh, done, out: () => chunks.join("\n") };
  };

  it("serves the enforced tools to a client that presents the secret", async () => {
    const readyFile = join(mkdtempSync(join(tmpdir(), "mandate-listen-")), "ready.json");
    const { gh, done } = listenServe({ listen: "127.0.0.1:0", readyFile });
    const port = await readyPort(readyFile);
    const [, list] = await rpcOver(port, relaySecret, [INIT, LIST]) as [unknown, { result: { tools: { name: string }[] } }];
    // Filtered by the mandate: the fake upstream also offers merge_pull_request.
    expect(list.result.tools.map((t) => t.name)).toEqual(["get_file_contents"]);
    expect(await done).toBe(0);
    expect(gh.mints()).toBe(1);
    // The session ended because the client went away, and the token went back.
    expect(gh.revokes()).toBe(1);
  });

  it("names the address it listens on in the ready file, and nothing secret", async () => {
    const readyFile = join(mkdtempSync(join(tmpdir(), "mandate-listen-")), "ready.json");
    const { done } = listenServe({ listen: "127.0.0.1:0", readyFile });
    const port = await readyPort(readyFile);
    const text = readFileSync(readyFile, "utf8");
    expect(JSON.parse(text)).toEqual({ host: "127.0.0.1", port });
    expect(text).not.toContain(relaySecret);
    expect(text).not.toContain("ghs_");
    await rpcOver(port, relaySecret, [INIT]);
    await done;
  });

  it("refuses to listen without a relay secret, before minting anything", async () => {
    const { gh, done, out } = listenServe({ listen: "127.0.0.1:0" }, { relaySecret: undefined });
    expect(await done).toBe(2);
    expect(out()).toMatch(/MANDATE_RELAY_SECRET/);
    expect(gh.mints()).toBe(0);
  });

  it("refuses a malformed or wildcard listen address, before minting anything", async () => {
    for (const listen of ["127.0.0.1", "localhost:0", "0.0.0.0:0", "127.0.0.1:99999"]) {
      const { gh, done } = listenServe({ listen });
      expect(await done, listen).toBe(2);
      expect(gh.mints(), listen).toBe(0);
    }
  });

  // Found reviewing Phase 5: serve listened for signals only once it was
  // serving, so a SIGTERM during the mint -- the launcher timing out, an
  // operator's Ctrl-C -- killed it with a live token unrevoked. It listens from
  // the start now, and a signal mid-mint closes the session at once.
  it("revokes the token when a signal arrives while it is being minted", async () => {
    const signals = new EventEmitter();
    const gh = fakeGithub();
    const asApp = gh.deps.asApp;
    const readyFile = join(mkdtempSync(join(tmpdir(), "mandate-listen-")), "ready.json");
    const code = await runServe(serveArgs({ listen: "127.0.0.1:0", readyFile }), () => undefined, {
      github: { ...gh.deps, asApp: async (route, params) => { signals.emit("SIGTERM"); return asApp(route, params); } },
      upstream: fakeUpstream, relaySecret, signals,
    });
    expect(code).toBe(0);
    expect(gh.mints()).toBe(1);
    expect(gh.revokes()).toBe(1);
    expect(existsSync(readyFile)).toBe(false);
  });

  // Found reviewing Phase 5: past its expiry the proxy refused every call, but
  // the session, the listener and the token stayed up until the agent went
  // away. The session now ends at its expiry, which revokes the token.
  it("ends the session, and revokes, at its expiry", async () => {
    // 61 s of token life: the session is capped to end 60 s before it.
    const gh = fakeGithub(61_000);
    const started = Date.now();
    const code = await runServe(serveArgs({ listen: "127.0.0.1:0" }), () => undefined, {
      github: gh.deps, upstream: fakeUpstream, relaySecret, signals: new EventEmitter(),
    });
    expect(code).toBe(0);
    expect(gh.revokes()).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("mints nothing when a signal arrives before the mint", async () => {
    const signals = new EventEmitter();
    const gh = fakeGithub();
    const done = runServe(serveArgs({ listen: "127.0.0.1:0" }), () => undefined, {
      github: gh.deps, upstream: fakeUpstream, relaySecret, signals,
    });
    signals.emit("SIGINT");
    expect(await done).toBe(0);
    expect(gh.mints()).toBe(0);
  });

  // A serve started by `leastpilot run` has no agent on its stdin. If listen mode
  // waited on stdin ending, as stdio mode does, it would shut down at once.
  it("does not end the session because its stdin closed", async () => {
    const readyFile = join(mkdtempSync(join(tmpdir(), "mandate-listen-")), "ready.json");
    const stdin = new EventEmitter();
    const { done } = listenServe({ listen: "127.0.0.1:0", readyFile }, { stdin });
    const port = await readyPort(readyFile);
    stdin.emit("end");
    stdin.emit("close");
    await new Promise((r) => setTimeout(r, 30));
    const [, list] = await rpcOver(port, relaySecret, [INIT, LIST]) as [unknown, { result: { tools: unknown[] } }];
    expect(list.result.tools).toHaveLength(1);
    await done;
  });
});

/**
 * `runServe`'s default shutdown, which every test above replaces with its own
 * `until`.
 *
 * It is the path that runs in production and it revokes a live repo-scoped
 * token, so leaving it to a signal handler nobody has executed is the wrong
 * trade. Driving `leastpilot serve` by hand confirmed it works — stdin closing
 * when the client disconnected shut the session down and revoked — but a manual
 * check is not a regression test.
 *
 * `beforeExit` used to be in this set and is deliberately gone. It fires when
 * the event loop drains, which with a live stdio transport should not happen —
 * so it was either never reached or reached at a moment the server should still
 * have been running, and neither is a shutdown signal worth acting on.
 */
describe("untilSignalled", () => {
  const emitters = (): { signals: EventEmitter; input: EventEmitter } =>
    ({ signals: new EventEmitter(), input: new EventEmitter() });

  it("resolves when the client closes the pipe, which is the normal case", async () => {
    const { signals, input } = emitters();
    const waiting = untilSignalled(signals, input);
    input.emit("end");
    await expect(waiting).resolves.toBeUndefined();
  });

  it("resolves on a closed input as well as an ended one", async () => {
    const { signals, input } = emitters();
    const waiting = untilSignalled(signals, input);
    input.emit("close");
    await expect(waiting).resolves.toBeUndefined();
  });

  it.each(["SIGINT", "SIGTERM"])("resolves on %s", async (signal) => {
    const { signals, input } = emitters();
    const waiting = untilSignalled(signals, input);
    signals.emit(signal);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("does not resolve on its own", async () => {
    const { signals, input } = emitters();
    let settled = false;
    void untilSignalled(signals, input).then(() => { settled = true; });
    // A shutdown that fires unprompted would revoke the token mid-session and
    // leave the agent holding a server that no longer works.
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
  });

  it("stops serving when the pipe closes, and gives the token back", async () => {
    // The whole path, with the real default rather than an injected `until`.
    const chunks: string[] = [];
    const gh = fakeGithub();
    const input = new EventEmitter();
    const code = await runServe(serveArgs(), (s) => chunks.push(s), {
      github: gh.deps,
      upstream: fakeUpstream,
      connect: async () => { setImmediate(() => input.emit("end")); },
      until: () => untilSignalled(new EventEmitter(), input),
    });
    expect(code).toBe(0);
    expect(gh.revokes(), "a session that ended must return its token").toBe(1);
    expect(chunks.join("\n")).toContain("token revoked");
  });
});
