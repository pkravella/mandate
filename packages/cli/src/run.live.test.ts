import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseJsonl } from "@mandate-dev/proxy";
import { githubResolver } from "./authority.js";
import { runRun } from "./commands/run.js";

/**
 * `mandate run` and `mandate serve` against real everything, once.
 *
 * The offline tests prove the wiring with fakes. This proves the thing the
 * fakes stand in for: that an agent which knows nothing about Mandate — it is
 * handed an MCP config and spawns what the config names, exactly as Claude Code
 * and Codex do — reaches GitHub only through the enforced proxy, with a real
 * App token, the real `github-mcp-server`, and a real model deciding what to
 * call.
 *
 * The "agent" here is a script that reads `MANDATE_MCP_CONFIG`, starts the
 * server it names over stdio, and drives the Anthropic API against the tools it
 * is offered. That is deliberately the same shape as a real MCP client and
 * deliberately not an import of anything in this repository: a test that
 * reached into `openSession` would prove the session works, not that the
 * integration does.
 *
 * Costs money and writes to a real repository. Needs MANDATE_LIVE=1, an API
 * key, and the App's details. Budgeted at roughly $0.25: one writer call is not
 * made (the mandate is a committed fixture, because what is under test is the
 * run path and not the writer) and the agent's turns are capped.
 */
const env = (n: string): string | undefined => process.env[n];
const live = env("MANDATE_LIVE") === "1"
  && env("ANTHROPIC_API_KEY") !== undefined
  && env("MANDATE_APP_ID") !== undefined
  && env("MANDATE_INSTALLATION_ID") !== undefined
  && env("MANDATE_APP_KEY_PATH") !== undefined
  && env("MANDATE_TEST_REPO") !== undefined;

const REPO = env("MANDATE_TEST_REPO") ?? "";

/**
 * The agent script has to live INSIDE the repository tree.
 *
 * Node resolves a bare import from the importing file's location upwards, not
 * from the working directory, so an agent written to the system temp directory
 * cannot find `@anthropic-ai/sdk` however it is launched — measured, on the
 * first live run, which failed before spending anything. A real agent is an
 * installed binary with its own dependencies; this stand-in borrows the
 * repository's, so it goes where they are reachable.
 */
/** What a real install runs. The default resolves against the source tree under vitest. */
const builtEntry = (): string =>
  fileURLToPath(new URL("../dist/index.js", import.meta.url));

