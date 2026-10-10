import { atLeast, requireOperation, UnknownOperationError } from "@mandate-dev/catalog";
import {
  destinationsWithin, markValidated,
  type ContainmentProof, type Grant, type GrantProof,
  type ProposedMandate, type ValidatedMandate,
} from "@mandate-dev/schema";
import { globMatches, globSetContains } from "./glob/contains.js";
import { charge, workBudget, type WorkBudget } from "./glob/budget.js";
import { GlobParseError } from "./glob/parse.js";
import { cedarAllows, rulesFor, type Ceiling, type CeilingRule } from "./ceiling.js";
import { runLints } from "./lints.js";
import type { UserAuthority } from "./userAuthority.js";

export type RejectionCode =
  | "unknown-operation"
  | "no-ceiling-rule"
  | "not-contained"
  | "user-authority"
  | "layer-disagreement"
  | "undecidable"
  | "destination-not-permitted"
  | "requester-mismatch"
  | "requester-unsupported"
  | "lint";

export interface Rejection {
  readonly code: RejectionCode;
  readonly grantIndex?: number;
  readonly message: string;
  /** The ceiling clause's @id, when one is implicated. */
  readonly clause?: string;
  readonly counterexample?: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly mandate: ValidatedMandate }
  | { readonly ok: false; readonly rejections: readonly Rejection[] };

/** An absent constraint means unconstrained, which in glob terms is `**`. */
const UNCONSTRAINED: readonly string[] = ["**"];

export function validate(
  proposed: ProposedMandate,
  ctx: {
    readonly ceiling: Ceiling;
    readonly authority: UserAuthority;
    /**
     * The work allowance for this call. Supplied only by tests, which need to
     * read what a mandate actually spent in order to calibrate the default and
     * to assert that a legitimate mandate keeps its headroom. Production
     * callers omit it and get `workBudget()`.
     */
     readonly budget?: WorkBudget;
  },
): ValidationResult {
  const rejections: Rejection[] = [];
  const grantProofs: GrantProof[] = [];
  // One allowance for the whole mandate. Every containment decision and every
  // Cedar witness draws on it, so a mandate cannot buy unbounded work by
  // spreading it across grants that each stay under the per-automaton cap.
  const budget = ctx.budget ?? workBudget();

  // ---- check 0: the requester is the identity whose authority is checked --
  // `requestedBy` used to be a label nothing compared with `ctx.authority`, so
  // a mandate could name anyone -- `user:bob`, `app:admin` -- while alice's
  // level bounded every grant, and the permission diff printed the label.
  // That never over-granted; it put the wrong name on the record.
  const requesterRefusal = checkRequester(proposed.requestedBy, ctx.authority);
  if (requesterRefusal !== undefined) rejections.push(requesterRefusal);

  for (const [i, grant] of proposed.grants.entries()) {
    // ---- check 1: the requester's own authority on the repository --------
    // Separate from containment, and separately reported: conflating the two
    // produces the unexplainable stops R10 exists to prevent.
    let op;
    try {
      op = requireOperation(grant.action);
    } catch (e) {
      rejections.push({
        code: "unknown-operation",
        grantIndex: i,
        message: e instanceof UnknownOperationError ? e.message : String(e),
      });
      continue;
    }
    if (!atLeast(ctx.authority.level, op.minUserLevel)) {
      rejections.push({
        code: "user-authority",
        grantIndex: i,
        message: `${ctx.authority.login} has ${ctx.authority.level} on this repository, but ${grant.action} requires ${op.minUserLevel}`,
      });
    }

    // ---- check 2: containment in the organization ceiling ----------------
    const candidates = rulesFor(ctx.ceiling, grant.action);
    if (candidates.length === 0) {
      rejections.push({
        code: "no-ceiling-rule",
        grantIndex: i,
        message: `the ceiling has no permit for ${grant.action}; anything not granted is denied`,
      });
      continue;
    }

    const outcome = containedByAny(grant, candidates, budget);
    if (outcome.kind === "undecidable") {
      rejections.push({ code: "undecidable", grantIndex: i, message: outcome.message });
      continue;
    }
    if (outcome.kind === "rejected") {
      rejections.push({
        code: "not-contained",
        grantIndex: i,
        clause: outcome.closestClause,
        counterexample: outcome.counterexample,
        message:
          `grant ${grant.action} is wider than ceiling clause ${outcome.closestClause}: ` +
          `it would permit ${JSON.stringify(outcome.counterexample)}`,
      });
      continue;
    }

    // ---- layer 2: the independent Cedar cross-check ----------------------
    let cross: CrossCheck;
    try {
      cross = crossCheck(ctx.ceiling, grant, outcome.rule, budget);
    } catch (e) {
      if (e instanceof GlobParseError) {
        rejections.push({ code: "undecidable", grantIndex: i, message: e.message });
        continue;
      }
      throw e;
    }
    if (!cross.agrees) {
      rejections.push({
        code: "layer-disagreement",
        grantIndex: i,
        clause: outcome.rule.id,
        counterexample: cross.witness,
        message:
          `containment proved ${grant.action} is inside ${outcome.rule.id}, but Cedar denies ` +
          `${cross.witness}; failing closed because the two representations disagree`,
      });
      continue;
    }

    grantProofs.push({
      grantIndex: i,
      action: grant.action,
      // What Cedar actually permitted, which may include a clause other than
      // the one layer 1 matched when ceiling rules overlap.
      permittedBy: cross.permittedBy,
      resourcesContained: true,
      pathsContained: true,
      branchesContained: true,
    });
  }

  // ---- check 3: where data may go (R9) --------------------------------
  // Separate from the grant loop and separately reported, because this is a
  // property of the mandate rather than of any one grant. Until this existed
  // the writer's destination list was passed through unchanged and compared to
  // nothing: the only guard was a lint catching a literal `*`, so a mandate
  // could name any host and the sandbox would build an egress allowlist for it.
  //
  // One predicate decides this and the proxy's runtime check, so the layers
  // cannot drift: containment of a destination reduces to membership of its
  // own string, because a destination denotes itself plus everything beneath it.
  const dests = destinationsWithin(
    proposed.destinations.allow, ctx.ceiling.destinations,
  );
  if (!dests.ok) {
    rejections.push({
      code: "destination-not-permitted",
      clause: `${ctx.ceiling.id}.destinations`,
      counterexample: dests.counterexample,
      message: ctx.ceiling.destinations.length === 0
        ? `the ceiling permits no destinations at all, so ${JSON.stringify(dests.counterexample)} `
          + `cannot be granted`
        : `destination ${JSON.stringify(dests.counterexample)} is outside the ceiling's `
          + `allowed destinations (${ctx.ceiling.destinations.join(", ")})`,
    });
  }

  // R4's lints run last: they catch a mandate that is technically inside a
  // loose ceiling but obviously wrong. A lint error is a rejection, not a
  // warning -- the point of the ceiling is that it may be loose and still safe.
  for (const finding of runLints(proposed, budget)) {
    if (finding.severity !== "error") continue;
    rejections.push({
      code: "lint",
      ...(finding.grantIndex !== undefined ? { grantIndex: finding.grantIndex } : {}),
      message: `${finding.rule}: ${finding.message}`,
    });
  }

  if (rejections.length > 0) return { ok: false, rejections };

  const proof: ContainmentProof = {
    ceilingId: ctx.ceiling.id,
    ceilingSha256: ctx.ceiling.sha256,
    userLevel: ctx.authority.level,
    checkedAt: new Date().toISOString(),
    grantProofs,
  };
  return { ok: true, mandate: markValidated(proposed, proof) };
}

