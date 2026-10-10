import { getOperation, highRiskOps, OPERATIONS } from "@mandate-dev/catalog";
import type { GhPermission } from "@mandate-dev/catalog";
import type { Grant, Mandate } from "@mandate-dev/schema";
import type { Rejection } from "@mandate-dev/validator";

export interface DiffOptions {
  readonly color?: boolean;
  /**
   * How many repositories the baseline static token reaches. Decision D7
   * counts authority as (operation, repository) pairs, and the baseline is an
   * installation on every organization repository while a mandate is scoped to
   * one — which is where most of the cut comes from. Omitted means the figure
   * is reported for a single repository and said to be so, rather than a
   * repository count being invented.
   */
  readonly repositories?: number;
}

/**
 * Decision D7's baseline: the permission set the GitHub MCP server's default
 * toolsets require, installed on every organization repository.
 */
export const BASELINE_TOKEN: Readonly<Partial<Record<GhPermission, "read" | "write">>> = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  actions: "read",
  metadata: "read",
};

/** Operations a token holding `held` can reach, since a token lists no operations. */
const reachableWith = (
  held: Readonly<Partial<Record<GhPermission, "read" | "write">>>,
): readonly string[] =>
  OPERATIONS
    .filter((o) => {
      const level = held[o.permission];
      if (level === undefined) return false;
      return level === "write" || o.permissionLevel === "read";
    })
    .map((o) => o.id);

export interface LayerCut {
  /** (operation, repository) pairs reachable at this layer. */
  readonly reachable: number;
  readonly cutPercent: number;
}

export interface AuthorityCut {
  /** (operation, repository) pairs reachable under the baseline static token. */
  readonly baseline: number;
  readonly repositories: number;
  /** Whether `repositories` was given or defaulted to one. */
  readonly repositoriesAssumed: boolean;
  readonly token: LayerCut;
  readonly proxy: LayerCut;
}

/**
 * Decision D4: report the cut **twice**, once per layer, "because a single
 * number here would be marketing, not measurement".
 *
 * The two layers differ because the token cannot express an operation list. It
 * carries a permission set, so every operation sharing one of those permissions
 * at a sufficient level is reachable with it — `issue.comment` comes free with
 * `issues: write`, whether the mandate granted it or not. The proxy layer is
 * the operations the mandate actually granted.
 */
export function authorityCut(m: Mandate, opts: { repositories?: number } = {}): AuthorityCut {
  const repositories = opts.repositories ?? 1;
  const baselineOps = reachableWith(BASELINE_TOKEN).length;
  const baseline = baselineOps * repositories;

  // What the minted token holds: the union of the granted operations' permissions.
  const held: Partial<Record<GhPermission, "read" | "write">> = { metadata: "read" };
  for (const g of m.grants) {
    const op = getOperation(g.action);
    if (op === undefined) continue;
    held[op.permission] = held[op.permission] === "write" || op.permissionLevel === "write"
      ? "write"
      : "read";
  }

  const mandateRepos = new Set(m.grants.flatMap((g) => [...g.resources])).size;
  const tokenReachable = reachableWith(held).length * mandateRepos;
  const proxyReachable = new Set(m.grants.map((g) => g.action)).size * mandateRepos;

  const cut = (reachable: number): LayerCut => ({
    reachable,
    cutPercent: baseline === 0 ? 0 : Math.round(((baseline - reachable) / baseline) * 100),
  });

  return {
    baseline,
    repositories,
    repositoriesAssumed: opts.repositories === undefined,
    token: cut(tokenReachable),
    proxy: cut(proxyReachable),
  };
}

export function derivedNotGrantedNotable(m: Mandate): readonly string[] {
  const granted = new Set(m.grants.map((g) => g.action));
  return highRiskOps().filter((o) => !granted.has(o.id)).map((o) => o.id);
}

const constraintLines = (g: Grant): string[] => {
  const out: string[] = [`      on         ${g.resources.join(", ")}`];
  if (g.branches !== undefined) out.push(`      branches   ${g.branches.join(", ")}`);
  if (g.paths !== undefined) out.push(`      paths      ${g.paths.join(", ")}`);
  if (g.denyPaths !== undefined) out.push(`      never      ${g.denyPaths.join(", ")}`);
  if (g.base !== undefined) out.push(`      base       ${g.base}`);
  // Per session, and the diff is where a reviewer reads it: `max: 1` on a
  // pull request is one per session, not one for the task.
  if (g.max !== undefined) out.push(`      at most    ${g.max} per session`);
  return out;
};

