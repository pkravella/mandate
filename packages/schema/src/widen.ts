import { z } from "zod";
import { GlobString } from "./mandate.js";

/**
 * R10's widen flow, and the contract between the layer that *offers* a widen
 * and the layer that *applies* one.
 *
 * This lives in `schema` for the same reason `destinationWithin` does: the
 * proxy produces a pause record, the CLI consumes it, and neither may own the
 * definition alone. A second copy of the refusal list is a copy that can drift,
 * and a drift here means a denial the proxy deliberately declined to offer a
 * widen for gets widened anyway.
 */

/**
 * Clauses no widen request is ever proposed for, and why.
 *
 * Keyed by the clause's final segment — `splitClause` reads
 * `contents.write.denyPaths` as action `contents.write`, facet `denyPaths`.
 *
 * This is deliberately not "every denial gets a one-click fix". A widen button
 * next to "add `.github/workflows/**` to your paths" makes the deny list
 * decorative, and one next to an ungranted operation makes the grant list
 * decorative. The answer in those cases is a new mandate or a ceiling change,
 * both of which already go through `validate()` in the open.
 */
export const NOT_WIDENABLE: Readonly<Record<string, string>> = {
  denyPaths:
    "a deny path is the mandate's floor; narrowing it needs a ceiling change, not a widen",
  expiry: "the mandate has expired; the answer is a new mandate, not a wider one",
  grants: "the operation is not granted at all; granting it is a new mandate, not a widen",
  internal: "this denial is a Mandate bug, not a scope decision",
  allow: "a destination outside the allow list needs review of where data may go, not a widen",
};

/** Splits `contents.write.branches` into action and facet. */
export const splitClause = (clause: string): { action: string; facet: string } => {
  const at = clause.lastIndexOf(".");
  return at <= 0
    ? { action: "", facet: clause }
    : { action: clause.slice(0, at), facet: clause.slice(at + 1) };
};

/** Why a denial was not offered a widen request, for the reviewer to read. */
export function widenRefusal(clause: string): string | undefined {
  return NOT_WIDENABLE[splitClause(clause).facet];
}

/**
 * The facets a widen may touch.
 *
 * `.strict()` on purpose, and narrower than `Grant`: `enforcedBy` and
 * `denyPaths` are deliberately absent. A widen that could rewrite `denyPaths`
 * could empty it, and one that could rewrite `enforcedBy` could claim a limit
 * is token-enforced when only the proxy enforces it. Neither is a widening of
 * scope, so neither belongs in a widen.
 */
export const WidenDeltaSchema = z.object({
  action: z.string().min(1).optional(),
  resources: z.array(GlobString).min(1).optional(),
  branches: z.array(GlobString).min(1).optional(),
  paths: z.array(GlobString).min(1).optional(),
  base: GlobString.optional(),
  max: z.number().int().positive().max(100).optional(),
}).strict();

export type WidenDelta = z.infer<typeof WidenDeltaSchema>;

/**
 * A reviewable request for more scope.
 *
 * Strict, because this is the most attacker-adjacent input in the system: it
 * originates from a denial the *agent* provoked, and it arrives as a file. An
 * unknown field is a rejection rather than something ignored — a request
 * carrying `expiresInMinutes` should fail loudly, not silently have it dropped.
 */
export const WidenRequestSchema = z.object({
  mandateId: z.string().min(1),
  action: z.string().min(1),
  addGrant: WidenDeltaSchema,
  justification: z.string().min(1),
}).strict();

export type WidenRequest = z.infer<typeof WidenRequestSchema>;

/**
 * What the proxy writes when it pauses a call (R10): the clause it hit, the
 * reason, what it observed, and — only when widening is the right answer — the
 * request a reviewer can act on.
 */
export const PauseRecordSchema = z.object({
  at: z.string().min(1),
  mandateId: z.string().min(1),
  tool: z.string().min(1),
  clause: z.string().min(1),
  reason: z.string().min(1),
  observed: z.record(z.string(), z.string()),
  widenRequest: WidenRequestSchema.optional(),
}).strict();

export type PauseRecord = z.infer<typeof PauseRecordSchema>;

/**
 * What `mandate widen` accepts: the pause record the proxy emitted, or a bare
 * request written by hand.
 *
 * Reading the pause record directly is what closes R10's loop — "offer a
 * one-click widen request" needs the offer to travel without anyone
 * transcribing it, and the clause has to travel with it so the refusal list
 * still applies at the point of use.
 */
export const WidenInputSchema = z.union([PauseRecordSchema, WidenRequestSchema]);

export type WidenInput = z.infer<typeof WidenInputSchema>;

export type WidenRequestOutcome =
  | { readonly ok: true; readonly request: WidenRequest; readonly clause?: string }
  | { readonly ok: false; readonly refusal: string };

/**
 * The request to act on, or the reason there is none.
 *
 * A pause record is checked against the refusal list even when it carries a
 * request, because the list governs the *act* and not merely the suggestion: a
 * record edited to attach a request for a deny-path denial must still be
 * refused.
 */
export function widenRequestOf(input: WidenInput): WidenRequestOutcome {
  if (!("clause" in input)) return { ok: true, request: input };

  const refusal = widenRefusal(input.clause);
  if (refusal !== undefined) return { ok: false, refusal };
  if (input.widenRequest === undefined) {
    return {
      ok: false,
      refusal: `the pause on ${input.clause} carried no widen request, so there is `
        + `nothing to review`,
    };
  }
  return { ok: true, request: input.widenRequest, clause: input.clause };
}
