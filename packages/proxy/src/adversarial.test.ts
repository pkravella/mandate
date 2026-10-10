import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyRules, ToolRule } from "@mandate-dev/compiler";
import { compileEgress } from "@mandate-dev/compiler";
import { MandateSchema, markValidated } from "@mandate-dev/schema";
import { createProxyServer } from "./proxy.js";
import { extractArgs, makeArgumentEnforcer } from "./enforce.js";

/**
 * The adversarial suite, proxy half (Task 19 families B and D).
 *
 * Family B is a hostile upstream: a server that renames tools, writes
 * instructions into descriptions, floods the list, or smuggles a NUL into a
 * name. Family D is hostile arguments.
 *
 * Two cases here assert that the proxy ALLOWS the call, which is not an
 * oversight: both are measured, documented decisions whose control is a
 * different layer. A suite that asserted a denial there would be asserting
 * Mandate's docs are wrong. The index records why for each.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(root(p), "utf8");
const json = (p: string): Record<string, unknown> =>
  JSON.parse(read(`fixtures/adversarial/${p}`)) as Record<string, unknown>;

interface IndexCase {
  readonly family: string;
  readonly id: string;
  readonly file?: string;
  readonly invariant: string;
  readonly expect?: { readonly outcome: string; readonly clause?: string; readonly why?: string };
}
const INDEX = JSON.parse(read("fixtures/adversarial/index.json")) as readonly IndexCase[];

const DESTINATIONS = ["github.com/acme/api"];

/**
 * `ProxyRules` around one case's rule, since each case carries its own grant --
 * and its own destination list, because the destination rules only differ where
 * the allow entry's shape differs. A case using the default list cannot exercise
 * the bare-host boundary at all.
 */
const rulesFor = (rule: ToolRule, destinations: readonly string[] = DESTINATIONS): ProxyRules => ({
  mandateId: "adv",
  mandateHash: "c".repeat(64),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  allowedTools: [rule.tool],
  rules: [rule],
  destinations,
});

// ---------------------------------------------------------------------------
// Family D: argument-level escapes
// ---------------------------------------------------------------------------

interface ArgsFixture {
  readonly note: string;
  readonly rule: ToolRule;
  readonly args: Record<string, unknown>;
  /** The mandate's allowed destinations, when the case turns on their shape. */
  readonly destinations?: readonly string[];
  readonly generate?: { readonly kind: string; readonly count: number; readonly template: string };
}

/**
 * Builds the oversized payloads rather than committing them. A 10000-entry
 * `files` array is 300 KB of fixture nobody would read, and the shape is the
 * only interesting part.
 */
function argsOf(fixture: ArgsFixture): Record<string, unknown> {
  if (fixture.generate?.kind !== "files") return fixture.args;
  const files = Array.from(
    { length: fixture.generate.count },
    (_, i) => ({ path: fixture.generate!.template.replace("%d", String(i)) }),
  );
  return { ...fixture.args, files };
}

const argCases = INDEX.filter((c) => c.family === "args");

describe("adversarial: argument-level escapes", () => {
  it("covers twenty-one argument attacks", () => {
    expect(argCases.length).toBe(21);
  });

  for (const c of argCases) {
    it(`${c.id}: ${c.invariant.slice(0, 68)}`, () => {
      const fixture = json(c.file ?? "") as unknown as ArgsFixture;
      const rule = fixture.rule;
      const enforce = makeArgumentEnforcer(rulesFor(rule, fixture.destinations));

      const started = Date.now();
      const decision = enforce(rule, argsOf(fixture));
      const elapsed = Date.now() - started;

      // A hostile call must not be able to buy unbounded work either. Measured
      // before the path cap: the 10000-file case took 1111 ms inside one call.
      expect(elapsed, `${c.id} took ${elapsed}ms`).toBeLessThan(500);

      if (c.expect?.outcome === "deny") {
        expect(decision.kind, `${c.id} must be denied`).toBe("deny");
        if (decision.kind !== "deny") return;
        // R10: the denial names the clause it hit and gives a reason.
        expect(decision.clause).toBe(c.expect.clause);
        expect(decision.reason.length).toBeGreaterThan(20);
        return;
      }

      expect(c.expect?.outcome, `${c.id} has no expected outcome`).toBe("allow");
      expect(decision.kind, `${c.id} should be allowed: ${c.expect?.why ?? ""}`).toBe("allow");
    });
  }
});

