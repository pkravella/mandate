import { getOperation } from "@mandate-dev/catalog";
import type { CeilingDigest, CeilingRule } from "@mandate-dev/schema";
import {
  CedarError, checkParse, checkParseSchema, isAuthorized, policyJson,
  splitPolicies, validatePolicies, type PatternToken,
} from "./cedar.js";

export class CeilingProfileError extends Error {
  constructor(message: string) {
    super(`ceiling profile violation: ${message}`);
    this.name = "CeilingProfileError";
  }
}

// CeilingRule moved to @mandate-dev/schema: the writer needs the same shape to
// propose anything the ceiling will accept, and passing it as data is what
// keeps the untrusted writer from importing this package. Re-exported here
// because this module is where it was first published.
export type { CeilingRule };

/**
 * A `CeilingDigest` plus what is needed to decide with it. The digest half is
 * safe to hand to the writer; `policiesById` and `cedarSchema` are not, and are
 * the reason `Ceiling` is a superset rather than the same type.
 */
export interface Ceiling extends CeilingDigest {
  /** Policy source keyed by rule id, the form Cedar needs to report our ids. */
  readonly policiesById: Readonly<Record<string, string>>;
  readonly cedarSchema: string;
}

/**
 * Translates a Cedar `like` pattern into the restricted glob language.
 *
 * Cedar's `like` has exactly one metacharacter, `*`, and it matches any
 * sequence INCLUDING `/`. Our glob `*` stops at a separator, so the faithful
 * translation of a Cedar wildcard is `**`. Mapping it to `*` would make the
 * extracted ceiling narrower than the policy an operator wrote, and the Cedar
 * cross-check cannot detect that skew -- a narrower layer 1 still implies
 * Cedar allows every witness, so the disagreement is invisible and the result
 * is silent under-granting.
 *
 * A literal `*` (written `\*` in Cedar) has no representation in a language
 * where `*` is always a wildcard, so it is refused rather than translated into
 * something broader.
 */
function likeToGlob(pattern: readonly PatternToken[], ruleId: string): string {
  let out = "";
  for (const token of pattern) {
    if (token === "Wildcard") {
      out += "**";
      continue;
    }
    const ch = token.Literal;
    if (ch === "*") {
      throw new CeilingProfileError(
        `policy ${ruleId}: a literal "*" in a like pattern cannot be expressed in the glob language`,
      );
    }
    out += ch;
  }
  if (out.length === 0) {
    throw new CeilingProfileError(`policy ${ruleId}: empty like pattern`);
  }
  return out;
}

type Facet = "resources" | "branches" | "paths" | "base";

interface JsonPolicy {
  readonly effect?: string;
  readonly principal?: { readonly op?: string };
  readonly resource?: { readonly op?: string };
  readonly action?: { readonly op?: string; readonly entity?: { readonly id?: string } };
  readonly conditions?: readonly { readonly kind?: string; readonly body?: unknown }[];
  readonly annotations?: Readonly<Record<string, string>>;
}

/** Which `resource`/`context` attribute maps to which mandate facet. */
function facetOf(node: unknown): Facet | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const access = (node as Record<string, unknown>)["."] as
    | { readonly left?: unknown; readonly attr?: string }
    | undefined;
  if (access?.attr === undefined) return undefined;
  const base = access.left as Record<string, unknown> | undefined;
  if (base === undefined || !("Var" in base)) return undefined;
  const v = base["Var"];
  if (v === "resource" && access.attr === "repo") return "resources";
  if (v === "context") {
    if (access.attr === "branch") return "branches";
    if (access.attr === "path") return "paths";
    if (access.attr === "base") return "base";
  }
  return undefined;
}

function literalOf(node: unknown): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const v = (node as Record<string, unknown>)["Value"];
  return typeof v === "string" ? v : undefined;
}

/**
 * Walks a condition expression collecting `like` and `==` comparisons on the
 * four profile attributes. `has` guards carry no pattern and are skipped by
 * the generic recursion. Any comparison on an attribute outside the profile is
 * a profile violation rather than something to ignore: silently dropping a
 * constraint would make the extracted ceiling wider than the real one.
 */
function collect(node: unknown, into: Map<Facet, string[]>, ruleId: string): void {
  if (node === null || typeof node !== "object") return;
  const n = node as Record<string, unknown>;

  for (const op of ["&&", "||"] as const) {
    if (op in n) {
      const pair = n[op] as { readonly left?: unknown; readonly right?: unknown };
      collect(pair.left, into, ruleId);
      collect(pair.right, into, ruleId);
      return;
    }
  }

  if ("like" in n) {
    const like = n["like"] as { readonly left?: unknown; readonly pattern?: readonly PatternToken[] };
    const facet = facetOf(like.left);
    if (facet === undefined) {
      throw new CeilingProfileError(
        `policy ${ruleId}: a like comparison outside resource.repo, context.branch, context.path and context.base`,
      );
    }
    push(into, facet, likeToGlob(like.pattern ?? [], ruleId));
    return;
  }

  if ("==" in n) {
    const eq = n["=="] as { readonly left?: unknown; readonly right?: unknown };
    const facet = facetOf(eq.left);
    const lit = literalOf(eq.right);
    if (facet === undefined || lit === undefined) {
      throw new CeilingProfileError(
        `policy ${ruleId}: an == comparison outside the profile's attributes and string literals`,
      );
    }
    // A literal `*` in an equality would be read as a wildcard by the glob
    // engine, which would widen the ceiling.
    if (lit.includes("*")) {
      throw new CeilingProfileError(`policy ${ruleId}: an == literal may not contain "*"`);
    }
    push(into, facet, lit);
    return;
  }

  if ("has" in n) return; // A presence guard carries no pattern.

  // `!`, arithmetic, set operations and anything else are outside the profile.
  throw new CeilingProfileError(
    `policy ${ruleId}: unsupported expression ${JSON.stringify(Object.keys(n)).slice(0, 80)}`,
  );
}

