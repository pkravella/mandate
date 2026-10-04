/**
 * A ceiling, normalized into the restricted glob language and stripped of the
 * Cedar machinery needed to decide with it.
 *
 * This lives in `schema` rather than in the validator because two packages on
 * opposite sides of the trust boundary need the shape. The validator extracts
 * it from Cedar and decides with it. The **writer** needs it to propose
 * anything useful at all: a writer shown the whole 46-operation catalog and
 * none of the ceiling is being asked to guess which operations its
 * organization permits and what branch names it uses, and it guesses wrong.
 * Measured against the live model — it proposed `contents.read`, which the
 * example ceiling has no permit for, on branch `fix/issue-42` where the
 * ceiling requires `agent/**`.
 *
 * Passing it as data keeps the untrusted writer from importing the package
 * that decides. A digest is guidance, never authority: a grant that matches it
 * still has to clear `validate()`.
 */
export interface CeilingRule {
  readonly id: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly branches: readonly string[];
  readonly paths: readonly string[];
  readonly denyPaths: readonly string[];
  readonly base: readonly string[];
}

export interface CeilingDigest {
  readonly id: string;
  readonly rules: readonly CeilingRule[];
}

/** The rules that could permit `action`. A grant must fit exactly one of them. */
export function digestRulesFor(d: CeilingDigest, action: string): readonly CeilingRule[] {
  return d.rules.filter((r) => r.action === action);
}

/** Every action the ceiling permits at all. Anything else is denied outright. */
export function permittedActions(d: CeilingDigest): readonly string[] {
  return [...new Set(d.rules.map((r) => r.action))];
}

/** Whether a facet is unconstrained, which is how an absent Cedar limit extracts. */
export const isUnconstrained = (globs: readonly string[]): boolean =>
  globs.length === 0 || globs.every((g) => g === "**");