const agentDir = (): string => {
  const dir = fileURLToPath(new URL("../.live-agent", import.meta.url));
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * The real lookup. Required here rather than optional: this run is an
 * authorisation record or it is nothing, and a live test that quietly fell back
 * to an asserted level would be testing the wrong path.
 */
const resolver = (): NonNullable<ReturnType<typeof githubResolver>> => {
  const r = githubResolver();
  if (r === undefined) throw new Error("the App credentials are needed for a live run");
  return r;
};
const fixture = (n: string): string =>
  fileURLToPath(new URL(`../../../fixtures/ceilings/${n}`, import.meta.url));

/** What the agent is asked to do. Read-only, so the sandbox needs no reset. */
const TASK = `Read src/retry.js in ${REPO} and say in one sentence what it does.`;

/** The agent: an MCP client that knows nothing about Mandate. */
const AGENT = `
import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = JSON.parse(readFileSync(process.env.MANDATE_MCP_CONFIG, "utf8"));
const server = config.mcpServers.github;

// Exactly what an MCP client does: spawn what the config names.
const client = new Client({ name: "unaware-agent", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: server.command, args: server.args, env: { ...process.env, ...server.env },
}));

const offered = (await client.listTools()).tools;
const report = { tools: offered.map((t) => t.name), calls: [], denials: 0 };
const flush = () => writeFileSync(process.env.AGENT_REPORT, JSON.stringify(report));
flush();

const tools = offered.map((t) => ({
  name: t.name, description: t.description ?? "", input_schema: t.inputSchema,
}));
const anthropic = new Anthropic();
const messages = [{ role: "user", content: process.env.AGENT_TASK }];
let denials = 0;

for (let turn = 0; turn < 6; turn += 1) {
  const reply = await anthropic.messages.stream({
    model: "claude-opus-5-5", max_tokens: 8000,
    thinking: { type: "adaptive" }, output_config: { effort: "medium" },
    tools, tool_choice: { type: "auto" }, messages,
  }).finalMessage();
  messages.push({ role: "assistant", content: reply.content });
  const calls = reply.content.filter((c) => c.type === "tool_use");
  if (calls.length === 0) break;
  const results = [];
  for (const call of calls) {
    const out = await client.callTool({ name: call.name, arguments: call.input ?? {} });
    if (out.isError) denials += 1;
    report.calls.push({ tool: call.name, isError: out.isError === true });
    report.denials = denials;
    flush();
    results.push({
      type: "tool_result", tool_use_id: call.id,
      content: JSON.stringify(out.content).slice(0, 3000),
      ...(out.isError ? { is_error: true } : {}),
    });
  }
  messages.push({ role: "user", content: results });
}
report.denials = denials;
flush();
await client.close();
`;

describe.skipIf(!live)("mandate run, live", () => {
  afterAll(() => {
    rmSync(fileURLToPath(new URL("../.live-agent", import.meta.url)), { recursive: true, force: true });
  });

  it("runs an unaware agent whose only route to GitHub is the mandate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-live-run-"));
    const agentPath = join(agentDir(), "run-agent.mjs");
    writeFileSync(agentPath, AGENT, "utf8");

    const tracePath = join(dir, "trace.jsonl");
    const mandatePath = join(dir, "mandate.yaml");
    // A read-only mandate. The run path is what is under test, and a mandate
    // that writes would need the sandbox repository reset between runs.
    writeFileSync(mandatePath, `
mandate: live-run-check
task: "Read src/retry.js and report what it does"
requestedBy: user:pkravella
expiresInMinutes: 30
ceiling: sandbox@v1
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["${REPO}"]
destinations:
  allow: ["github.com/${REPO}"]
`, "utf8");

    const reportPath = join(dir, "report.json");
    const lines: string[] = [];
    const code = await runRun({
      file: mandatePath,
      ceiling: fixture("sandbox-v1.cedar"),
      schema: fixture("schema.cedarschema"),
      destinations: fixture("sandbox-v1.destinations"),
      as: "pkravella",
      repo: REPO,
      trace: tracePath,
      agent: [process.execPath, agentPath],
    }, (s) => { lines.push(s); console.log(s); }, {
      // The real lookup, which is the point: this run is an authorisation
      // record or it is nothing.
      resolve: resolver(),
      selfPath: builtEntry(),
      // The agent reports through a file. `runRun` gives a real agent the
      // terminal, which is right for an interactive tool and means its output
      // never reaches the log callback — the first version of this test scraped
      // the log and found nothing while the run itself had worked.
      launch: async (command, argv, agentEnv) => {
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync(command, [...argv], {
          stdio: "inherit",
          env: { ...process.env, ...agentEnv, AGENT_REPORT: reportPath, AGENT_TASK: TASK },
        });
        return r.status ?? 1;
      },
    });

    expect(code, lines.join("\n")).toBe(0);

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      tools: string[]; calls: { tool: string; isError: boolean }[]; denials: number;
    };
    const offered = report.tools;
    console.log(`\n--- offered ${offered.length} tool(s): ${offered.join(", ")}`);
    console.log(`--- the agent made ${report.calls.length} call(s), ${report.denials} denied`);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain("merge_pull_request");
    expect(offered).not.toContain("create_or_update_file");
    expect(offered).not.toContain("delete_file");

    // The trace is the audit record, and the strict parser must read it back.
    const graph = parseJsonl(readFileSync(tracePath, "utf8"));
    expect(graph.mode).toBe("enforced");
    console.log(`--- recorded ${graph.nodes.length} call(s)`);
    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      if (node.decision === "deny") expect(node.clause).toBeDefined();
    }
  }, 300_000);

  /**
   * The negative control. Without it the test above passes if the agent simply
   * never tried anything out of scope, which is the trap the Phase 3 benchmark
   * fell into: zero denials looked like a clean run and meant the tool was
   * never offered.
   *
   * So this calls a write tool by name, directly, bypassing the model. The
   * proxy must refuse it and name a clause, and nothing must reach GitHub.
   */
  it("refuses a write the mandate does not grant, naming the clause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-live-deny-"));
    const mandatePath = join(dir, "mandate.yaml");
    const tracePath = join(dir, "trace.jsonl");
    writeFileSync(mandatePath, `
mandate: live-deny-check
task: "Read src/retry.js"
requestedBy: user:pkravella
expiresInMinutes: 30
ceiling: sandbox@v1
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["${REPO}"]
destinations:
  allow: ["github.com/${REPO}"]
`, "utf8");

    // An "agent" that makes one ungranted call and reports the answer. No model,
    // so this costs nothing beyond the token mint.
    const agentPath = join(agentDir(), "deny-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const config = JSON.parse(readFileSync(process.env.MANDATE_MCP_CONFIG, "utf8"));
const s = config.mcpServers.github;
const c = new Client({ name: "deny-probe", version: "0.1.0" });
await c.connect(new StdioClientTransport({
  command: s.command, args: s.args, env: { ...process.env, ...s.env },
}));
const names = (await c.listTools()).tools.map((t) => t.name);
const out = await c.callTool({
  name: "merge_pull_request",
  arguments: { owner: "${REPO.split("/")[0] ?? ""}", repo: "${REPO.split("/")[1] ?? ""}", pullNumber: 1 },
});
writeFileSync(process.env.AGENT_REPORT, JSON.stringify({
  offered: names, isError: out.isError === true, text: JSON.stringify(out.content).slice(0, 600),
}));
await c.close();
`, "utf8");

    const reportPath = join(dir, "report.json");
    const lines: string[] = [];
    const code = await runRun({
      file: mandatePath,
      ceiling: fixture("sandbox-v1.cedar"),
      schema: fixture("schema.cedarschema"),
      destinations: fixture("sandbox-v1.destinations"),
      as: "pkravella",
      repo: REPO,
      trace: tracePath,
      agent: [process.execPath, agentPath],
    }, (s) => { lines.push(s); console.log(s); }, {
      resolve: resolver(),
      selfPath: builtEntry(),
      launch: async (command, argv, agentEnv) => {
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync(command, [...argv], {
          stdio: "inherit",
          env: { ...process.env, ...agentEnv, AGENT_REPORT: reportPath },
        });
        return r.status ?? 1;
      },
    });

    expect(code, lines.join("\n")).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      offered: string[]; isError: boolean; text: string;
    };
    console.log(`\n--- merge refused: ${report.isError}`);
    console.log(`--- ${report.text}`);
    // The tool was not even offered, AND calling it by name is refused. Both
    // matter: the first is the authority cut, the second is what happens when
    // something calls it anyway.
    expect(report.offered).not.toContain("merge_pull_request");
    expect(report.isError).toBe(true);
    // R10: the refusal names the clause it hit.
    expect(report.text).toMatch(/mandate\.grants/);
  }, 180_000);
});
