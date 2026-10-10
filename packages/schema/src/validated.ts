import type { Mandate } from "./mandate.js";

/** Per-grant evidence produced by the containment engine. */
export interface GrantProof {
  readonly grantIndex: number;
  readonly action: string;
  /** Ceiling policy ids that permitted this grant. */
  readonly permittedBy: readonly string[];
  readonly resourcesContained: true;
  readonly pathsContained: true;
  readonly branchesContained: true;
}

export interface ContainmentProof {
  /**
   * The label the ceiling was loaded under: the operator's policy file, never
   * the id a mandate declares. Two files can share a label.
   */
  readonly ceilingId: string;
  /** What the ceiling contained: `ceilingSha256` of its three inputs. Its identity. */
  readonly ceilingSha256: string;
  readonly userLevel: string;
  readonly checkedAt: string;
  readonly grantProofs: readonly GrantProof[];
}

/**
 * A real runtime symbol, not an ambient `declare const`. An ambient
 * declaration type-checks but emits a reference to a binding that does not
 * exist, so `markValidated` would throw ReferenceError at runtime while
 * compiling clean. The symbol is deliberately not exported, so no caller
 * outside this module can name it.
 */
const validated: unique symbol = Symbol("mandate.validated");

/**
 * A mandate the validator has proved sits inside the ceiling and the user's
 * authority.
 *
 * What this brand does and does not buy, measured rather than assumed:
 *
 *   const v: ValidatedMandate = plainMandate   // TS2322, blocked
 *   plainMandate as ValidatedMandate           // compiles
 *   plainMandate as unknown as ValidatedMandate// compiles
 *   { ...plainMandate } as ValidatedMandate    // compiles
 *
 * TypeScript permits a narrowing cast to an intersection type, so the brand is
 * a guardrail against accident, not a security boundary. It reliably stops the
 * realistic failure -- someone wiring the writer straight into the compiler
 * during a refactor, where the plain assignment fails to compile. It does not
 * stop a contributor who writes an explicit cast; the lint rule in Task 7 and
 * code review are what cover that.
 *
 * `markValidated` additionally demands a `ContainmentProof`, which raises the
 * cost of a bypass from one cast to fabricating evidence, but a determined
 * caller can write that object literal too. Defence in depth, not a proof.
 */
export type ValidatedMandate = Mandate & {
  readonly [validated]: ContainmentProof;
};

export function markValidated(m: Mandate, proof: ContainmentProof): ValidatedMandate {
  // Frozen so a holder cannot widen authority in place after the proof was taken.
  return Object.freeze({ ...m, [validated]: proof }) as ValidatedMandate;
}

export function unwrap(v: ValidatedMandate): Mandate {
  const { [validated]: _proof, ...rest } = v;
  return rest as Mandate;
}

export function proofOf(v: ValidatedMandate): ContainmentProof {
  return v[validated];
}
