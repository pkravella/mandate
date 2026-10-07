import { readFileSync } from "node:fs";
import {
  GrantSchema, MandateSchema, parseMandateYaml, widenRefusal, widenRequestOf,
  WidenInputSchema,
  type Grant, type Mandate, type ProposedMandate, type WidenRequest,
} from "@mandate-dev/schema";
import { loadCeiling, validate, type UserAuthority } from "@mandate-dev/validator";
import { renderPermissionDiff, renderRejections } from "../diff.js";

/**
 * R10's widen flow.
 *
 * A widen is a proposed delta that goes back through `validate()`, so it is
 * always a **new** mandate proved from scratch rather than a mutation of a live
 * one. That is what makes "the agent can never grant itself anything" true by
 * construction here: `applyWiden` produces a proposal and nothing else, and the
 * only thing that can authorize a proposal is the validator.
 *
 * The guards below are therefore not what keeps the mandate inside the ceiling
 * — the ceiling does that. They keep a widen from being the wrong *kind* of
 * change: one that introduces an operation, relaxes a floor, or quietly
 * replaces a pattern instead of adding to it. Those are things a widen must not
 * express at all, whether or not some ceiling would happen to permit them.
 */

export class WidenRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidenRefused";
  }
}

/** Facets a delta can carry, in the order a grant lists them. */
const DELTA_FACETS = ["resources", "branches", "paths", "base", "max"] as const;

const union = (
  a: readonly string[] | undefined, b: readonly string[] | undefined,
): readonly string[] | undefined =>
  a === undefined && b === undefined ? undefined : [...new Set([...(a ?? []), ...(b ?? [])])];

/**
 * A new mandate with the delta applied. **Not** validated here: the caller must
 * run it through `validate()`, which is the only thing that can authorize it.
 */
export function applyWiden(current: Mandate, request: WidenRequest): Mandate {
  if (request.mandateId !== current.mandate) {
    throw new WidenRefused(
      `this widen request targets a different mandate (${JSON.stringify(request.mandateId)} `
      + `rather than ${JSON.stringify(current.mandate)})`,
    );
  }

  const delta = request.addGrant;
  if (delta.action !== undefined && delta.action !== request.action) {
    throw new WidenRefused(
      `the request's action ${JSON.stringify(request.action)} and its delta's action `
      + `${JSON.stringify(delta.action)} disagree`,
    );
  }
  if (!DELTA_FACETS.some((f) => delta[f] !== undefined)) {
    throw new WidenRefused(
      `this widen request changes nothing: it names no resources, branches, paths, base `
      + `or max. An empty request looks actionable and is not`,
    );
  }

  // The refusal list's `grants` entry, enforced where it is acted on rather
  // than only where it is offered. `pauseRecord` already declines to propose a
  // widen for an ungranted operation; a request that reaches here by hand is
  // the same act and gets the same answer.
  const existing = current.grants.find((g) => g.action === request.action);
  if (existing === undefined) {
    throw new WidenRefused(
      `${request.action} is not granted by ${current.mandate}, and `
      + `${widenRefusal("mandate.grants") ?? "a widen cannot add an operation"}. `
      + `Write a new mandate and validate it instead`,
    );
  }

  const candidate = {
    ...existing,
    resources: union(existing.resources, delta.resources) ?? existing.resources,
    ...(union(existing.branches, delta.branches) !== undefined
      ? { branches: union(existing.branches, delta.branches) }
      : {}),
    ...(union(existing.paths, delta.paths) !== undefined
      ? { paths: union(existing.paths, delta.paths) }
      : {}),
    // `base` is a single value, so there is nothing to union. A delta naming a
    // different base replaces it, and the ceiling decides whether that stands.
    ...(delta.base !== undefined ? { base: delta.base } : {}),
    // Raise, never lower: a widen that reduced a cap would be a narrowing
    // wearing a widen's name, and a reviewer approving "more scope" would be
    // approving less.
    ...(delta.max !== undefined ? { max: Math.max(existing.max ?? 0, delta.max) } : {}),
  };

  // Parsed, and a failure turned into a refusal a human can read. The grant
  // schema rejects a facet the catalog says the operation cannot carry — a
  // hand-written request adding `paths` to `repo.read`, say — and letting the
  // Zod error out would answer R10's "name the reason" with a validation dump.
  const parsed = GrantSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new WidenRefused(
      `the widened ${request.action} grant is not valid: `
      + parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  const widened: Grant = parsed.data;

  // `denyPaths` and `enforcedBy` are carried over from `existing` untouched and
  // cannot appear in a delta at all — WidenDeltaSchema has no field for either.
  return MandateSchema.parse({
    ...current,
    grants: current.grants.map((g) => (g === existing ? widened : g)),
  });
}

export interface WidenArgs {
  readonly mandateFile: string;
  readonly requestFile: string;
  readonly ceiling: string;
  readonly schema: string;
  readonly destinations: string;
  readonly as: string;
  readonly level: UserAuthority["level"];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Returns the process exit code: 0 accepted, 1 refused or rejected, 2 bad input. */
export function runWiden(args: WidenArgs, log: (s: string) => void): number {
  let current: ProposedMandate;
  try {
    current = parseMandateYaml(readFileSync(args.mandateFile, "utf8"));
  } catch (e) {
    log(`Could not read a mandate from ${args.mandateFile}: ${message(e)}`);
    return 2;
  }

  // The request originates from a denial the agent provoked and arrives as a
  // file, which makes it the most attacker-adjacent input here. Parsed against
  // a strict schema rather than cast: an unknown field is a refusal, so a
  // request carrying `expiresInMinutes` fails loudly instead of having it
  // silently dropped.
  let input;
  try {
    input = WidenInputSchema.parse(JSON.parse(readFileSync(args.requestFile, "utf8")));
  } catch (e) {
    log(
      `Could not read a widen request from ${args.requestFile}. It must be either the `
      + `pause record the proxy emitted or a bare widen request.\n  ${message(e)}`,
    );
    return 2;
  }

  const outcome = widenRequestOf(input);
  if (!outcome.ok) {
    log(`Widen refused: ${outcome.refusal}`);
    return 1;
  }
  const request = outcome.request;

  let widened: Mandate;
  try {
    widened = applyWiden(current, request);
  } catch (e) {
    log(`Widen refused: ${message(e)}`);
    return 1;
  }

  let ceiling;
  try {
    ceiling = loadCeiling(
      widened.ceiling,
      readFileSync(args.ceiling, "utf8"),
      readFileSync(args.schema, "utf8"),
      readFileSync(args.destinations, "utf8"),
    );
  } catch (e) {
    log(`Could not load the ceiling: ${message(e)}`);
    return 2;
  }

  // The whole point: the widened mandate is proved from scratch. Nothing about
  // it being a widen rather than a first draft gives it any standing.
  const result = validate(widened, {
    ceiling, authority: { login: args.as, level: args.level },
  });
  if (!result.ok) {
    log("Widen rejected — the request does not fit the ceiling.\n");
    log(renderRejections(result.rejections, widened));
    return 1;
  }

  log(`Widen accepted. Justification: ${request.justification}\n`);
  log(renderPermissionDiff(widened));
  return 0;
}
