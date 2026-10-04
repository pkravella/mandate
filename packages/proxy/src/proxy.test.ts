import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyRules } from "@mandate-dev/compiler";
import { createProxyServer, type Decision, type ProxyDeps } from "./proxy.js";
import { Recorder, parseJsonl } from "./graph.js";
import { makeArgumentEnforcer } from "./enforce.js";
import { pauseRecord, type PauseRecord } from "./pause.js";

const rules: ProxyRules = {
  mandateId: "fix-issue-42",
  mandateHash: "b".repeat(64),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  allowedTools: [
    "get_file_contents", "create_branch", "create_or_update_file", "create_pull_request",
  ],
  rules: [
    { tool: "get_file_contents", action: "contents.read", resources: ["acme/api"] },
    {
      tool: "create_branch", action: "branch.create", resources: ["acme/api"],
      branches: ["agent/42-*"],
    },
    {
      tool: "create_or_update_file", action: "contents.write", resources: ["acme/api"],
      branches: ["agent/42-*"], paths: ["**"],
      denyPaths: [".github/workflows/**", "**.env**"],
    },
    {
      tool: "create_pull_request", action: "pull_request.create", resources: ["acme/api"],
      branches: ["agent/42-*"], base: "main", max: 1,
    },
  ],
  destinations: ["github.com/acme/api"],
};

const TOOL_NAMES = [
  "get_file_contents", "create_branch", "create_or_update_file",
  "create_pull_request", "merge_pull_request", "delete_file",
];

interface Upstream {
  client: Client;
  seen: { tool: string; args: unknown }[];
}

/** A stand-in for github-mcp-server that records what reached it. */
async function fakeUpstream(opts: {
  paged?: boolean; failOn?: string;
} = {}): Promise<Upstream> {
  const seen: { tool: string; args: unknown }[] = [];
  const server = new Server({ name: "fake-github", version: "0" }, { capabilities: { tools: {} } });

  const tool = (name: string) =>
    ({ name, description: `does ${name}`, inputSchema: { type: "object" as const } });

  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    if (opts.paged !== true) return { tools: TOOL_NAMES.map(tool) };
    // Half the tools on each page, so a proxy that reads only the first page
    // loses create_pull_request.
    return req.params?.cursor === undefined
      ? { tools: TOOL_NAMES.slice(0, 3).map(tool), nextCursor: "page2" }
      : { tools: TOOL_NAMES.slice(3).map(tool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === opts.failOn) throw new Error("upstream exploded");
    seen.push({ tool: req.params.name, args: req.params.arguments });
    return { content: [{ type: "text" as const, text: "ok" }] };
  });

  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "proxy-upstream", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, seen };
}

async function connectAgent(proxy: Server): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "agent", version: "0" });
  await Promise.all([proxy.connect(a), agent.connect(b)]);
  return agent;
}

const expiredRules = (over: Partial<ProxyRules> = {}): ProxyRules =>
  ({ ...rules, expiresAt: new Date(Date.now() - 1000).toISOString(), ...over });

describe("proxy tools/list", () => {
  it("hides every tool the mandate does not reach", async () => {
    const { client } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({ rules, upstream: client }));
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...rules.allowedTools].sort());
    expect(names).not.toContain("merge_pull_request");
    expect(names).not.toContain("delete_file");
  });

  it("annotates each surviving tool with the mandate's limits", async () => {
    const { client } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({ rules, upstream: client }));
    const write = (await agent.listTools()).tools.find((t) => t.name === "create_or_update_file");
    expect(write?.description).toContain("agent/42-*");
  });

  // ListToolsResult carries nextCursor, and a single listTools() call returns
  // only the first page. A proxy that stops there silently hides granted tools
  // and the task fails for a reason nobody can see.
  it("follows pagination so a granted tool on page two is not lost", async () => {
    const { client } = await fakeUpstream({ paged: true });
    const agent = await connectAgent(createProxyServer({ rules, upstream: client }));
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toContain("create_pull_request");
    expect(names.sort()).toEqual([...rules.allowedTools].sort());
  });

  it("returns no tools at all once the mandate has expired", async () => {
    const { client } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({ rules: expiredRules(), upstream: client }));
    expect((await agent.listTools()).tools).toEqual([]);
  });
});

