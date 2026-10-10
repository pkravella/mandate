import { callClass } from "./attribution.js";
import { getOperation } from "@mandate-dev/catalog";
import {
  mandateHash, unwrap, type EnforcedBy, type Grant, type ValidatedMandate,
} from "@mandate-dev/schema";

export interface ToolRule {
  readonly tool: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly branches?: readonly string[];
  readonly paths?: readonly string[];
  readonly denyPaths?: readonly string[];
  readonly base?: string;
  readonly max?: number;
}

export interface ProxyRules {
  readonly mandateId: string;
  /**
   * Full sha256 of the canonical mandate.
   *
   * The action graph's header names the exact mandate the proxy enforced, and
   * `mandateId` alone cannot do that: `slug()` truncates the task text, so two
   * tasks opening with the same words share an id.
   */
  readonly mandateHash: string;
  /**
   * When the proxy stops honouring the mandate. The mandate's own expiry,
   * unless its credential runs out first -- see `capToCredential`. Decision D5
   * has two clocks; this is the earlier of them.
   */
  readonly expiresAt: string;
  readonly allowedTools: readonly string[];
  readonly rules: readonly ToolRule[];
  readonly destinations: readonly string[];
  /** Present when the credential, not the mandate, is what ends the session. */
  readonly cappedBy?: ExpiryCap;
}

export interface ExpiryCap {
  /** Where the mandate's own clock would have ended the session. */
  readonly mandateExpiresAt: string;
  /** The installation token's expiry, as GitHub returned it. */
  readonly credentialExpiresAt: string;
}

/**
 * How long before its credential expires the session ends. Long enough for a
 * call that starts just before the end to finish on a token that still works.
 */
export const CREDENTIAL_MARGIN_MS = 60_000;

/**
 * Ends the session before its credential does.
 *
 * Both clocks start in `openSession` -- the token is minted, then the
 * mandate's expiry is stamped -- and `expiresInMinutes` is capped at 60, the
 * token's life, so one token always covers a mandate except at the very end:
 * GitHub dates the token from its own clock, to the second, and the mandate is
 * stamped a moment after the mint. Measured on the live run, a 60-minute
 * mandate outlived its token by 0.9 s, and in that window the proxy would allow
 * a call the upstream could only answer with a 401 -- "the mandate allowed it,
 * but the upstream failed", which points at the wrong thing.
 *
 * This replaced `TokenRefresher`, which no shipped path called. Refreshing
 * means restarting github-mcp-server with a new token mid-session; while a
 * mandate cannot outlive one token, capping is the honest and simpler answer.
 * An expiry nobody can read ends the session at once.
 */
export function capToCredential(
  rules: ProxyRules, credentialExpiresAt: string, marginMs: number = CREDENTIAL_MARGIN_MS,
): ProxyRules {
  const credential = Date.parse(credentialExpiresAt);
  const end = Number.isNaN(credential) ? 0 : credential - marginMs;
  const mandateEnd = Date.parse(rules.expiresAt);
  if (!Number.isNaN(mandateEnd) && mandateEnd <= end) return rules;
  return {
    ...rules,
    expiresAt: new Date(end).toISOString(),
    cappedBy: { mandateExpiresAt: rules.expiresAt, credentialExpiresAt },
  };
}

/** The facets a rule can constrain, beyond the repository. */
const FACETS = ["branches", "paths", "denyPaths", "base", "max"] as const;
type Facet = (typeof FACETS)[number];

/**
 * R7: the rules the proxy enforces, one per (grant, MCP tool) pair.
 *
 * Nine catalog tools are reached by more than one operation, so a tool can
 * carry several rules. **A call is allowed if it satisfies at least one rule
 * for its tool.** That is the only coherent reading — requiring all of them
 * would mean a read call had to satisfy `contents.write`'s rule as well, so
 * adding a grant would narrow the mandate — but it has a consequence worth
 * stating out loud: the *loosest* rule for a tool is the one that decides.
 * `enforcementReport` reports where that makes a limit useless.
 *
 * `expiresAt` here is the mandate's own clock; `openSession` caps it at the
 * credential's with `capToCredential`.
 */
export function compileRules(m: ValidatedMandate, now: Date = new Date()): ProxyRules {
  const mandate = unwrap(m);
  const rules: ToolRule[] = [];

  for (const g of mandate.grants) {
    // getOperation, not requireOperation: a ValidatedMandate has been through
    // validate(), which rejects an unknown action, so this cannot miss. An
    // exception on the path that produces the proxy's rules would be a crash
    // where a decision was expected.
    const op = getOperation(g.action);
    if (op === undefined) continue;
    for (const tool of op.mcpTools) {
      rules.push({
        tool,
        action: g.action,
        resources: g.resources,
        ...(g.branches !== undefined ? { branches: g.branches } : {}),
        ...(g.paths !== undefined ? { paths: g.paths } : {}),
        ...(g.denyPaths !== undefined ? { denyPaths: g.denyPaths } : {}),
        ...(g.base !== undefined ? { base: g.base } : {}),
        ...(g.max !== undefined ? { max: g.max } : {}),
      });
    }
  }

  return {
    mandateId: mandate.mandate,
    mandateHash: mandateHash(mandate),
    expiresAt: new Date(now.getTime() + mandate.expiresInMinutes * 60_000).toISOString(),
    allowedTools: [...new Set(rules.map((r) => r.tool))],
    rules,
    destinations: mandate.destinations.allow,
  };
}

