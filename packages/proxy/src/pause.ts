import type { Grant } from "@mandate-dev/schema";
import type { Decision } from "./proxy.js";

export interface WidenRequest {
  readonly mandateId: string;
  readonly action: string;
  /** The minimal delta that would have let this call through. */
  readonly addGrant: Partial<Grant>;
  readonly justification: string;
}

export interface PauseRecord {
  readonly at: string;
  readonly mandateId: string;
  readonly tool: string;
  readonly clause: string;
  readonly reason: string;
  readonly observed: Readonly<Record<string, string>>;
  /**
   * Absent when no widening could unblock the call. A denial on a deny path, a
   * forbidden operation or the mandate's own expiry is not something a
   * reviewer should be offered a one-click fix for.
   */
  readonly widenRequest?: WidenRequest;
}

/** Clauses no widen request is ever proposed for, and why. */
const NOT_WIDENABLE: Readonly<Record<string, string>> = {
  denyPaths: "a deny path is the mandate's floor; narrowing it needs a ceiling change, not a widen",
  expiry: "the mandate has expired; the answer is a new mandate, not a wider one",
  grants: "the operation is not granted at all; granting it is a new mandate, not a widen",
  internal: "this denial is a Mandate bug, not a scope decision",
  allow: "a destination outside the allow list needs review of where data may go, not a widen",
};

/** Splits `contents.write.branches` into action and facet. */
const splitClause = (clause: string): { action: string; facet: string } => {
  const at = clause.lastIndexOf(".");
  return at <= 0
    ? { action: "", facet: clause }
    : { action: clause.slice(0, at), facet: clause.slice(at + 1) };
};

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
    tool,
    clause,
    reason,
    observed,
  };

  const blocked = NOT_WIDENABLE[facet];
  if (blocked !== undefined) return base;

  const addGrant: Partial<Grant> = {};
  switch (facet) {
    case "resources": {
      const repo = observed["repo"];
      if (repo !== undefined && repo.length > 0) addGrant.resources = [repo];
      break;
    }
    case "branches": {
      const branch = observed["branch"];
      if (branch !== undefined && branch.length > 0) addGrant.branches = [branch];
      break;
    }
    case "paths": {
      const path = observed["path"];
      if (path !== undefined && path.length > 0) addGrant.paths = [path];
      break;
    }
    case "base": {
      const b = observed["base"];
      if (b !== undefined && b.length > 0) addGrant.base = b;
      break;
    }
    case "max": {
      const current = Number.parseInt(observed["max"] ?? "0", 10);
      addGrant.max = (Number.isFinite(current) ? current : 0) + 1;
      break;
    }
    default: break;
  }

  // Nothing concrete to propose means nothing to review. An empty widen
  // request is worse than none: it looks actionable and is not.
  if (Object.keys(addGrant).length === 0) return base;
  if (action.length > 0) addGrant.action = action;

  return {
    ...base,
    widenRequest: {
      mandateId: args.mandateId,
      action: action.length > 0 ? action : tool,
      addGrant,
      justification: `${tool} was denied by ${clause}: ${reason}`,
    },
  };
}

/** Why a denial was not offered a widen request, for the reviewer to read. */
export function widenRefusal(clause: string): string | undefined {
  return NOT_WIDENABLE[splitClause(clause).facet];
}