describe("proxy tools/call passthrough", () => {
  it("forwards an allowed call unchanged", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({ rules, upstream: client }));
    const res = await agent.callTool({
      name: "get_file_contents",
      arguments: { owner: "acme", repo: "api", path: "src/a.ts" },
    });
    expect(seen).toEqual([
      { tool: "get_file_contents", args: { owner: "acme", repo: "api", path: "src/a.ts" } },
    ]);
    expect(JSON.stringify(res.content)).toContain("ok");
  });

  it("refuses a tool that is not in allowedTools without touching upstream", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({ rules, upstream: client }));
    const res = await agent.callTool({ name: "merge_pull_request", arguments: { pullNumber: 1 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("not granted");
    expect(seen).toEqual([]);
  });

  it("refuses every call after expiry", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({ rules: expiredRules(), upstream: client }));
    const res = await agent.callTool({
      name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "a" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("expired");
    expect(seen).toEqual([]);
  });

  // Date.parse of a malformed string is NaN, and `now >= NaN` is false, so the
  // obvious expiry check reads an unreadable expiry as "not expired yet".
  it("treats an unparseable expiry as expired, not as never", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({
      rules: { ...rules, expiresAt: "whenever" }, upstream: client,
    }));
    const res = await agent.callTool({ name: "get_file_contents", arguments: {} });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
    expect((await agent.listTools()).tools).toEqual([]);
  });

  it("reports each decision to the observer", async () => {
    const { client } = await fakeUpstream();
    const decisions: Decision[] = [];
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, onDecision: (d) => decisions.push(d),
    }));
    await agent.callTool({
      name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "a" },
    });
    await agent.callTool({ name: "merge_pull_request", arguments: {} });
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ kind: "allow", tool: "get_file_contents" });
    expect(decisions[1]).toMatchObject({ kind: "deny", tool: "merge_pull_request" });
  });

  // An upstream failure arrives as a thrown McpError, not as isError. Letting
  // it propagate turns a GitHub outage into a protocol error the agent cannot
  // read, and leaves the decision log claiming the call went through.
  it("turns an upstream failure into a readable result, not a protocol throw", async () => {
    const { client } = await fakeUpstream({ failOn: "get_file_contents" });
    const decisions: Decision[] = [];
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, onDecision: (d) => decisions.push(d),
    }));
    const res = await agent.callTool({ name: "get_file_contents", arguments: {} });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain("upstream");
    // The mandate allowed this; saying "Mandate denied" would be a lie.
    expect(text).not.toContain("Mandate denied");
    expect(decisions[0]).toMatchObject({ kind: "allow" });
  });

  it("treats a call with no arguments as a call with empty arguments", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({ rules, upstream: client }));
    await agent.callTool({ name: "get_file_contents" });
    expect(seen).toEqual([{ tool: "get_file_contents", args: {} }]);
  });
});

