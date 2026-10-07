import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MintDeps } from "@mandate-dev/compiler";
import { parseJsonl } from "@mandate-dev/proxy";
import { runRun, MCP_CONFIG_PLACEHOLDER, type RunArgs } from "./run.js";
import { runServe, type ServeArgs, type ServeDeps } from "./serve.js";
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

const fakeGithub = (): { deps: MintDeps; revokes: () => number } => {
  let revokes = 0;
  return {
    revokes: () => revokes,
    deps: {
      installationId: 1,
      asApp: async () => ({
        status: 201,
        data: {
          token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
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
      const path = env["MANDATE_MCP_CONFIG"];
      if (path !== undefined && existsSync(path)) {
        launched.configAtLaunch = readFileSync(path, "utf8");
      }
      return exitCode;
    },
    selfPath: "/opt/mandate/index.js",
  });
  return { code, out: chunks.join("\n"), launched };
};

describe("mandate run", () => {
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
    expect(launched.env?.["MANDATE_MCP_CONFIG"]).toMatch(/mcp\.json$/);
  });

  it("says so when the agent command never mentions the placeholder", async () => {
    const { out } = await runWith({ agent: ["my-agent", "-p", "fix it"] });
    expect(out).toContain(MCP_CONFIG_PLACEHOLDER);
    expect(out).toMatch(/only find the enforced server/);
  });

  it("writes a config that starts `mandate serve` on the same inputs", async () => {
    const { launched } = await runWith();
    const config = JSON.parse(launched.configAtLaunch ?? "{}") as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const args = config.mcpServers?.["github"]?.args ?? [];
    expect(args).toContain("serve");
    expect(args).toContain("/opt/mandate/index.js");
    // The same mandate and the same ceiling the operator just had validated.
    // A serve started on a different ceiling would enforce something nobody
    // approved.
    expect(args).toContain(GOOD);
    expect(args).toContain(CEILING);
    expect(args).toContain(DESTINATIONS);
  });

  /**
   * The agent spawns `mandate serve` itself, from whatever working directory it
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
          const path = env["MANDATE_MCP_CONFIG"];
          if (path !== undefined) launched.configAtLaunch = readFileSync(path, "utf8");
          return 0;
        },
        selfPath: "/opt/mandate/index.js",
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
   * the process whose authority it exists to bound. `mandate serve` mints in its
   * own process precisely so there is nothing here worth reading.
   */
  it("puts no credential in the config the agent can read", async () => {
    const { launched } = await runWith();
    const text = launched.configAtLaunch ?? "";
    expect(text).not.toContain("ghs_");
    expect(text.toLowerCase()).not.toContain("token");
    expect(text.toLowerCase()).not.toContain("private");
  });

  it("removes the config once the agent exits", async () => {
    const { launched } = await runWith();
    const path = launched.env?.["MANDATE_MCP_CONFIG"];
    expect(path).toBeDefined();
    expect(launched.configAtLaunch, "it must exist while the agent runs").toBeDefined();
    expect(existsSync(path ?? ""), "and not after").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mandate serve
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

describe("mandate serve", () => {
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
   * parse error instead of a tool list, which presents as "Mandate does not
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