export function renderPermissionDiff(m: Mandate, opts: DiffOptions = {}): string {
  const plain = opts.color === false;
  const green = (s: string): string => (plain ? s : `\u001b[32m${s}\u001b[0m`);
  const red = (s: string): string => (plain ? s : `\u001b[31m${s}\u001b[0m`);
  const dim = (s: string): string => (plain ? s : `\u001b[2m${s}\u001b[0m`);

  const lines: string[] = [];
  // The mandate's own name for its ceiling is a claim; the line naming the
  // ceiling actually checked, with its hash, is printed beside the diff.
  lines.push(`Mandate ${m.mandate}  (claims ceiling ${m.ceiling})`);
  lines.push(`Task: ${m.task}`);
  lines.push(`Requested by ${m.requestedBy}, expires in ${m.expiresInMinutes} minutes`);
  lines.push("");
  lines.push("GRANTED");

  const counts: Record<Grant["enforcedBy"], number> =
    { token: 0, proxy: 0, ruleset: 0, sandbox: 0 };
  for (const g of m.grants) counts[g.enforcedBy] += 1;

  for (const g of m.grants) {
    const op = getOperation(g.action);
    const summary = op?.summary ?? "unknown operation";
    lines.push(green(`  + ${g.action.padEnd(24)} ${dim(`[${g.enforcedBy}]`)} ${summary}`));
    lines.push(...constraintLines(g).map(dim));
  }

  lines.push("");
  lines.push("DATA MAY FLOW TO");
  for (const d of m.destinations.allow) lines.push(green(`  + ${d}`));

  lines.push("");
  lines.push("DENIED");
  lines.push(red("  - Anything not listed is denied."));
  lines.push(dim("    Notable (derived from the catalog, not an authoritative list):"));
  for (const id of derivedNotGrantedNotable(m).slice(0, 8)) lines.push(red(`    - ${id}`));

  lines.push("");
  lines.push("ENFORCED WHERE");
  lines.push(dim(`  token    ${counts.token} grant(s): repository and permission scope only`));
  lines.push(dim(`  proxy    ${counts.proxy} grant(s): branch, path, argument and destination limits`));
  lines.push(dim("  Note: GitHub tokens cannot limit by branch or path, so a grant marked"));
  lines.push(dim("  proxy is bounded only while the agent's calls pass through the MCP proxy."));

  const cut = authorityCut(m, opts.repositories === undefined ? {} : { repositories: opts.repositories });
  lines.push("");
  lines.push("AUTHORITY CUT");
  lines.push(
    `  token layer  ${cut.token.cutPercent}%  `
    + `(${cut.token.reachable} of ${cut.baseline} operation-repository pairs reachable)`,
  );
  lines.push(
    `  proxy layer  ${cut.proxy.cutPercent}%  `
    + `(${cut.proxy.reachable} of ${cut.baseline} operation-repository pairs reachable)`,
  );
  lines.push(dim(
    "  Two numbers, not one: the token carries a permission set rather than an",
  ));
  lines.push(dim(
    "  operation list, so it reaches everything sharing a granted permission.",
  ));
  if (cut.repositoriesAssumed) {
    lines.push(dim(
      "  Baseline counted against one repository, because no organization repository",
    ));
    lines.push(dim(
      "  count was given. A real baseline is installed org-wide and the cut is larger.",
    ));
  }

  return lines.join("\n");
}

export function renderRejections(rs: readonly Rejection[], m?: Mandate): string {
  const lines = ["Mandate rejected.", ""];
  for (const r of rs) {
    const action = r.grantIndex === undefined
      ? undefined
      : m?.grants[r.grantIndex]?.action;
    const where = r.grantIndex === undefined
      ? ""
      : ` in grant #${r.grantIndex}${action === undefined ? "" : ` (${action})`}`;
    lines.push(`  [${r.code}]${where} ${r.message}`);
    if (r.clause !== undefined) lines.push(`      ceiling clause: ${r.clause}`);
    // An omitted constraint yields "" as its counterexample, because `**`
    // matches the empty string and `agent/**` does not. A truthiness check
    // drops the line in exactly the case the reader most needs it, and
    // `it would permit ""` is not a sentence anyone can act on.
    if (r.counterexample !== undefined) {
      lines.push(
        `      counterexample: ${r.counterexample === ""
          ? "any value, including none — the grant leaves this unconstrained"
          : r.counterexample}`,
      );
    }
  }
  lines.push("");
  lines.push("Nothing was minted. Narrow the mandate, or request a ceiling change.");
  return lines.join("\n");
}
