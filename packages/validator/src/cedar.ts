// The CommonJS subpath loads the wasm synchronously under Node without a
// bundler; the default ESM entry expects a bundler or a dynamic import.
//
// Node's cjs-module-lexer hoists this module's named exports, so the namespace
// import carries the functions directly and no `.default` interop shim is
// needed -- verified at runtime, and the shim's cast is in fact a TS2352 error
// because the types correctly say the namespace has no `default` of that type.
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";

/** One element of a Cedar `like` pattern, as `policyToJson` emits it. */
export type PatternToken = { readonly Literal: string } | "Wildcard";

export interface CedarDecision {
  readonly allowed: boolean;
  /** Rule ids that produced the decision, from Cedar's `diagnostics.reason`. */
  readonly reason: readonly string[];
}

export class CedarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CedarError";
  }
}

const messages = (errors: readonly { readonly message: string }[]): string =>
  errors.map((e) => e.message).join("; ");

export function checkParse(policies: string): void {
  const answer = cedar.checkParsePolicySet({ staticPolicies: policies });
  if (answer.type === "failure") throw new CedarError(`policies do not parse: ${messages(answer.errors)}`);
}

export function checkParseSchema(schema: string): void {
  const answer = cedar.checkParseSchema(schema);
  if (answer.type === "failure") throw new CedarError(`schema does not parse: ${messages(answer.errors)}`);
}

/**
 * Splits a policy set into individual policy texts.
 *
 * Returns an ARRAY of policy source strings (plus a separate templates list),
 * not a map keyed by id. Cedar does not use `@id` annotations as policy
 * identity at this stage.
 */
export function splitPolicies(policies: string): string[] {
  const answer = cedar.policySetTextToParts(policies);
  if (answer.type === "failure") throw new CedarError(`cannot split policies: ${messages(answer.errors)}`);
  return [...answer.policies];
}

/** The policy's estree-style AST. The payload is on `json`, not `policy`. */
export function policyJson(policy: string): unknown {
  const answer = cedar.policyToJson(policy);
  if (answer.type === "failure") throw new CedarError(`cannot convert policy: ${messages(answer.errors)}`);
  return answer.json;
}

export function validatePolicies(
  policiesById: Readonly<Record<string, string>>,
  schema: string,
): string[] {
  const answer = cedar.validate({ policies: { staticPolicies: policiesById }, schema });
  if (answer.type === "failure") return answer.errors.map((e) => e.message);
  return answer.validationErrors.map((e) => JSON.stringify(e.error?.message ?? e));
}

/**
 * Deny by default: any failure, and any decision other than an explicit allow,
 * is a deny.
 *
 * `staticPolicies` is passed as a record keyed by our own rule ids. With a
 * single text blob Cedar generates its own ids (`policy1`, `policy2`, ...) and
 * `diagnostics.reason` would name those instead, so a pause could not report
 * the clause an operator actually wrote.
 */
export function isAuthorized(args: {
  readonly policiesById: Readonly<Record<string, string>>;
  readonly schema: string;
  readonly action: string;
  readonly repo: string;
  readonly context: Readonly<Record<string, string>>;
}): CedarDecision {
  const answer = cedar.isAuthorized({
    principal: { type: "Mandate::User", id: "requester" },
    action: { type: "Mandate::Action", id: args.action },
    resource: { type: "Mandate::Repo", id: args.repo },
    context: args.context,
    policies: { staticPolicies: args.policiesById },
    entities: [
      { uid: { type: "Mandate::User", id: "requester" }, attrs: {}, parents: [] },
      { uid: { type: "Mandate::Repo", id: args.repo }, attrs: { repo: args.repo }, parents: [] },
    ],
    schema: args.schema,
    // Without this, a typo in an action id is a silent `deny` indistinguishable
    // from a policy-driven one. With it, the request is checked against the
    // schema and the mismatch surfaces as a failure.
    validateRequest: true,
  });

  if (answer.type === "failure") return { allowed: false, reason: [] };
  return {
    allowed: answer.response.decision === "allow",
    reason: [...answer.response.diagnostics.reason],
  };
}
