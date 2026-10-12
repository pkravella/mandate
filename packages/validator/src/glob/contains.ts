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
 * The automata one `validate()` call has built, over one alphabet for the
 * whole call.
 *
 * Every grant was decided over an alphabet of its own patterns, so the same
 * deny list and the same ceiling clause were rebuilt for every grant: a
 * six-pattern deny list is ~78k units each time, and 19 grants sharing one
 * spent the whole budget (measured). One alphabet makes them the same
 * automaton, built and charged once.
 *
 * Scoped to one call and never shared between calls, so the same mandate
 * costs the same units whatever was validated before; a cache that outlived
 * the call would make a verdict depend on history.
 */
export interface DfaCache {
  readonly alphabet: readonly string[];
  readonly built: Map<string, Dfa>;
  /** Whole decisions: the same four pattern lists decide the same way. */
  readonly decided: Map<string, Containment>;
}

/** A cache whose alphabet covers every pattern the call will decide. */
export const dfaCache = (patterns: readonly string[]): DfaCache =>
  ({ alphabet: alphabetOf(patterns), built: new Map(), decided: new Map() });

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
  const own = alphabetOf([...outer, ...inner, ...innerMinus, ...outerMinus]);

  // The cache is used only when its alphabet covers this decision's
  // characters. A pattern it was not seeded with is decided as before.
  const shared = opts.cache !== undefined && own.every((ch) => opts.cache?.alphabet.includes(ch))
    ? opts.cache
    : undefined;
  const alphabet = shared?.alphabet ?? own;
  const once = (key: string, build: () => Dfa): Dfa => {
    if (shared === undefined) return build();
    const hit = shared.built.get(key);
    if (hit !== undefined) return hit;
    const made = build();
    shared.built.set(key, made);
    return made;
  };
  const globsDfa = (globs: readonly string[]): Dfa =>
    once(`g${JSON.stringify(globs)}`, () => dfaFromGlobs(globs, alphabet, budget));
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

/**
 * `globMatches` for the validator's own probes, drawing on a call's cache when
 * its alphabet covers `globs`. The value's characters need not be in it: the
 * glob language has no character classes, so a character no glob names
 * behaves exactly as OTHER, which `dfaAccepts` maps it to.
 */
export function memberOf(
  globs: readonly string[], value: string, budget?: WorkBudget, cache?: DfaCache,
): boolean {
  if (cache === undefined || !alphabetOf(globs).every((ch) => cache.alphabet.includes(ch))) {
    return globMatches(globs, value, budget);
  }
  const key = `g${JSON.stringify(globs)}`;
  let dfa = cache.built.get(key);
  if (dfa === undefined) {
    dfa = dfaFromGlobs(globs, cache.alphabet, budget);
    cache.built.set(key, dfa);
  }
  return dfaAccepts(dfa, value);
}

export { type Containment } from "./dfa.js";
export { workBudget, charge, WorkBudgetError, DEFAULT_WORK_UNITS, type WorkBudget } from "./budget.js";
