import { alphabetOf, dfaAccepts, dfaFromGlobs, difference, isSubsetOf, type Containment } from "./dfa.js";

export interface GlobSetOptions {
  /** Patterns subtracted from the inner (mandate) set, e.g. a grant's denyPaths. */
  readonly innerMinus?: readonly string[];
  /** Patterns subtracted from the outer (ceiling) set. */
  readonly outerMinus?: readonly string[];
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
  const alphabet = alphabetOf([...outer, ...inner, ...innerMinus, ...outerMinus]);

  const innerDfa =
    innerMinus.length === 0
      ? dfaFromGlobs(inner, alphabet)
      : difference(dfaFromGlobs(inner, alphabet), dfaFromGlobs(innerMinus, alphabet));

  const outerDfa =
    outerMinus.length === 0
      ? dfaFromGlobs(outer, alphabet)
      : difference(dfaFromGlobs(outer, alphabet), dfaFromGlobs(outerMinus, alphabet));

  return isSubsetOf(innerDfa, outerDfa);
}

/**
 * Whether a concrete string is matched by any of `globs`. This is the
 * membership primitive the proxy uses on real tool arguments, and the oracle
 * the containment tests check their counterexamples against.
 */
export function globMatches(globs: readonly string[], value: string): boolean {
  const alphabet = alphabetOf([...globs, value.length > 0 ? value : "x"]);
  // Literal characters of the probe string must be in the alphabet, otherwise
  // they collapse to OTHER and could be mistaken for one another.
  const withValueChars = new Set(alphabet);
  for (const ch of value) withValueChars.add(ch);
  return dfaAccepts(dfaFromGlobs(globs, [...withValueChars]), value);
}

export { type Containment } from "./dfa.js";