type Outcome =
  | { readonly kind: "ok"; readonly rule: CeilingRule }
  | { readonly kind: "rejected"; readonly closestClause: string; readonly counterexample: string }
  | { readonly kind: "undecidable"; readonly message: string };

interface FacetCheck {
  readonly name: string;
  readonly outer: readonly string[];
  readonly inner: readonly string[];
  readonly innerMinus?: readonly string[];
  readonly outerMinus?: readonly string[];
}

/**
 * Builds the facets to compare for one grant against one ceiling rule.
 *
 * Every facet the RULE constrains is compared, whether or not the grant
 * mentions it. A grant silent about branches is UNCONSTRAINED on branches,
 * which is strictly wider than a ceiling that limits them -- skipping the
 * comparison because "the grant has no branches to check" would let a mandate
 * granting contents.write with no branch limit validate against a ceiling that
 * only permits `agent/*`. Same for paths and base.
 */
function facetsFor(grant: Grant, rule: CeilingRule): FacetCheck[] {
  const facets: FacetCheck[] = [
    {
      name: "resources",
      outer: rule.resources.length > 0 ? rule.resources : UNCONSTRAINED,
      inner: grant.resources,
    },
  ];

  if (rule.branches.length > 0 || grant.branches !== undefined) {
    facets.push({
      name: "branches",
      outer: rule.branches.length > 0 ? rule.branches : UNCONSTRAINED,
      inner: grant.branches ?? UNCONSTRAINED,
    });
  }

  if (rule.paths.length > 0 || rule.denyPaths.length > 0 || grant.paths !== undefined) {
    facets.push({
      name: "paths",
      outer: rule.paths.length > 0 ? rule.paths : UNCONSTRAINED,
      inner: grant.paths ?? UNCONSTRAINED,
      innerMinus: grant.denyPaths ?? [],
      outerMinus: rule.denyPaths,
    });
  }

  if (rule.base.length > 0 || grant.base !== undefined) {
    facets.push({
      name: "base",
      outer: rule.base.length > 0 ? rule.base : UNCONSTRAINED,
      inner: grant.base !== undefined ? [grant.base] : UNCONSTRAINED,
    });
  }

  return facets;
}

