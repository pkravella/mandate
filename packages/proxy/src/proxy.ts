import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { rulesForTool, type ProxyRules, type ToolRule } from "@mandate-dev/compiler";
import { attributeCall } from "./attribution.js";
import { extractArgs } from "./enforce.js";
import type { Recorder } from "./graph.js";

export type Decision =
  | { readonly kind: "allow"; readonly tool: string }
  | {
    readonly kind: "deny";
    readonly tool: string;
    readonly clause: string;
    readonly reason: string;
  };

export interface ProxyDeps {
  readonly rules: ProxyRules;
  readonly upstream: Client;
  readonly now?: () => Date;
  readonly onDecision?: (d: Decision) => void;
  /**
   * Installed by Task 13. Called once per rule for the tool, because a tool can
   * be reached by several grants; the call is allowed if any rule accepts it.
   * Defaults to allowing anything already past the tool gate.
   */
  readonly enforceArguments?: (rule: ToolRule, args: Record<string, unknown>) => Decision;
  /**
   * R8. Installed by Task 14. Every decision this proxy makes is recorded,
   * including an allowed call the upstream server then refused or failed.
   */
  readonly recorder?: Recorder;
}

export function denial(tool: string, clause: string, reason: string): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `Mandate denied ${tool}.\n  clause: ${clause}\n  reason: ${reason}\n`
        + `Nothing was sent to GitHub. Request a widen if the task genuinely needs this.`,
    }],
  };
}

/**
 * An upstream failure is not a denial. Saying "Mandate denied" would send a
 * developer looking for a clause that did not fire, and the mandate did in fact
 * allow the call.
 */
function upstreamFailure(tool: string, detail: string): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `The mandate allowed ${tool}, but the upstream GitHub MCP server failed.\n`
        + `  detail: ${detail}\nThis is not a mandate decision.`,
    }],
  };
}

/**
 * Generic over the tool shape so the SDK's own inferred `listTools` element
 * type flows through untouched. Naming a type here instead would need a cast,
 * and the SDK's result type is not the exported `Tool` under
 * `exactOptionalPropertyTypes`.
 */
function annotate<T extends { readonly name: string; readonly description?: string | undefined }>(
  tool: T, rules: readonly ToolRule[],
): T {
  const mine = rules.filter((r) => r.tool === tool.name);
  if (mine.length === 0) return tool;
  const limits: string[] = [];
  for (const r of mine) {
    limits.push(`repositories: ${r.resources.join(", ")}`);
    if (r.branches !== undefined) limits.push(`branches: ${r.branches.join(", ")}`);
    if (r.paths !== undefined) limits.push(`paths: ${r.paths.join(", ")}`);
    if (r.denyPaths !== undefined) limits.push(`never: ${r.denyPaths.join(", ")}`);
    if (r.base !== undefined) limits.push(`base: ${r.base}`);
    if (r.max !== undefined) limits.push(`at most ${r.max} call(s)`);
  }
  return {
    ...tool,
    description: `${tool.description ?? ""}\n\nMandate limits — ${[...new Set(limits)].join("; ")}.`,
  };
}

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** Every upstream tool, following `nextCursor`. */
async function listAllUpstreamTools(upstream: Client): Promise<readonly ListedTool[]> {
  const all: ListedTool[] = [];
  let cursor: string | undefined;
  // A malicious or broken upstream could cycle cursors forever. Bound it: the
  // GitHub MCP server publishes a few dozen tools, so anything past this is a
  // fault, and stopping early only ever hides tools.
  for (let page = 0; page < 50; page += 1) {
    const result = cursor === undefined
      ? await upstream.listTools()
      : await upstream.listTools({ cursor });
    all.push(...result.tools);
    if (result.nextCursor === undefined) break;
    cursor = result.nextCursor;
  }
  return all;
}

