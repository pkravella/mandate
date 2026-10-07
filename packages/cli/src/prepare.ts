import { readFileSync } from "node:fs";
import { parseMandateYaml, type ProposedMandate, type ValidatedMandate } from "@mandate-dev/schema";
import {
  loadCeiling, validate, type Ceiling, type Rejection,
} from "@mandate-dev/validator";
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
    readonly ceiling: Ceiling;
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
      // Labelled with the id the MANDATE declares, which is a known weakness
      // rather than an oversight: `loadCeiling` cannot tell whether the file it
      // was given is the policy that id names. Containment is still proved
      // against the file the operator passed, so this mislabels rather than
      // over-grants, and the adversarial suite pins that the proof records the
      // operator's id and not the mandate's claim.
      proposed.ceiling,
      readFileSync(args.ceiling, "utf8"),
      readFileSync(args.schema, "utf8"),
      readFileSync(args.destinations, "utf8"),
    );
  } catch (e) {
    return { ok: false, code: 2, message: `Could not load the ceiling: ${message(e)}` };
  }

  const result = validate(proposed, { ceiling, authority: resolved.authority });
  if (!result.ok) {
    return {
      ok: false, code: 1,
      rejections: result.rejections,
      proposed,
      provenance: resolved.provenance,
    };
  }

  return {
    ok: true,
    mandate: result.mandate,
    proposed,
    ceiling,
    verified: resolved.verified,
    provenance: resolved.provenance,
  };
}
