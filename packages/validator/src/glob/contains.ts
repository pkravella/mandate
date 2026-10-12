import {
  alphabetOf, dfaAccepts, dfaFromGlobs, difference, isSubsetOf, type Containment, type Dfa,
} from "./dfa.js";
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
 * How many automata the unbudgeted path keeps. The proxy enforces one mandate,
 * so it meets a handful of glob sets (each rule's resources, branches, paths,
 * denyPaths); 64 is far above that, and the bound is what stops a cache keyed
 * on argument-derived input from being a leak.
 */
export const GLOB_CACHE_LIMIT = 64;

/** Most-recently-used last; Map keeps insertion order. */
const cache = new Map<string, Dfa>();

/** The number of automata cached now. For tests. */
export const globCacheSize = (): number => cache.size;

/**
 * Whether a concrete string is matched by any of `globs`. This is the
 * membership primitive the proxy uses on real tool arguments, and the oracle
 * the containment tests check their counterexamples against.
 *
 * The automaton depends on the globs alone. The glob language has no
 * character classes, so a character no glob names behaves exactly as
 * `OTHER`, and `dfaAccepts` maps it there. (It used to add the value's own
 * characters to the alphabet, which made every value build its own automaton:
 * 18 ms a path under a 64-pattern grant, 4.7 s for one call at the proxy's
 * 256-path cap.)
 *
 * Without a budget -- the proxy -- automata are cached by glob set, bounded by
 * GLOB_CACHE_LIMIT. With one -- the validator -- they never are: a cache hit
 * would skip the charge, and whether a mandate validates would then depend on
 * what the process had decided before.
 */
export function globMatches(
  globs: readonly string[], value: string, budget?: WorkBudget,
): boolean {
  if (budget !== undefined) {
    return dfaAccepts(dfaFromGlobs(globs, alphabetOf(globs), budget), value);
  }
  const key = JSON.stringify(globs);
  let dfa = cache.get(key);
  if (dfa === undefined) {
    // A throw (an undecidable pattern) caches nothing.
    dfa = dfaFromGlobs(globs, alphabetOf(globs));
    if (cache.size >= GLOB_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  } else {
    cache.delete(key);
  }
  cache.set(key, dfa);
  return dfaAccepts(dfa, value);
}

export { type Containment } from "./dfa.js";
export { workBudget, charge, WorkBudgetError, DEFAULT_WORK_UNITS, type WorkBudget } from "./budget.js";