/** A grant is contained if ANY single ceiling clause contains all of its facets. */
function containedByAny(
  grant: Grant, rules: readonly CeilingRule[], budget?: WorkBudget,
): Outcome {
  let best: { readonly clause: string; readonly counterexample: string } | undefined;

  for (const rule of rules) {
    let failure: { readonly counterexample: string } | undefined;
    try {
      for (const facet of facetsFor(grant, rule)) {
        const verdict = globSetContains(facet.outer, facet.inner, {
          ...(facet.innerMinus !== undefined ? { innerMinus: facet.innerMinus } : {}),
          ...(facet.outerMinus !== undefined ? { outerMinus: facet.outerMinus } : {}),
          ...(budget !== undefined ? { budget } : {}),
        });
        if (!verdict.ok) {
          failure = { counterexample: verdict.counterexample };
          break;
        }
      }
    } catch (e) {
      if (e instanceof GlobParseError) return { kind: "undecidable", message: e.message };
      throw e;
    }
    if (failure === undefined) return { kind: "ok", rule };
    best ??= { clause: rule.id, counterexample: failure.counterexample };
  }

  return {
    kind: "rejected",
    closestClause: best?.clause ?? rules[0]!.id,
    counterexample: best?.counterexample ?? "",
  };
}

type CrossCheck =
  | { readonly agrees: true; readonly permittedBy: readonly string[] }
  | { readonly agrees: false; readonly witness: string };

/**
 * Replays concrete witnesses derived from the grant through Cedar.
 *
 * This is not a second proof of containment -- a finite witness set cannot be
 * one. It is a consistency check between two representations: if the patterns
 * extracted from Cedar in loadCeiling have drifted from what Cedar itself
 * computes, a witness exposes it and the mandate is rejected.
 *
 * Only a Cedar DENY counts as disagreement. Cedar permitting a witness through
 * a clause other than the one layer 1 matched is benign overlap, not drift, so
 * the actual reasons are recorded in the proof rather than treated as a
 * failure. The direction this catches is extraction that is too WIDE, which is
 * the direction that over-grants.
 */
function crossCheck(
  ceiling: Ceiling, grant: Grant, rule: CeilingRule, budget?: WorkBudget,
): CrossCheck {
  const repos = witnesses(grant.resources, [], budget);
  const branches = grant.branches !== undefined
    ? witnesses(grant.branches, [], budget) : [undefined];
  const paths = grant.paths !== undefined
    ? witnesses(grant.paths, grant.denyPaths, budget) : [undefined];
  const permitted = new Set<string>();

  for (const repo of repos) {
    for (const branch of branches) {
      for (const path of paths) {
        // A Cedar authorisation costs a unit too. The witness set is the product
        // of three facets, so a mandate with many patterns in each can cost far
        // more here than in the automata -- and this loop is where the 698 KB
        // mandate actually spent its five minutes.
        charge(budget, 1);
        const decision = cedarAllows(ceiling, {
          action: grant.action,
          repo,
          ...(branch !== undefined ? { branch } : {}),
          ...(path !== undefined ? { path } : {}),
          ...(grant.base !== undefined ? { base: grant.base } : {}),
        });
        if (!decision.allowed) {
          return { agrees: false, witness: JSON.stringify({ repo, branch, path, base: grant.base }) };
        }
        for (const r of decision.reason) permitted.add(r);
      }
    }
  }

  return {
    agrees: true,
    permittedBy: permitted.size > 0 ? [...permitted] : [rule.id],
  };
}

/**
 * Concrete strings a pattern set admits, used as cross-check probes.
 *
 * Each candidate is verified against its own pattern with `globMatches` before
 * being used: a candidate that does not actually match would make Cedar deny
 * it for the right reason and be misreported as layer disagreement.
 */
function witnesses(
  patterns: readonly string[], minus: readonly string[] = [], budget?: WorkBudget,
): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const candidate = p.replaceAll("**/", "w/").replaceAll("**", "w/w").replaceAll("*", "w");
    if (!globMatches([p], candidate, budget)) continue;
    if (minus.length > 0 && globMatches(minus, candidate, budget)) continue;
    out.push(candidate);
  }
  return out.length > 0 ? out : ["w"];
}

/**
 * Whether `requestedBy` names the identity `authority` describes.
 *
 * `app:` principals are refused outright for now. Their authority has no
 * source: GitHub answers what a user may do on a repository, but what another
 * App may do is readable only with that App's own credentials, and Mandate's
 * App bounds every token it mints already. Refusing is the honest answer until
 * something that requests as an app exists to design against.
 */
function checkRequester(requestedBy: string, authority: UserAuthority): Rejection | undefined {
  const colon = requestedBy.indexOf(":");
  const kind = requestedBy.slice(0, colon);
  const id = requestedBy.slice(colon + 1);
  if (kind === "app") {
    return {
      code: "requester-unsupported",
      message: `requestedBy ${requestedBy} is an app principal, and Mandate has no source for an `
        + "app's authority yet; it is refused rather than bounded by whichever person ran the "
        + `check. Request it as the user whose authority applies (user:${authority.login}).`,
    };
  }
  // GitHub logins are case-insensitive.
  if (id.toLowerCase() !== authority.login.toLowerCase()) {
    return {
      code: "requester-mismatch",
      message: `requestedBy ${requestedBy}, but the authority checked was ${authority.login}'s; `
        + "the mandate would be recorded as someone else's request. Set requestedBy to "
        + `user:${authority.login}, or check it as the requester.`,
    };
  }
  return undefined;
}