// Task 11 established that nine catalog tools are reached by more than one
// operation, and that a call is allowed if it satisfies at least one rule. The
// plan's `rules.find(r => r.tool === tool)` took the first and ignored the rest.
describe("a tool several grants reach", () => {
  const shared: ProxyRules = {
    ...rules,
    allowedTools: ["get_file_contents"],
    rules: [
      // repo.read: no path limit at all.
      { tool: "get_file_contents", action: "repo.read", resources: ["acme/api"] },
      // contents.read: limited to src.
      {
        tool: "get_file_contents", action: "contents.read", resources: ["acme/api"],
        paths: ["src/**"],
      },
    ],
  };

  const byAction = (allow: readonly string[]) =>
    (rule: { action: string }): Decision =>
      allow.includes(rule.action)
        ? { kind: "allow", tool: "get_file_contents" }
        : { kind: "deny", tool: "get_file_contents", clause: rule.action, reason: "no" };

  it("allows the call when any one rule accepts it", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({
      rules: shared, upstream: client, enforceArguments: byAction(["repo.read"]),
    }));
    const res = await agent.callTool({ name: "get_file_contents", arguments: { path: "README.md" } });
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("allows it when the other rule is the one that accepts", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({
      rules: shared, upstream: client, enforceArguments: byAction(["contents.read"]),
    }));
    await agent.callTool({ name: "get_file_contents", arguments: { path: "src/a.ts" } });
    expect(seen).toHaveLength(1);
  });

  it("denies only when every rule rejects it", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({
      rules: shared, upstream: client, enforceArguments: byAction([]),
    }));
    const res = await agent.callTool({ name: "get_file_contents", arguments: { path: "/etc/passwd" } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("reports the denial of the last rule tried, so the message names a clause", async () => {
    const { client } = await fakeUpstream();
    const decisions: Decision[] = [];
    const agent = await connectAgent(createProxyServer({
      rules: shared, upstream: client, enforceArguments: byAction([],),
      onDecision: (d) => decisions.push(d),
    }));
    await agent.callTool({ name: "get_file_contents", arguments: {} });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "deny" });
    expect(decisions[0]).toHaveProperty("clause");
  });
});

describe("proxy with argument enforcement — the phase 2 exit criterion", () => {
  it("allows the issue-fixing path and blocks the merge", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, enforceArguments: makeArgumentEnforcer(rules),
    }));

    expect((await agent.callTool({
      name: "create_branch",
      arguments: { owner: "acme", repo: "api", branch: "agent/42-fix", from_branch: "main" },
    })).isError).toBeFalsy();

    expect((await agent.callTool({
      name: "create_or_update_file",
      arguments: {
        owner: "acme", repo: "api", branch: "agent/42-fix",
        path: "src/fix.ts", content: "x",
      },
    })).isError).toBeFalsy();

    expect((await agent.callTool({
      name: "create_pull_request",
      arguments: {
        owner: "acme", repo: "api", head: "agent/42-fix", base: "main", title: "Fix #42",
      },
    })).isError).toBeFalsy();

    const merge = await agent.callTool({
      name: "merge_pull_request",
      arguments: { owner: "acme", repo: "api", pullNumber: 1 },
    });
    expect(merge.isError).toBe(true);
    expect(seen.map((s) => s.tool)).not.toContain("merge_pull_request");
  });

  it("blocks a workflow write even though contents.write is granted", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, enforceArguments: makeArgumentEnforcer(rules),
    }));
    const res = await agent.callTool({
      name: "create_or_update_file",
      arguments: {
        owner: "acme", repo: "api", branch: "agent/42-fix",
        path: ".github/workflows/ci.yml", content: "evil",
      },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain(".github/workflows/**");
    expect(seen).toEqual([]);
  });

  // The denial has to arrive as something a reviewer can act on, not just a
  // refusal: R10 asks for the clause and a reviewable widen request.
  it("turns a denial into a pause record naming the clause and a narrow widen", async () => {
    const { client } = await fakeUpstream();
    const pauses: PauseRecord[] = [];
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, enforceArguments: makeArgumentEnforcer(rules),
      onDecision: (d) => {
        if (d.kind !== "deny") return;
        pauses.push(pauseRecord({
          mandateId: rules.mandateId, decision: d, observed: { branch: "main" },
        }));
      },
    }));

    await agent.callTool({
      name: "create_or_update_file",
      arguments: { owner: "acme", repo: "api", branch: "main", path: "src/a.ts", content: "x" },
    });

    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.clause).toBe("contents.write.branches");
    expect(pauses[0]?.widenRequest?.addGrant.branches).toEqual(["main"]);
  });

  it("offers no widen for the workflow write, so the deny list stays meaningful", async () => {
    const { client } = await fakeUpstream();
    const pauses: PauseRecord[] = [];
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, enforceArguments: makeArgumentEnforcer(rules),
      onDecision: (d) => {
        if (d.kind !== "deny") return;
        pauses.push(pauseRecord({
          mandateId: rules.mandateId, decision: d,
          observed: { path: ".github/workflows/ci.yml" },
        }));
      },
    }));

    await agent.callTool({
      name: "create_or_update_file",
      arguments: {
        owner: "acme", repo: "api", branch: "agent/42-fix",
        path: ".github/workflows/ci.yml", content: "x",
      },
    });

    expect(pauses[0]?.clause).toBe("contents.write.denyPaths");
    expect(pauses[0]?.widenRequest).toBeUndefined();
  });

  it("stops the second pull request, because the grant allows one", async () => {
    const { client, seen } = await fakeUpstream();
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, enforceArguments: makeArgumentEnforcer(rules),
    }));
    const args = {
      owner: "acme", repo: "api", head: "agent/42-fix", base: "main", title: "Fix #42",
    };
    expect((await agent.callTool({ name: "create_pull_request", arguments: args })).isError)
      .toBeFalsy();
    const second = await agent.callTool({ name: "create_pull_request", arguments: args });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toContain("at most 1");
    expect(seen.filter((s) => s.tool === "create_pull_request")).toHaveLength(1);
  });
});

