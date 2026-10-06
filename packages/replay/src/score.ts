import { operationsForMcpTool } from "@mandate-dev/catalog";
import { unwrap, type ValidatedMandate } from "@mandate-dev/schema";
import { compileRules, rulesForTool, type ProxyRules } from "@mandate-dev/compiler";
import {
  makeFacetEnforcer, type ActionGraph, type ActionNode, type ArgExtract,
} from "@mandate-dev/proxy";

/**
 * R11: score a mandate by replaying a recorded trace against it.
 *
 * Decision D8's point is that over- and under-grant are only meaningful against
 * a trace of what a task actually needed, which is why the ground truth comes
 * from runs with **no enforcement**. A mandate is then scored by asking, call by
 * call, what the proxy would have decided.
 *
 * The decision is taken by the production enforcer, not by a reimplementation,
 * because a score is only worth having if it is the same decision the proxy
 * would have made. And it is fed the node's recorded facets directly rather
 * than arguments rebuilt from them: a recorded node already *is* an
 * `ArgExtract`, and rebuilding is lossy in ways that were measured — a root
 * path of `""` becomes no path, and a destination becomes a field the extractor
 * does not recognise. Either loss makes the replay check fewer facets than the
 * run did, in the direction that hides under-granting.
 */

export interface UnderGrant {
  readonly seq: number;
  readonly tool: string;
  readonly clause: string;
  readonly reason: string;
}

export interface Score {
  /** Distinct operations the mandate granted. */
  readonly granted: number;
  /** Distinct granted operations the trace actually exercised. */
  readonly exercised: number;
  /**
   * `(granted - exercised) / granted` — the PRD's over-grant metric.
   *
   * Per-operation, deliberately **not** per `(operation, repository)` pair the
   * way the authority cut is. The PRD defines over-grant as "the share of
   * granted operations that replay shows the task never needed", and the two
   * denominators are not comparable; a report must not present them as if they
   * were.
   */
  readonly overGrantRate: number;
  /** Granted operations no call in the trace exercised. */
  readonly unusedActions: readonly string[];
  readonly underGrants: readonly UnderGrant[];
  /** `underGrants / consideredCalls`. */
  readonly underGrantRate: number;
  /** Calls the replay actually decided on, excluding ones the trace itself denied. */
  readonly consideredCalls: number;
  /**
   * Operations the trace needed that the mandate does not grant at all.
   *
   * The actionable output: a writer that forgot an operation should be told
   * which one rather than only that some call was blocked. Derived from the
   * catalog, so a tool reached by several operations contributes all of them.
   */
  readonly missingActions: readonly string[];
}

/** A recorded node, read as what it already is: the extractor's output. */
const extractOf = (node: ActionNode): ArgExtract => ({
  ...(node.resource !== undefined ? { repo: node.resource } : {}),
  ...(node.branch !== undefined ? { branch: node.branch } : {}),
  paths: node.paths,
  ...(node.base !== undefined ? { base: node.base } : {}),
  destinations: node.destinations,
});

export function scoreMandate(m: ValidatedMandate, trace: ActionGraph): Score {
  const mandate = unwrap(m);
  const rules: ProxyRules = compileRules(m);
  const enforce = makeFacetEnforcer(rules);
  const allowedTools = new Set(rules.allowedTools);

  const grantedActions = new Set(mandate.grants.map((g) => g.action));
  const exercisedActions = new Set<string>();
  const missing = new Set<string>();
  const underGrants: UnderGrant[] = [];
  let considered = 0;

  for (const node of trace.nodes) {
    // A denial in the ground-truth trace is evidence about whatever mandate
    // produced it, not about this one.
    if (node.decision === "deny") continue;
    considered += 1;

    if (!allowedTools.has(node.tool)) {
      underGrants.push({
        seq: node.seq,
        tool: node.tool,
        clause: "mandate.grants",
        reason: `${node.tool} is not reachable from any operation this mandate grants`,
      });
      for (const op of operationsForMcpTool(node.tool)) missing.add(op.id);
      continue;
    }

    // Every rule for the tool, because a call is allowed if it satisfies at
    // least one. Taking the first would reimplement the bug the proxy fixed and
    // report under-grants the proxy would never have produced.
    const candidates = rulesForTool(rules, node.tool);
    const extract = extractOf(node);
    let allowedBy: string | undefined;
    let lastDenial: UnderGrant | undefined;

    for (const rule of candidates) {
      const verdict = enforce(rule, extract);
      if (verdict.kind === "allow") { allowedBy = rule.action; break; }
      lastDenial = {
        seq: node.seq, tool: node.tool,
        clause: verdict.clause, reason: verdict.reason,
      };
    }

    if (allowedBy !== undefined) {
      exercisedActions.add(allowedBy);
      continue;
    }

    // Credited as exercised even though it was refused. A call blocked on a
    // branch or a path is evidence the task *needed* that operation and the
    // facet was wrong — it is an under-grant, not proof the operation was
    // unnecessary. Crediting only the allow path makes one mistake count twice,
    // as an under-grant and as an over-grant, and a single mistyped branch
    // would report a mandate as having over-granted everything it holds.
    //
    // Attribution is precise where it can be: the allowing rule's own action
    // above, and every candidate here, because a trace cannot tell which of two
    // operations sharing a tool the call meant.
    for (const rule of candidates) exercisedActions.add(rule.action);

    underGrants.push(lastDenial ?? {
      seq: node.seq, tool: node.tool, clause: "mandate.internal",
      reason: "no rule reached a decision",
    });
  }

  const granted = grantedActions.size;
  const exercised = exercisedActions.size;

  return {
    granted,
    exercised,
    overGrantRate: granted === 0 ? 0 : (granted - exercised) / granted,
    unusedActions: [...grantedActions].filter((a) => !exercisedActions.has(a)).sort(),
    underGrants,
    underGrantRate: considered === 0 ? 0 : underGrants.length / considered,
    consideredCalls: considered,
    missingActions: [...missing].sort(),
  };
}
