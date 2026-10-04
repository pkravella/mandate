import { parseGlob, type Token } from "./parse.js";

export type Pred =
  | { readonly kind: "lit"; readonly char: string }
  | { readonly kind: "notSlash" }
  | { readonly kind: "any" };

export interface Nfa {
  readonly start: number;
  readonly accepting: ReadonlySet<number>;
  readonly moves: ReadonlyMap<number, readonly { readonly pred: Pred; readonly to: number }[]>;
  readonly eps: ReadonlyMap<number, readonly number[]>;
}

export function predMatches(p: Pred, ch: string): boolean {
  switch (p.kind) {
    case "lit":
      return ch === p.char;
    case "notSlash":
      return ch !== "/";
    case "any":
      return true;
  }
}

/** Builds one NFA accepting the union of `globs`. */
export function nfaFromGlobs(globs: readonly string[]): Nfa {
  const moves = new Map<number, { pred: Pred; to: number }[]>();
  const eps = new Map<number, number[]>();
  const accepting = new Set<number>();
  const start = 0;
  let next = 1;

  const addEps = (from: number, to: number): void => {
    const bucket = eps.get(from);
    if (bucket) bucket.push(to);
    else eps.set(from, [to]);
  };
  const addMove = (from: number, pred: Pred, to: number): void => {
    const bucket = moves.get(from);
    if (bucket) bucket.push({ pred, to });
    else moves.set(from, [{ pred, to }]);
  };

  for (const glob of globs) {
    const tokens: Token[] = parseGlob(glob);
    let cur = next++;
    addEps(start, cur);

    for (const token of tokens) {
      const after = next++;
      switch (token.kind) {
        case "lit":
          addMove(cur, { kind: "lit", char: token.char }, after);
          break;
        // Kleene star over a single-character predicate: a self-loop for "one
        // more character" plus a free skip for "zero more".
        case "star":
          addMove(cur, { kind: "notSlash" }, cur);
          addEps(cur, after);
          break;
        case "globstar":
          addMove(cur, { kind: "any" }, cur);
          addEps(cur, after);
          break;
        // (any* "/")? -- either skip the whole thing, matching zero segments,
        // or consume any run and then a separator.
        //
        // The consuming branch needs its OWN state. Putting the self-loop and
        // the skip-epsilon on `cur` lets the automaton consume characters via
        // the loop and then take the skip, bypassing the required "/" -- which
        // collapses `**​/b` into `any* b` and makes it match "vaeb".
        case "globstarSlash": {
          const loop = next++;
          addEps(cur, after);
          addEps(cur, loop);
          addMove(loop, { kind: "any" }, loop);
          addMove(loop, { kind: "lit", char: "/" }, after);
          break;
        }
      }
      cur = after;
    }
    accepting.add(cur);
  }

  return { start, accepting, moves, eps };
}

export function epsilonClosure(nfa: Nfa, seed: Iterable<number>): Set<number> {
  const out = new Set<number>(seed);
  const stack = [...out];
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const t of nfa.eps.get(s) ?? []) {
      if (!out.has(t)) {
        out.add(t);
        stack.push(t);
      }
    }
  }
  return out;
}