// R8. The recorder's trace is the ground truth Task 17 replays, so the proxy
// has to record on every path it can take — including the one where the
// mandate allowed the call and the upstream server then threw.
describe("proxy recording", () => {
  const recorder = () => new Recorder({
    mode: "enforced", mandateId: rules.mandateId, mandateHash: rules.mandateHash,
  });

  const withRecorder = async (over: Partial<ProxyDeps> = {}) => {
    const { client, seen } = await fakeUpstream(over as { failOn?: string });
    const rec = recorder();
    const agent = await connectAgent(createProxyServer({
      rules, upstream: client, enforceArguments: makeArgumentEnforcer(rules),
      recorder: rec, ...over,
    }));
    return { agent, rec, seen };
  };

  it("records an allowed call with the action of the rule that allowed it", async () => {
    const { agent, rec } = await withRecorder();
    await agent.callTool({
      name: "create_or_update_file",
      arguments: {
        owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts", content: "x",
      },
    });
    expect(rec.graph().nodes).toHaveLength(1);
    expect(rec.graph().nodes[0]).toMatchObject({
      seq: 1, tool: "create_or_update_file", action: "contents.write",
      resource: "acme/api", branch: "agent/42-fix", decision: "allow", outcome: "ok",
    });
  });

  it("records a denial for a tool the mandate does not grant", async () => {
    const { agent, rec } = await withRecorder();
    await agent.callTool({ name: "merge_pull_request", arguments: { owner: "acme", repo: "api" } });
    const node = rec.graph().nodes[0];
    expect(node).toMatchObject({ tool: "merge_pull_request", decision: "deny", clause: "mandate.grants" });
    // No rule was consulted, so no operation can honestly be named.
    expect(node!.action).toBeUndefined();
  });

  it("records an argument denial with the clause and the rule's action", async () => {
    const { agent, rec } = await withRecorder();
    await agent.callTool({
      name: "create_or_update_file",
      arguments: {
        owner: "acme", repo: "api", branch: "main", path: "src/a.ts", content: "x",
      },
    });
    expect(rec.graph().nodes[0]).toMatchObject({
      decision: "deny", clause: "contents.write.branches", action: "contents.write",
      branch: "main",
    });
  });

  it("records a denial once the mandate has expired", async () => {
    const { client } = await fakeUpstream();
    const rec = recorder();
    const agent = await connectAgent(createProxyServer({
      rules: expiredRules(), upstream: client, recorder: rec,
    }));
    await agent.callTool({ name: "get_file_contents", arguments: { owner: "acme", repo: "api" } });
    expect(rec.graph().nodes[0]).toMatchObject({ decision: "deny", clause: "mandate.expiry" });
  });

  // The upstream call sits inside a try/catch, and an MCP upstream failure
  // arrives as a thrown McpError. Recording only after a successful await loses
  // the node entirely — for a call the mandate allowed and whose `max` quota
  // was already spent.
  it("records an allowed call that failed upstream", async () => {
    const { agent, rec } = await withRecorder({ failOn: "get_file_contents" } as Partial<ProxyDeps>);
    const res = await agent.callTool({
      name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "a" },
    });
    expect(res.isError).toBe(true);
    expect(rec.graph().nodes).toHaveLength(1);
    expect(rec.graph().nodes[0]).toMatchObject({
      tool: "get_file_contents", decision: "allow", outcome: "upstream-failure", outputBytes: 0,
    });
    expect(rec.graph().nodes[0]!.reason).toContain("upstream exploded");
  });

  it("records one node per call, in order, across allows and denials", async () => {
    const { agent, rec } = await withRecorder();
    await agent.callTool({
      name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "a" },
    });
    await agent.callTool({ name: "delete_file", arguments: { owner: "acme", repo: "api" } });
    await agent.callTool({
      name: "create_branch", arguments: { owner: "acme", repo: "api", branch: "agent/42-x" },
    });
    expect(rec.graph().nodes.map((n) => [n.seq, n.tool, n.decision])).toEqual([
      [1, "get_file_contents", "allow"],
      [2, "delete_file", "deny"],
      [3, "create_branch", "allow"],
    ]);
    // A trace the proxy wrote must be one parseJsonl accepts.
    expect(parseJsonl(rec.toJsonl()).nodes).toHaveLength(3);
  });

  it("never records a raw argument the mandate does not enforce", async () => {
    const { agent, rec } = await withRecorder();
    await agent.callTool({
      name: "create_or_update_file",
      arguments: {
        owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
        content: "ghp_SUPERSECRETTOKEN",
      },
    });
    expect(rec.toJsonl()).not.toContain("ghp_SUPERSECRETTOKEN");
  });
});

