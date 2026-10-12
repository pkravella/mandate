import { GlobParseError } from "./parse.js";

/**
 * A work allowance shared across one `validate()` call.
 *
 * `MAX_DFA_STATES` bounds ONE automaton. A mandate is many: up to 64 grants,
 * each with up to four facets, each facet its own containment decision, plus a
 * Cedar cross-check whose witness set is the product of the grant's resources,
 * branches and paths. Every one of those stays under the per-automaton cap
 * while the mandate as a whole costs whatever the sum comes to.
 *
 * Measured before this existed, both schema-legal and neither over-granting
 * anything:
 *
 *   - `fixtures/adversarial/mandates/pattern-flood.yaml`, 22 KB, validated
 *     `ok: true` in 2.6 s;
 *   - the same construction at 64 grants x 64 resources, 698 KB, ran for over
 *     five minutes without returning.
 *
 * R3's wording is binding — "reject on any doubt" — and doubt about termination
 * is doubt. So exhausting the allowance is a rejection, which is why this
 * subclasses `GlobParseError`: every call site that already treats a throw from
 * the glob layer as `undecidable` keeps doing the right thing without knowing
 * this type exists, and the proxy's enforcer still turns it into a denial that
 * names its clause rather than letting an exception escape a request handler.
 */
export class WorkBudgetError extends GlobParseError {
  constructor(spent: number) {
    super(`the mandate is too complex to decide within ${spent} units of work`, "<mandate>");
    this.name = "WorkBudgetError";
  }
}

export interface WorkBudget {
  /** Units left. Not readonly: this is a running total by design. */
  remaining: number;
  readonly total: number;
}

/**
 * 8_000_000 units, where a unit is one (alphabet character x NFA state) pair
 * examined while building an automaton row, or one Cedar authorisation call.
 *
 * Calibrated from measurement, and the first two attempts were wrong in ways
 * worth recording, because the obvious units do not work:
 *
 * | unit                      | pattern-flood      | legit 19-grant monorepo |
 * | ------------------------- | ------------------ | ----------------------- |
 * | per transition (alphabet) | 380_160 / 2_513 ms | 738_040 / 427 ms        |
 * | per alphabet x set size   | 11_960_064 / 2_490 ms | 2_532_017 / 520 ms   |
 *
 * Under the first unit the ATTACK was cheaper than legitimate work while taking
 * six times as long, so no threshold could separate them and a budget tight
 * enough to stop the flood rejected a real monorepo mandate. Only charging for
 * the inner loop makes units and time agree.
 *
 * Against the second unit, measured:
 *
 *   - the four-grant mandate the benchmark actually produces: 24_717 (0.3%);
 *   - a 19-grant monorepo refactor: 2_532_017 (32%);
 *   - 64 grants, the schema maximum, all path-heavy: 3_788_180 (47%);
 *   - `pattern-flood`: 11_960_064, so it is refused about two thirds of the way
 *     through, in roughly 1.7 s.
 *
 * Phase 8 re-measured, after a cache scoped to one validate() call stopped the
 * same deny list, ceiling clause and probe automaton being rebuilt per grant
 * (see DfaCache in contains.ts):
 *
 *   - the benchmark's four-grant mandate: 14_379 (0.2%);
 *   - 64 grants with two deny patterns each: 535_703 (6.7%), was 47%;
 *   - 19 grants with an ordinary six-pattern deny list: 708_046 (8.9%), was
 *     102% -- refused as too complex before the cache;
 *   - 64 grants with that deny list: 2_142_421 (27%), was 341%;
 *   - `pattern-flood`, rewritten with distinct patterns per grant (identical
 *     grants now share their automata): refused at the budget, in ~0.9 s.
 *
 * The axis that mattered was the deny list, not the grant count. The table
 * below records the derivation of the unit; its figures predate the cache.
 *
 * Before the cache, the headroom was ~240x for a realistic mandate and ~2x for
 * one at the extreme end the test reached. That second figure is thin and is the
 * honest cost of a deterministic bound: a wall-clock deadline would separate the
 * two cleanly but would make a validator's verdict depend on how busy the
 * machine is, and a validator that answers differently on a loaded CI runner is
 * not one anything should be proved against.
 */
export const DEFAULT_WORK_UNITS = 8_000_000;

export const workBudget = (total: number = DEFAULT_WORK_UNITS): WorkBudget =>
  ({ remaining: total, total });

/**
 * Spends `units`, throwing once the allowance is gone.
 *
 * Takes an optional budget so every caller outside `validate()` — the proxy's
 * per-value membership checks, the lints run on their own, every existing test —
 * keeps its present behaviour and pays nothing. Only the validator, which is
 * the one place a whole mandate's worth of work is decided, passes one.
 */
export function charge(budget: WorkBudget | undefined, units: number): void {
  if (budget === undefined) return;
  budget.remaining -= units;
  if (budget.remaining < 0) throw new WorkBudgetError(budget.total);
}
