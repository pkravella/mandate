import type { ToolRule } from "./rules.js";

/**
 * Which of a tool's grants may decide one call.
 *
 * A call is allowed when any rule for its tool allows it, which is right for
 * branch and path facets and was wrong for `max`: once a limited operation's
 * quota ran out, the call was tried under the next grant on the same tool.
 * Measured: `issue.create` with `max: 1` beside a granted `issue.update` let
 * three creates through, each recorded as an update.
 *
 * Where the tool's own arguments say which operation a call is, only that
 * operation's grant may decide it. github-mcp-server v1.14.0's `issue_write`
 * takes `method: "create" | "update"` (read from its source). The other shared
 * tools cannot be told apart from their arguments -- one `issue_write` update
 * can label, assign and close at once; one `update_pull_request` can retitle
 * and close; a pull request comment *is* an issue comment -- so their grants'
 * limits stay a combined allowance, and the docs say so.
 *
 * Lives in the compiler so the proxy, replay and `enforcementReport` read one
 * rule: a replayed decision is the one the proxy took, and the report does not
 * call a limit unenforceable that attribution enforces.
 */
export type Attribution =
  | { readonly ok: true; readonly rules: readonly ToolRule[] }
  | { readonly ok: false; readonly reason: string };

export function attributeCall(
  tool: string, method: string | undefined, candidates: readonly ToolRule[],
): Attribution {
  if (tool !== "issue_write") return { ok: true, rules: candidates };

  if (method === "create") {
    const rules = candidates.filter((r) => r.action === "issue.create");
    return rules.length > 0
      ? { ok: true, rules }
      : { ok: false, reason: "issue_write with method create is issue.create, which the mandate does not grant" };
  }
  if (method === "update") {
    const rules = candidates.filter((r) => r.action !== "issue.create");
    return rules.length > 0
      ? { ok: true, rules }
      : {
        ok: false,
        reason: "issue_write with method update is an issue update (issue.update, issue.close, "
          + "issue.label or issue.assign), and the mandate grants none of them",
      };
  }
  return {
    ok: false,
    reason: `issue_write's method ${method === undefined ? "is missing" : JSON.stringify(method)}; `
      + "only create and update can be matched to a grant",
  };
}

/**
 * Which calls on `tool` a grant of `action` may decide. Two grants can make
 * each other's limits useless only if they can decide the same call.
 */
export function callClass(tool: string, action: string): "create" | "update" | "any" {
  if (tool !== "issue_write") return "any";
  return action === "issue.create" ? "create" : "update";
}
