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
  /**
   * Automata shared by every decision in one `validate()` call. See DfaCache.
   */
  readonly cache?: DfaCache;
}

/**
 * The automata, and whole decisions, one `validate()` call has made.
 *
 * Every grant rebuilt the same deny list and the same ceiling clause: a
 * six-pattern deny list is ~78k units each time, and 19 grants sharing one
 * spent the whole budget (measured). Each automaton is built over its own
 * globs' alphabet (see `step` in dfa.ts), so it can be keyed by its glob list
 * alone and reused by every grant, and one grant's characters never make
 * another's automata wider. (A first version shared one alphabet for the
 * call, and a grant with a 300-character CJK path took 62 ordinary grants
 * past the budget.)
 *
 * Scoped to one call and never shared between calls, so the same mandate
 * costs the same units whatever was validated before.
 */
export interface DfaCache {
  readonly built: Map<string, Dfa>;
  /** Whole decisions: the same four pattern lists decide the same way. */
  readonly decided: Map<string, Containment>;
}

export const dfaCache = (): DfaCache => ({ built: new Map(), decided: new Map() });

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
  const shared = opts.cache;
  const once = (key: string, build: () => Dfa): Dfa => {
    if (shared === undefined) return build();
    const hit = shared.built.get(key);
    if (hit !== undefined) return hit;
    const made = build();
    shared.built.set(key, made);
    return made;
  };
  const globsDfa = (globs: readonly string[]): Dfa =>
    once(`g${JSON.stringify(globs)}`, () => dfaFromGlobs(globs, alphabetOf(globs), budget));
  const minusDfa = (plus: readonly string[], minus: readonly string[]): Dfa =>
    minus.length === 0
      ? globsDfa(plus)
      : once(`d${JSON.stringify([plus, minus])}`, () => difference(globsDfa(plus), globsDfa(minus), budget));

  const decision = `${JSON.stringify([outer, inner, innerMinus, outerMinus])}`;
  const known = shared?.decided.get(decision);
  if (known !== undefined) return known;
  const verdict = isSubsetOf(minusDfa(inner, innerMinus), minusDfa(outer, outerMinus), budget);
  shared?.decided.set(decision, verdict);
  return verdict;
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

/**
 * `globMatches` for the validator's own probes, drawing on a call's cache. The
 * value's characters need not be in the automaton's alphabet: the
 * glob language has no character classes, so a character no glob names
 * behaves exactly as OTHER, which `dfaAccepts` maps it to.
 */
export function memberOf(
  globs: readonly string[], value: string, budget?: WorkBudget, cache?: DfaCache,
): boolean {
  if (cache === undefined) return globMatches(globs, value, budget);
  const key = `g${JSON.stringify(globs)}`;
  let dfa = cache.built.get(key);
  if (dfa === undefined) {
    dfa = dfaFromGlobs(globs, alphabetOf(globs), budget);
    cache.built.set(key, dfa);
  }
  return dfaAccepts(dfa, value);
}

export { type Containment } from "./dfa.js";
export { workBudget, charge, WorkBudgetError, DEFAULT_WORK_UNITS, type WorkBudget } from "./budget.js";