const describeError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function createProxyServer(deps: ProxyDeps): Server {
  const now = deps.now ?? (() => new Date());
  const allowed = new Set(deps.rules.allowedTools);
  const report = (d: Decision): Decision => { deps.onDecision?.(d); return d; };

  /**
   * `Date.parse` of a malformed string is `NaN`, and `now >= NaN` is false, so
   * the obvious comparison reads an unreadable expiry as "not expired yet".
   * An expiry nobody can read is expired.
   */
  const expired = (): boolean => {
    const at = Date.parse(deps.rules.expiresAt);
    return Number.isNaN(at) || now().getTime() >= at;
  };

  const server = new Server(
    { name: "mandate-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (expired()) return { tools: [] };
    const upstream = await listAllUpstreamTools(deps.upstream);
    return {
      tools: upstream
        .filter((t) => allowed.has(t.name))
        .map((t) => annotate(t, deps.rules.rules)),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = req.params.name;
    const raw: unknown = req.params.arguments;
    // Arguments come from the agent, which is the untrusted side. Anything that
    // is not a plain object is treated as no arguments rather than coerced.
    const args: Record<string, unknown> =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? { ...raw }
        : {};

    /**
     * Records and returns the denial. `action` is omitted when no rule reached
     * a verdict: an expired mandate and an ungranted tool are both refused
     * before any rule is consulted, and naming the tool there as if it were a
     * catalog operation would put a value in the trace that is not one.
     */
    const refuse = (
      clause: string, reason: string, action?: string,
    ): CallToolResult => {
      const verdict = { kind: "deny" as const, tool, clause, reason };
      report(verdict);
      deps.recorder?.recordDenial({
        tool, args, decision: verdict, ...(action !== undefined ? { action } : {}),
      });
      return denial(tool, clause, reason);
    };

    if (expired()) {
      const cap = deps.rules.cappedBy;
      return refuse("mandate.expiry", cap === undefined
        ? `the mandate expired at ${deps.rules.expiresAt}`
        : `the session ended at ${deps.rules.expiresAt}, ahead of its GitHub credential, which `
          + `expires at ${cap.credentialExpiresAt}; the mandate itself ran until `
          + `${cap.mandateExpiresAt}. A new session mints a new credential.`);
    }

    if (!allowed.has(tool)) {
      return refuse(
        "mandate.grants",
        `${tool} is not granted by mandate ${deps.rules.mandateId}; `
        + `anything not granted is denied`,
      );
    }

    const candidates = rulesForTool(deps.rules, tool);
    if (candidates.length === 0) {
      // allowedTools is derived from rules, so this is a compiler bug. Fail closed.
      return refuse("mandate.internal", `no rule compiled for ${tool}`);
    }

    // Nine catalog tools are reached by more than one operation, and a call is
    // allowed if it satisfies at least one of their rules. Taking only the
    // first would enforce whichever rule happened to compile first.
    // The deciding rule is carried alongside its verdict, because the recorded
    // node names the operation that rule belongs to — and the rule that
    // decided is not necessarily the first candidate.
    // Narrowed first to the grants this call can be: an issue_write create may
    // only be decided by issue.create, or an exhausted max is bypassed by the
    // next grant on the tool. See attribution.ts.
    const attributed = attributeCall(tool, extractArgs(tool, args).method, candidates);
    if (!attributed.ok) return refuse("mandate.grants", attributed.reason);

    let lastDenial: { decision: Decision & { kind: "deny" }; rule: ToolRule } | undefined;
    let permitted: { decision: Decision; rule: ToolRule } | undefined;
    for (const rule of attributed.rules) {
      const d = deps.enforceArguments?.(rule, args) ?? { kind: "allow" as const, tool };
      if (d.kind === "allow") { permitted = { decision: d, rule }; break; }
      lastDenial = { decision: d, rule };
    }

    if (permitted === undefined) {
      return lastDenial === undefined
        ? refuse("mandate.internal", "no rule reached a decision")
        : refuse(lastDenial.decision.clause, lastDenial.decision.reason, lastDenial.rule.action);
    }
    report(permitted.decision);

    const recorded = deps.recorder?.recordCall({
      tool, action: permitted.rule.action, args,
    });
    try {
      const result = await deps.upstream.callTool({ name: tool, arguments: args });
      // `callTool` can return either the modern `{ content }` shape or the
      // protocol-2024-10-07 `{ toolResult }` one, and the legacy payload has to
      // be moved to where the agent looks for it.
      //
      // Testing `result.content` for absence does not detect the legacy shape:
      // `CallToolResultSchema.content` carries a `.default([])`, so a
      // `{ toolResult }` response arrives as `{ content: [], toolResult }` and
      // an `Array.isArray` check is *always* true. Verified against the SDK at
      // 1.32.0. The discriminator is a `toolResult` with nothing in `content`
      // — which also leaves a modern result that legitimately has no text
      // blocks, such as one carrying only `structuredContent`, untouched.
      const content = result["content"];
      const forwarded: CallToolResult =
        result["toolResult"] !== undefined && (!Array.isArray(content) || content.length === 0)
          ? { content: [{ type: "text", text: JSON.stringify(result["toolResult"]) }] }
          : (result as CallToolResult);
      // The trace records what the agent was handed, not the shape that
      // arrived. `outputBytes` then answers how much data actually reached the
      // agent, and one call cannot digest two different ways depending on which
      // upstream shape it came back in. The legacy shape carries no `isError`
      // at all, so an outcome of "ok" there is the whole truth available.
      recorded?.completed(forwarded);
      return forwarded;
    } catch (e) {
      // An upstream failure arrives as a thrown McpError. Letting it propagate
      // turns a GitHub outage into a protocol error the agent cannot read. It
      // is still a call the mandate allowed, and one whose `max` quota is
      // already spent, so it belongs in the trace.
      const detail = describeError(e);
      recorded?.upstreamFailed(detail);
      return upstreamFailure(tool, detail);
    }
  });

  return server;
}
