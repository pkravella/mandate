import { GlobParseError, parseGlob } from "./parse.js";
import { charge, type WorkBudget } from "./budget.js";
import { epsilonClosure, nfaFromGlobs, predMatches, type Nfa } from "./nfa.js";

/**
 * A representative for "every character that is neither `/` nor a literal
 * appearing in the globs under comparison".
 *
 * Sound because the only predicates in the language are `lit(c)`, `notSlash`
 * and `any`: two characters outside the literal set and distinct from `/` are
 * indistinguishable by every automaton we build, so collapsing them to one
 * representative loses nothing. U+0000 cannot occur in a GitHub ref,
 * repository name or path, so it is never itself a literal.
 */
export const OTHER = "\u0000";

/** What `OTHER` is rendered as in a counterexample shown to a person. */
const OTHER_DISPLAY = "x";

/**
 * Subset construction is exponential in the worst case. A pathological pattern
 * must be rejected, not allowed to hang the validator -- "reject on any doubt"
 * includes doubt about termination.
 */
const MAX_DFA_STATES = 10_000;

export function alphabetOf(globs: readonly string[]): string[] {
  const set = new Set<string>(["/"]);
  for (const g of globs) {
    for (const t of parseGlob(g)) if (t.kind === "lit") set.add(t.char);
  }
  set.add(OTHER);
  return [...set];
}

export interface Dfa {
  readonly start: number;
  readonly accepting: ReadonlySet<number>;
  readonly delta: ReadonlyMap<number, ReadonlyMap<string, number>>;
  readonly alphabet: readonly string[];
}

const DEAD = 0;

/** Subset construction. The result is total: state 0 is the dead state. */
export function dfaFromGlobs(
  globs: readonly string[], alphabet: readonly string[], budget?: WorkBudget,
): Dfa {
  const nfa: Nfa = nfaFromGlobs(globs);
  const delta = new Map<number, Map<string, number>>();
  const accepting = new Set<number>();
  const ids = new Map<string, number>();
  const keyOf = (s: ReadonlySet<number>): string => [...s].sort((a, b) => a - b).join(",");

  ids.set("", DEAD);
  delta.set(DEAD, new Map(alphabet.map((c) => [c, DEAD] as const)));

  const idFor = (s: Set<number>): number => {
    const k = keyOf(s);
    const existing = ids.get(k);
    if (existing !== undefined) return existing;
    if (ids.size > MAX_DFA_STATES) {
      throw new GlobParseError("pattern is too complex to decide", globs.join("|"));
    }
    const id = ids.size;
    ids.set(k, id);
    return id;
  };

  const startSet = epsilonClosure(nfa, [nfa.start]);
  const startId = idFor(startSet);
  const queue: Array<[number, Set<number>]> = [[startId, startSet]];
  const seen = new Set<number>([startId]);

  while (queue.length > 0) {
    const [id, set] = queue.shift()!;
    if ([...set].some((s) => nfa.accepting.has(s))) accepting.add(id);
    const row = new Map<string, number>();
    // The unit is the INNER loop, not the state and not the transition.
    // Computing this row walks every character of the alphabet, and for each one
    // every NFA state in this subset and its outgoing edges -- so the cost of a
    // row is alphabet x |set|, and a star-dense pattern is expensive precisely
    // because its subsets are large.
    //
    // Measured, which is the only reason this is the unit: charging per
    // transition (alphabet alone) made `pattern-flood` cost 380_160 units in
    // 2_513 ms while a legitimate 19-grant monorepo mandate cost 738_040 units
    // in 427 ms. Units ran opposite to time, so no threshold separated an
    // attack from real work. Multiplying by |set| is what makes them agree.
    charge(budget, alphabet.length * set.size);
    for (const ch of alphabet) {
      const targets = new Set<number>();
      for (const s of set) {
        for (const e of nfa.moves.get(s) ?? []) {
          if (predMatches(e.pred, ch)) targets.add(e.to);
        }
      }
      const closed = epsilonClosure(nfa, targets);
      const tid = closed.size === 0 ? DEAD : idFor(closed);
      row.set(ch, tid);
      if (closed.size > 0 && !seen.has(tid)) {
        seen.add(tid);
        queue.push([tid, closed]);
      }
    }
    delta.set(id, row);
  }

  return { start: startId, accepting, delta, alphabet };
}