// A tool several grants reach is decided by whichever rule accepts, which is
// not necessarily the first. Recording the first candidate's action would
// attribute the call to an operation that refused it.
describe("recording a tool several grants reach", () => {
  const shared: ProxyRules = {
    ...rules,
    allowedTools: ["get_file_contents"],
    rules: [
      { tool: "get_file_contents", action: "repo.read", resources: ["acme/api"], paths: ["docs/**"] },
      { tool: "get_file_contents", action: "contents.read", resources: ["acme/api"], paths: ["src/**"] },
    ],
  };

  it("records the action of the rule that actually allowed the call", async () => {
    const { client } = await fakeUpstream();
    const rec = new Recorder({
      mode: "enforced", mandateId: shared.mandateId, mandateHash: shared.mandateHash,
    });
    const agent = await connectAgent(createProxyServer({
      rules: shared, upstream: client, enforceArguments: makeArgumentEnforcer(shared),
      recorder: rec,
    }));
    await agent.callTool({
      name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "src/a.ts" },
    });
    expect(rec.graph().nodes[0]).toMatchObject({ decision: "allow", action: "contents.read" });
  });

  it("records the action of the last rule to refuse, when none allow", async () => {
    const { client } = await fakeUpstream();
    const rec = new Recorder({
      mode: "enforced", mandateId: shared.mandateId, mandateHash: shared.mandateHash,
    });
    const agent = await connectAgent(createProxyServer({
      rules: shared, upstream: client, enforceArguments: makeArgumentEnforcer(shared),
      recorder: rec,
    }));
    await agent.callTool({
      name: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "etc/a.ts" },
    });
    expect(rec.graph().nodes[0]).toMatchObject({
      decision: "deny", action: "contents.read", clause: "contents.read.paths",
    });
  });
});

describe("compiled rules carry the mandate hash", () => {
  // The trace header names the exact mandate the proxy enforced. Without the
  // hash on ProxyRules the proxy has nothing to put there, and `mandateId`
  // alone cannot distinguish two mandates with the same slug — slug() collides
  // on tasks with the same opening words.
  it("is a full sha256", () => {
    expect(rules.mandateHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