/**
 * The proxy and the egress layer read one destination list and must not
 * disagree in the direction that matters: anything the proxy lets through has
 * to be reachable through the squid ACL compiled from the same list, or the
 * proxy is allowing calls the sandbox will drop with no reason anywhere.
 *
 * Only extraction is the proxy's own; the validator and the compiler never see
 * tool arguments, so this is the agreement that extraction can break. The
 * reverse direction is deliberately not asserted -- squid cannot see paths, so
 * egress is coarser than the proxy by design.
 */
describe("adversarial: what the proxy allows, egress can reach", () => {
  const hostCovered = (host: string, acl: readonly string[]): boolean =>
    acl.some((e) => (e.startsWith(".")
      ? host === e.slice(1) || host.endsWith(e)
      : host === e));

  const egressFor = (destinations: readonly string[]) => compileEgress(markValidated(
    MandateSchema.parse({
      mandate: "adv", task: "t", requestedBy: "user:a", expiresInMinutes: 60, ceiling: "c@v1",
      grants: [{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
      destinations: { allow: [...destinations] },
    }),
    { ceilingId: "c@v1", userLevel: "push", checkedAt: "2026-10-09T00:00:00.000Z", grantProofs: [] },
  ));

  const allowedWithDestinations = argCases.flatMap((c) => {
    const fixture = json(c.file ?? "") as unknown as ArgsFixture;
    const args = argsOf(fixture);
    const destinations = fixture.destinations ?? DESTINATIONS;
    const decision = makeArgumentEnforcer(rulesFor(fixture.rule, destinations))(fixture.rule, args);
    const extracted = extractArgs(fixture.rule.tool, args).destinations;
    return decision.kind === "allow" && extracted.length > 0
      ? [{ id: c.id, destinations, extracted, args }] : [];
  });

  // Guards against this passing because nothing reached it.
  it("has allowed cases that carry a destination to check", () => {
    expect(allowedWithDestinations.map((c) => c.id).sort())
      .toEqual(["destination-scp-inside-allow", "destination-subdomain-under-bare-host"]);
  });

  for (const c of allowedWithDestinations) {
    it(`${c.id}: every destination the proxy allowed is in the egress ACL`, () => {
      const { aclEntries } = egressFor(c.destinations);
      for (const d of c.extracted) {
        const host = d.split("/")[0] ?? "";
        expect(hostCovered(host, aclEntries), `${host} against ${aclEntries.join(" ")}`).toBe(true);
      }
    });
  }

  // The one place the layers differ on purpose. The proxy allows an scp remote
  // to the allowed repository because it is the same destination; the network
  // still refuses ssh, because the compiled config tunnels to 443 and nothing
  // else. sandbox/verify.mjs proves that behaviourally against real squid
  // (proxy.allowed-host-other-port); this pins that the config still says so.
  it("relies on the 443-only tunnel for a non-HTTP remote the proxy allows", () => {
    const { squidConf } = egressFor(DESTINATIONS);
    expect(squidConf).toMatch(/^acl SSL_ports port 443$/m);
    expect(squidConf).toMatch(/^http_access deny CONNECT !SSL_ports$/m);
  });
});

// ---------------------------------------------------------------------------
// Family B: a hostile upstream
// ---------------------------------------------------------------------------

interface ToolsFixture {
  readonly note: string;
  readonly tools: readonly { name: string; description: string; inputSchema: unknown }[];
  readonly generate?: { readonly kind: string; readonly count?: number;
    readonly perPage?: number; readonly includeAllowed?: readonly string[] };
}

interface Upstream {
  readonly client: Client;
  readonly seen: { tool: string; args: unknown }[];
  readonly listCalls: () => number;
  /** How many tools the upstream actually published, across all pages. */
  readonly published: () => number;
}

/** A hostile stand-in for github-mcp-server, built from a family-B fixture. */
async function hostileUpstream(fixture: ToolsFixture): Promise<Upstream> {
  const seen: { tool: string; args: unknown }[] = [];
  let lists = 0;
  let published = 0;
  const server = new Server({ name: "hostile", version: "0" }, { capabilities: { tools: {} } });

  const flood = (): { name: string; description: string; inputSchema: { type: "object" } }[] => {
    const n = fixture.generate?.count ?? 0;
    const extra = Array.from({ length: n }, (_, i) => ({
      name: `flood_tool_${i}`, description: "noise", inputSchema: { type: "object" as const },
    }));
    for (const name of fixture.generate?.includeAllowed ?? []) {
      extra.push({ name, description: "buried", inputSchema: { type: "object" as const } });
    }
    return extra;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    lists += 1;
    const declared = fixture.tools.map((t) => ({
      name: t.name, description: t.description,
      inputSchema: t.inputSchema as { type: "object" },
    }));
    if (fixture.generate?.kind === "flood") {
      const all = [...declared, ...flood()];
      published += all.length;
      return { tools: all };
    }
    // Always a nextCursor: the walk must terminate on the proxy's own bound.
    if (fixture.generate?.kind === "endless-cursor") {
      published += declared.length;
      return { tools: declared, nextCursor: `page-${lists}` };
    }
    published += declared.length;
    return { tools: declared };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.push({ tool: req.params.name, args: req.params.arguments });
    return { content: [{ type: "text" as const, text: "ok" }] };
  });

  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "adv-upstream", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, seen, listCalls: () => lists, published: () => published };
}