function step(d: Dfa, s: number, ch: string): number {
  const row = d.delta.get(s);
  if (row === undefined) return DEAD;
  return row.get(ch) ?? DEAD;
}

/** L(a) \ L(b). Both must share an alphabet. */
export function difference(a: Dfa, b: Dfa, budget?: WorkBudget): Dfa {
  const alphabet = a.alphabet;
  const delta = new Map<number, Map<string, number>>();
  const accepting = new Set<number>();
  const ids = new Map<string, number>();

  const idFor = (x: number, y: number): number => {
    const k = `${x}|${y}`;
    const existing = ids.get(k);
    if (existing !== undefined) return existing;
    const id = ids.size;
    ids.set(k, id);
    return id;
  };

  const startId = idFor(a.start, b.start);
  const queue: Array<[number, number, number]> = [[startId, a.start, b.start]];
  const seen = new Set<number>([startId]);

  while (queue.length > 0) {
    const [id, x, y] = queue.shift()!;
    // In the difference, a string is accepted when `a` accepts it and `b` does not.
    if (a.accepting.has(x) && !b.accepting.has(y)) accepting.add(id);
    const row = new Map<string, number>();
    charge(budget, alphabet.length);
    for (const ch of alphabet) {
      const nx = step(a, x, ch);
      const ny = step(b, y, ch);
      const nid = idFor(nx, ny);
      row.set(ch, nid);
      if (!seen.has(nid)) {
        seen.add(nid);
        queue.push([nid, nx, ny]);
      }
    }
    delta.set(id, row);
  }

  return { start: startId, accepting, delta, alphabet };
}

export type Containment =
  | { readonly ok: true }
  | { readonly ok: false; readonly counterexample: string };

/**
 * Decides L(inner) ⊆ L(outer) by searching the product automaton for a state
 * that accepts in `inner` and rejects in `outer`. Breadth-first with parent
 * pointers, so the first such state yields a shortest distinguishing string.
 */
export function isSubsetOf(inner: Dfa, outer: Dfa, budget?: WorkBudget): Containment {
  const alphabet = inner.alphabet;
  const parents = new Map<string, { readonly prev: string; readonly ch: string }>();
  const startKey = `${inner.start}|${outer.start}`;
  const queue: Array<[number, number]> = [[inner.start, outer.start]];
  const seen = new Set<string>([startKey]);

  const reconstruct = (key: string): string => {
    const chars: string[] = [];
    let cur = key;
    while (cur !== startKey) {
      const p = parents.get(cur);
      if (p === undefined) break;
      chars.push(p.ch === OTHER ? OTHER_DISPLAY : p.ch);
      cur = p.prev;
    }
    return chars.reverse().join("");
  };

  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    const key = `${x}|${y}`;
    if (inner.accepting.has(x) && !outer.accepting.has(y)) {
      return { ok: false, counterexample: reconstruct(key) };
    }
    charge(budget, alphabet.length);
    for (const ch of alphabet) {
      const nx = step(inner, x, ch);
      const ny = step(outer, y, ch);
      const nkey = `${nx}|${ny}`;
      if (seen.has(nkey)) continue;
      seen.add(nkey);
      parents.set(nkey, { prev: key, ch });
      queue.push([nx, ny]);
    }
  }
  return { ok: true };
}

/** Whether a DFA accepts a concrete string, mapping unknown chars to OTHER. */
export function dfaAccepts(d: Dfa, s: string): boolean {
  let state = d.start;
  const known = new Set(d.alphabet);
  for (const ch of s) {
    state = step(d, state, known.has(ch) ? ch : OTHER);
  }
  return d.accepting.has(state);
}
