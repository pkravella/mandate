import {
  NOT_WIDENABLE, splitClause, WidenDeltaSchema, type PauseRecord,
} from "@leastpilot/schema";
import type { Decision } from "./proxy.js";

/**
 * The pause record and the widen request are defined in `@leastpilot/schema`,
 * not here. They are the contract between the layer that *offers* a widen and
 * the layer that *applies* one (`leastpilot widen`), and a second copy of either
 * — or of the refusal list — is a copy that can drift. A drift means a denial
 * the proxy deliberately declined to offer a widen for gets widened anyway.
 */
export type { PauseRecord, WidenRequest } from "@leastpilot/schema";
export { widenRefusal } from "@leastpilot/schema";

/**
 * Turns a denial into a reviewable widen request (R10).
 *
 * The delta is derived from the clause that failed, so the reviewer sees the
 * smallest change that would unblock this one call rather than a blanket
 * widening — and for the clauses where widening is the wrong answer, no request
 * is offered at all. Offering "add `.github/workflows/**` to your paths"
 * one click away would make the deny list decorative.
 */
export function pauseRecord(args: {
  readonly mandateId: string;
  readonly mandateHash: string;
  readonly decision: Extract<Decision, { kind: "deny" }>;
  readonly observed: Readonly<Record<string, string>>;
  readonly now?: Date;
}): PauseRecord {
  const { clause, reason, tool } = args.decision;
  const { action, facet } = splitClause(clause);
  const observed = args.observed;

  const base = {
    at: (args.now ?? new Date()).toISOString(),
    mandateId: args.mandateId,
    mandateHash: args.mandateHash,
    tool,
    clause,
    reason,
    observed,
  };

  const blocked = NOT_WIDENABLE[facet];
  if (blocked !== undefined) return base;

  // An observed value is the agent's own argument, and the glob language has
  // no escape: `*` in it would be proposed as a wildcard (`path: "**"` became an
  // offer of every path), and a control character has no place in a pattern a
  // person is asked to read. Such a value is recorded and never offered.
  const offerable = (v: string | undefined): v is string =>
    v !== undefined && v.length > 0 && !v.includes("*") && !/[\p{Cc}\p{Cf}]/u.test(v);

  const addGrant: Record<string, unknown> = {};
  switch (facet) {
    case "resources": {
      const repo = observed["repo"];
      if (offerable(repo)) addGrant["resources"] = [repo];
      break;
    }
    case "branches": {
      const branch = observed["branch"];
      if (offerable(branch)) addGrant["branches"] = [branch];
      break;
    }
    case "paths": {
      const path = observed["path"];
      if (offerable(path)) addGrant["paths"] = [path];
      break;
    }
    case "base": {
      const b = observed["base"];
      if (offerable(b)) addGrant["base"] = b;
      break;
    }
    case "max": {
      const current = Number.parseInt(observed["max"] ?? "0", 10);
      addGrant["max"] = (Number.isFinite(current) ? current : 0) + 1;
      break;
    }
    default: break;
  }

  // Nothing concrete to propose means nothing to review. An empty widen
  // request is worse than none: it looks actionable and is not.
  if (Object.keys(addGrant).length === 0) return base;
  if (action.length > 0) addGrant["action"] = action;

  // Parsed, not cast. The facets come from values the agent supplied, and this
  // runs inside the proxy's request path where nothing may throw — so a delta
  // that does not fit the format means no offer at all rather than an offer the
  // CLI will refuse to read.
  const delta = WidenDeltaSchema.safeParse(addGrant);
  if (!delta.success) return base;

  return {
    ...base,
    widenRequest: {
      mandateId: args.mandateId,
      mandateHash: args.mandateHash,
      action: action.length > 0 ? action : tool,
      addGrant: delta.data,
      justification: `${tool} was denied by ${clause}: ${reason}`,
    },
  };
}