function push(m: Map<Facet, string[]>, k: Facet, v: string): void {
  const bucket = m.get(k);
  if (bucket) bucket.push(v);
  else m.set(k, [v]);
}

export function loadCeiling(id: string, cedarSource: string, cedarSchema: string): Ceiling {
  try {
    checkParseSchema(cedarSchema);
    checkParse(cedarSource);
  } catch (e) {
    throw new CeilingProfileError(e instanceof CedarError ? e.message : String(e));
  }

  let texts: string[];
  try {
    texts = splitPolicies(cedarSource);
  } catch (e) {
    throw new CeilingProfileError(e instanceof CedarError ? e.message : String(e));
  }

  const rules: CeilingRule[] = [];
  const policiesById: Record<string, string> = {};

  for (const text of texts) {
    let json: JsonPolicy;
    try {
      json = policyJson(text) as JsonPolicy;
    } catch (e) {
      throw new CeilingProfileError(e instanceof CedarError ? e.message : String(e));
    }

    if (json.effect !== "permit") {
      throw new CeilingProfileError(
        "only `permit` policies are allowed; deny-by-default already covers the rest, and a `forbid` would make containment non-monotone",
      );
    }
    const ruleId = json.annotations?.["id"];
    if (ruleId === undefined || ruleId.length === 0) {
      throw new CeilingProfileError(
        "every policy needs an @id annotation, so a rejection or a pause can name the clause it hit",
      );
    }
    if (ruleId in policiesById) {
      throw new CeilingProfileError(`duplicate @id ${JSON.stringify(ruleId)}`);
    }
    if (json.action?.op !== "==" || json.action.entity?.id === undefined) {
      throw new CeilingProfileError(
        `policy ${ruleId}: action must be \`== Mandate::Action::"<id>"\`, not a set or an unconstrained scope`,
      );
    }
    const action = json.action.entity.id;
    if (getOperation(action) === undefined) {
      throw new CeilingProfileError(`policy ${ruleId}: ${action} is not in the operation catalog`);
    }
    if (json.principal?.op !== "All") {
      throw new CeilingProfileError(`policy ${ruleId}: principal must be unconstrained in the scope`);
    }
    if (json.resource?.op !== "All") {
      throw new CeilingProfileError(`policy ${ruleId}: resource must be unconstrained in the scope`);
    }

    const when = new Map<Facet, string[]>();
    const unless = new Map<Facet, string[]>();
    for (const cond of json.conditions ?? []) {
      collect(cond.body, cond.kind === "unless" ? unless : when, ruleId);
    }
    if (unless.has("resources") || unless.has("branches") || unless.has("base")) {
      throw new CeilingProfileError(
        `policy ${ruleId}: an unless clause may only constrain context.path`,
      );
    }

    rules.push({
      id: ruleId,
      action,
      resources: when.get("resources") ?? [],
      branches: when.get("branches") ?? [],
      paths: when.get("paths") ?? [],
      denyPaths: unless.get("paths") ?? [],
      base: when.get("base") ?? [],
    });
    policiesById[ruleId] = text;
  }

  if (rules.length === 0) {
    throw new CeilingProfileError("a ceiling with no permits grants nothing");
  }

  const schemaErrors = validatePolicies(policiesById, cedarSchema);
  if (schemaErrors.length > 0) {
    throw new CeilingProfileError(
      `policies do not validate against the schema: ${schemaErrors.join("; ")}`,
    );
  }

  return { id, rules, policiesById, cedarSchema };
}

export function rulesFor(c: Ceiling, action: string): readonly CeilingRule[] {
  return c.rules.filter((r) => r.action === action);
}

export function cedarAllows(
  c: Ceiling,
  req: {
    readonly action: string;
    readonly repo: string;
    readonly branch?: string;
    readonly path?: string;
    readonly base?: string;
  },
): { readonly allowed: boolean; readonly reason: readonly string[] } {
  const context: Record<string, string> = {};
  if (req.branch !== undefined) context["branch"] = req.branch;
  if (req.path !== undefined) context["path"] = req.path;
  if (req.base !== undefined) context["base"] = req.base;
  return isAuthorized({
    policiesById: c.policiesById,
    schema: c.cedarSchema,
    action: req.action,
    repo: req.repo,
    context,
  });
}
