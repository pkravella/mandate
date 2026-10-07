import { alphabetOf, dfaAccepts, dfaFromGlobs, difference, isSubsetOf, type Containment } from "./dfa.js";
import { type WorkBudget } from "./budget.js";

export interface GlobSetOptions {
  /** Patterns subtracted from the inner (mandate) set, e.g. a grant's denyPaths. */
  readonly innerMinus?: readonly string[];
  /** Patterns subtracted from the outer (ceiling) set. */
  readonly outerMinus?: readonly string[];
  /**
   * A work allowance shared with every other decision in the same
   * `validate()` call. Absent means unmetered, which is what every caller
   * outside the validator wants: the proxy decides one value at a time and the
   * per-automaton `MAX_DFA_STATES` already bounds that.
   */
  readonly budget?: WorkBudget;
}

/**
 * Decides (inner \ innerMinus) ⊆ (outer \ outerMinus).
 *
 * Throws GlobParseError on an undecidable or pathological pattern; callers
 * treat a throw as a mandate rejection.
 */
export function globSetContains(
  outer: readonly string[],
  inner: readonly string[],
  opts: GlobSetOptions = {},
): Containment {
  const innerMinus = opts.innerMinus ?? [];
  const outerMinus = opts.outerMinus ?? [];
  const budget = opts.budget;
  const alphabet = alphabetOf([...outer, ...inner, ...innerMinus, ...outerMinus]);

  const innerDfa =
    innerMinus.length === 0
      ? dfaFromGlobs(inner, alphabet, budget)
      : difference(
        dfaFromGlobs(inner, alphabet, budget),
        dfaFromGlobs(innerMinus, alphabet, budget),
        budget,
      );

  const outerDfa =
    outerMinus.length === 0
      ? dfaFromGlobs(outer, alphabet, budget)
      : difference(
        dfaFromGlobs(outer, alphabet, budget),
        dfaFromGlobs(outerMinus, alphabet, budget),
        budget,
      );

  return isSubsetOf(innerDfa, outerDfa, budget);
}

/**
 * Whether a concrete string is matched by any of `globs`. This is the
 * membership primitive the proxy uses on real tool arguments, and the oracle
 * the containment tests check their counterexamples against.
 */
export function globMatches(
  globs: readonly string[], value: string, budget?: WorkBudget,
): boolean {
  // Only the GLOBS are parsed for their alphabet. `value` is a concrete string,
  // not a pattern, and passing it through alphabetOf meant parseGlob ran over
  // it -- so any real filename containing a glob metacharacter threw
  // GlobParseError from the middle of the proxy's enforcement path.
  // `pages/[id].tsx` is an everyday filename in a Next.js repository.
  //
  // The value's literal characters are added directly below, which is what the
  // alphabet actually needs; routing them through the parser was redundant as
  // well as wrong.
  const withValueChars = new Set(alphabetOf(globs));
  for (const ch of value) withValueChars.add(ch);
  return dfaAccepts(dfaFromGlobs(globs, [...withValueChars], budget), value);
}

export { type Containment } from "./dfa.js";
export { workBudget, charge, WorkBudgetError, DEFAULT_WORK_UNITS, type WorkBudget } from "./budget.js";
