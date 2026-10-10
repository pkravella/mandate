import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseMandateYaml, type ProposedMandate, type ValidatedMandate } from "@mandate-dev/schema";
import { loadCeiling, validate, type Ceiling, type Rejection } from "@mandate-dev/validator";
import { resolveAuthority, type AuthorityDeps } from "./authority.js";

/**
 * Everything three commands do before they can act: read the mandate, load the
 * ceiling, work out whose authority applies, and prove the mandate sits inside
 * both.
 *
 * `validate`, `serve` and `run` all need this and none of them may do it
 * differently. A `serve` that validated against a ceiling loaded a shade
 * differently from `validate` would enforce a mandate the operator had never
 * approved — the mandate would have passed one check and been enforced under
 * another.
 */
export interface PrepareArgs {
  readonly file: string;
  readonly ceiling: string;
  readonly schema: string;
  readonly destinations: string;
  readonly as: string;
  readonly repo?: string | undefined;
  readonly level?: string | undefined;
}

export type Prepared =
  | {
    readonly ok: true;
    readonly mandate: ValidatedMandate;
    readonly proposed: ProposedMandate;
    /** Whether the requester's level was read from GitHub or asserted. */
    readonly verified: boolean;
    readonly provenance: string;
  }
  /** Exit 2: something could not be read, or the operator must choose. */
  | { readonly ok: false; readonly code: 2; readonly message: string }
  /** Exit 1: the mandate was read and refused. */
  | {
    readonly ok: false;
    readonly code: 1;
    readonly rejections: readonly Rejection[];
    readonly proposed: ProposedMandate;
    readonly provenance: string;
  };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function prepareMandate(
  args: PrepareArgs, deps: AuthorityDeps = {},
): Promise<Prepared> {
  const resolved = await resolveAuthority(
    { as: args.as, repo: args.repo, level: args.level }, deps,
  );
  if ("error" in resolved) return { ok: false, code: 2, message: resolved.error };

  let proposed: ProposedMandate;
  try {
    proposed = parseMandateYaml(readFileSync(args.file, "utf8"));
  } catch (e) {
    return { ok: false, code: 2, message: `Could not read a mandate from ${args.file}: ${message(e)}` };
  }

  let ceiling: Ceiling;
  try {
    ceiling = loadCeiling(
      // Labelled with the operator's file, never the id the mandate declares.
      // It used to be the mandate's id, so a writer steered by issue text
      // chose the name the CLI then printed for the policy it had checked --
      // `attacker-policy@v1.destinations` about org-policy-v12.cedar. The
      // adversarial suite said the label was never read because its harness
      // labelled the ceiling itself. The identity is the hash; this is a label.
      ceilingLabel(args.ceiling),
      readFileSync(args.ceiling, "utf8"),
      readFileSync(args.schema, "utf8"),
      readFileSync(args.destinations, "utf8"),
    );
  } catch (e) {
    return { ok: false, code: 2, message: `Could not load the ceiling: ${message(e)}` };
  }

  const provenance = `${resolved.provenance}\n${describeCeiling(ceiling, proposed.ceiling)}`;
  const result = validate(proposed, { ceiling, authority: resolved.authority });
  if (!result.ok) {
    return {
      ok: false, code: 1,
      rejections: result.rejections,
      proposed,
      provenance,
    };
  }

  return {
    ok: true,
    mandate: result.mandate,
    proposed,
    verified: resolved.verified,
    provenance,
  };
}

/** The operator's name for a ceiling: its policy file. A label, not an identity. */
export const ceilingLabel = (path: string): string => basename(path);

/**
 * One line naming the ceiling a decision was taken against, by label and by
 * content, and the mandate's own name for it as what it is: a claim nothing
 * checks. Kept as a warning rather than a refusal for now -- there is no
 * operator-declared id to compare a mandate's claim with, only a file.
 */
export function describeCeiling(ceiling: Ceiling, claimed: string): string {
  return `Ceiling: ${ceiling.id}, sha256:${ceiling.sha256}. The mandate names its ceiling `
    + `${JSON.stringify(claimed)}; that is the mandate's claim, and nothing checks it.`;
}