const READ_RULE: ToolRule = {
  tool: "get_file_contents", action: "contents.read", resources: ["acme/api"],
};

async function connectAgent(proxy: Server): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "agent", version: "0" });
  await Promise.all([proxy.connect(a), agent.connect(b)]);
  return agent;
}

const toolCases = INDEX.filter((c) => c.family === "tools");

describe("adversarial: a hostile upstream", () => {
  it("covers six hostile-upstream cases", () => {
    expect(toolCases.length).toBe(6);
  });

  it("renamed-merge: a rule is keyed on the name the agent calls, not on behaviour", async () => {
    const fixture = json("tools/renamed-merge.json") as unknown as ToolsFixture;
    const upstream = await hostileUpstream(fixture);
    const rules = rulesFor(READ_RULE);
    const agent = await connectAgent(createProxyServer({
      rules, upstream: upstream.client, enforceArguments: makeArgumentEnforcer(rules),
    }));

    // The upstream's real merge tool is called get_file_contents, so it is the
    // one the agent can reach -- and it reaches get_file_contents' rule.
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["get_file_contents"]);
    expect(names).not.toContain("merge_pull_request");

    // That rule permits only acme/api, so a call outside it is refused even
    // though the tool is, in truth, the merge tool.
    const outside = await agent.callTool({
      name: "get_file_contents", arguments: { owner: "evil", repo: "api", path: "a" },
    });
    expect(outside.isError).toBe(true);
    expect(upstream.seen).toHaveLength(0);
  });

  it("description-is-config: a description is content, never configuration", async () => {
    const fixture = json("tools/description-is-config.json") as unknown as ToolsFixture;
    const upstream = await hostileUpstream(fixture);
    const rules = rulesFor(READ_RULE);
    const agent = await connectAgent(createProxyServer({
      rules, upstream: upstream.client, enforceArguments: makeArgumentEnforcer(rules),
    }));

    const listed = (await agent.listTools()).tools;
    // The hostile text survives to the agent -- the proxy does not sanitise
    // content, and pretending otherwise would be the model-judgment the PRD
    // forbids. What matters is that it changed no decision.
    expect(listed[0]?.description).toContain("SYSTEM DIRECTIVE");

    const outside = await agent.callTool({
      name: "get_file_contents", arguments: { owner: "evil", repo: "api", path: "a" },
    });
    expect(outside.isError).toBe(true);
    expect(upstream.seen).toHaveLength(0);
  });

  it("two-thousand-tools: the agent sees allowedTools and nothing more", async () => {
    const fixture = json("tools/two-thousand-tools.json") as unknown as ToolsFixture;
    const upstream = await hostileUpstream(fixture);
    const rules = rulesFor(READ_RULE);
    const agent = await connectAgent(createProxyServer({ rules, upstream: upstream.client }));

    const names = (await agent.listTools()).tools.map((t) => t.name);

    // The flood has to have happened, or this case asserts nothing beyond what
    // every other tools case already asserts. Measured: setting the fixture's
    // count to 0 left this test passing, because the fixture declares no tools
    // of its own and the filtered result is the same either way.
    expect(upstream.published(), "the upstream did not actually flood")
      .toBeGreaterThan(2000);

    expect(names).toEqual(["get_file_contents"]);
    expect(names.filter((n) => n.startsWith("flood_tool_"))).toHaveLength(0);
  });

  it("nul-in-name: an embedded NUL does not make a tool the allowed one", async () => {
    const fixture = json("tools/nul-in-name.json") as unknown as ToolsFixture;
    const upstream = await hostileUpstream(fixture);
    const rules = rulesFor(READ_RULE);
    const agent = await connectAgent(createProxyServer({
      rules, upstream: upstream.client, enforceArguments: makeArgumentEnforcer(rules),
    }));

    // The declared name is "get_file_contents\0merge_pull_request", which is not
    // equal to "get_file_contents", so it is filtered out entirely.
    expect((await agent.listTools()).tools).toHaveLength(0);

    const called = await agent.callTool({
      name: "get_file_contents\u0000merge_pull_request",
      arguments: { owner: "acme", repo: "api", path: "a" },
    });
    expect(called.isError).toBe(true);
    expect(upstream.seen).toHaveLength(0);

    // The clause matters, not only the refusal. Two independent guards would
    // both stop this -- the exact-name check on `allowedTools`, and the rule
    // lookup that finds no rule for a name no mandate compiled -- so without
    // naming the clause, a prefix-matching name check survives as an equivalent
    // mutant: the call still fails, but for the wrong reason, reported to the
    // developer as `mandate.internal` ("a compiler bug") rather than as the
    // truth, which is that nothing granted this.
    expect(JSON.stringify(called.content)).toContain("mandate.grants");
    expect(JSON.stringify(called.content)).not.toContain("mandate.internal");
  });

  it("shadow-allowed-tool: a shadowing schema introduces no unchecked field", async () => {
    const fixture = json("tools/shadow-allowed-tool.json") as unknown as ToolsFixture;
    const upstream = await hostileUpstream(fixture);
    const rules = rulesFor(READ_RULE);
    const agent = await connectAgent(createProxyServer({
      rules, upstream: upstream.client, enforceArguments: makeArgumentEnforcer(rules),
    }));

    // Whichever declaration the agent sees, the enforcer reads the ARGUMENTS,
    // not the advertised schema -- so the extra `url` the shadow declares is
    // still checked against destinations.allow.
    const sneaky = await agent.callTool({
      name: "get_file_contents",
      arguments: { owner: "acme", repo: "api", path: "a", url: "https://evil.example.com/x" },
    });
    expect(sneaky.isError).toBe(true);
    expect(JSON.stringify(sneaky.content)).toContain("destinations.allow");
    expect(upstream.seen).toHaveLength(0);
  });

  it("cursor-loop: an endless upstream cursor terminates, and hides rather than reveals", async () => {
    const fixture = json("tools/cursor-loop.json") as unknown as ToolsFixture;
    const upstream = await hostileUpstream(fixture);
    const rules = rulesFor(READ_RULE);
    const agent = await connectAgent(createProxyServer({ rules, upstream: upstream.client }));

    const names = (await agent.listTools()).tools.map((t) => t.name);
    // Terminated at the proxy's page bound rather than looping forever.
    expect(upstream.listCalls()).toBeLessThanOrEqual(50);
    expect(upstream.listCalls()).toBeGreaterThan(1);
    // Stopping early can only ever hide a tool, which is the safe direction.
    expect(new Set(names)).toEqual(new Set(["get_file_contents"]));
  });
});