/**
 * Every rule for one tool. A call is allowed if it satisfies at least one of
 * them; an empty result means the tool is not granted at all.
 */
export function rulesForTool(rules: ProxyRules, tool: string): readonly ToolRule[] {
  return rules.rules.filter((r) => r.tool === tool);
}

export interface EnforcementRow {
  readonly action: string;
  readonly enforcedBy: EnforcedBy;
  readonly tokenEnforces: string;
  readonly proxyEnforces: string;
  /**
   * Where this grant's limits are not actually enforced by anything. Empty is
   * the good case; a non-empty list is the honest version of Decision D4.
   */
  readonly gaps: readonly string[];
}

const facetLabel: Readonly<Record<Facet, string>> = {
  branches: "branches",
  paths: "paths",
  denyPaths: "denyPaths",
  base: "base",
  max: "max",
};

/**
 * Decision D4. The GitHub App token can express a repository set and a
 * permission set, and nothing finer. Everything else in a grant is only true
 * while the agent's calls go through the proxy. This report is what the CLI
 * prints and what the audit log stores, so the gap is never implicit.
 */
export function enforcementReport(m: ValidatedMandate): readonly EnforcementRow[] {
  const mandate = unwrap(m);

  // The token is minted once, for the union of every grant's repositories.
  // Claiming per-grant that it bounds *this* grant to *its* repository would be
  // the exact overclaim this report exists to prevent.
  const tokenRepos = [...new Set(mandate.grants.flatMap((g) => [...g.resources]))];

  // Which grants reach each tool, for the shadowing check below.
  const grantsByTool = new Map<string, Grant[]>();
  for (const g of mandate.grants) {
    for (const tool of getOperation(g.action)?.mcpTools ?? []) {
      grantsByTool.set(tool, [...(grantsByTool.get(tool) ?? []), g]);
    }
  }

  return mandate.grants.map((g): EnforcementRow => {
    const op = getOperation(g.action);
    const proxyParts: string[] = [];
    if (g.branches !== undefined) proxyParts.push(`branch in {${g.branches.join(", ")}}`);
    if (g.paths !== undefined) proxyParts.push(`path in {${g.paths.join(", ")}}`);
    if (g.denyPaths !== undefined) proxyParts.push(`path not in {${g.denyPaths.join(", ")}}`);
    if (g.base !== undefined) proxyParts.push(`base == ${g.base}`);
    if (g.max !== undefined) proxyParts.push(`at most ${g.max} call(s)`);

    const tools = op?.mcpTools ?? [];
    const gaps: string[] = [];

    // The proxy sees MCP calls and nothing else. An operation no tool reaches
    // is one it can neither allow nor deny, so the token is the only control --
    // and the token is coarse. branch.delete under contents:write is the sharp
    // case: nothing stops it over the raw API.
    if (tools.length === 0) {
      gaps.push(
        `no MCP tool reaches ${g.action}, so the proxy cannot observe it; only the token `
        + `(${op?.permission ?? "?"}:${op?.permissionLevel ?? "?"}) applies`,
      );
    }

    // A call need only satisfy one rule for its tool, so a grant that leaves a
    // facet unconstrained on a shared tool makes every other grant's limit on
    // that facet useless for that tool.
    for (const facet of FACETS) {
      if (g[facet] === undefined) continue;
      for (const tool of tools) {
        // Only grants that can decide the same calls: an issue_write create is
        // decided by issue.create alone, so issue.update's lack of a limit
        // cannot reach it (attribution.ts).
        const looser = (grantsByTool.get(tool) ?? [])
          .filter((other) => other !== g && other[facet] === undefined)
          .filter((other) => callClass(tool, other.action) === callClass(tool, g.action))
          .map((other) => other.action);
        if (looser.length > 0) {
          gaps.push(
            `${facetLabel[facet]} on ${g.action} is unenforceable for ${tool}: `
            + `${looser.join(", ")} also reach${looser.length === 1 ? "es" : ""} that tool `
            + `with no ${facetLabel[facet]} limit, and a call need only satisfy one rule`,
          );
        }
      }
    }

    return {
      action: g.action,
      enforcedBy: g.enforcedBy,
      tokenEnforces: `repository in {${tokenRepos.join(", ")}} and permission `
        + `${op?.permission ?? "?"}:${op?.permissionLevel ?? "?"}`,
      proxyEnforces: proxyParts.length > 0 ? proxyParts.join("; ") : "nothing beyond the token",
      gaps,
    };
  });
}

/**
 * The seam R12's other backends slot into. **Interface only in v0.1.**
 *
 * R12 is P1: a Docker MCP Gateway interceptor, a Cedar export for AWS
 * AgentCore Policy, OPA, and gh-aw safe-outputs. None is implemented, and this
 * file deliberately ships the shape rather than a stub of each — a half
 * implementation of four backends would be four things that look supported and
 * are not.
 *
 * The constraint that matters is the argument type. A backend compiles a
 * `ValidatedMandate` and nothing else, so a new backend cannot become a second
 * path by which model output reaches an enforcement surface without passing
 * `validate()` first. `ValidatedMandate`'s brand is private to the validator,
 * so that is enforced by the compiler rather than by review.
 *
 * `compileRules` and `compileEgress` are the two v0.1 implementations of this
 * shape, for the MCP proxy and the sandbox's egress allowlist respectively.
 */
export interface Backend<T = unknown> {
  /** A stable identifier for the enforcement surface, e.g. "mcp-proxy". */
  readonly name: string;
  compile(mandate: ValidatedMandate): T;
}
