import { z } from "zod";
import { getOperation, type ConstraintKind } from "@mandate-dev/catalog";

export type EnforcedBy = "token" | "proxy" | "ruleset" | "sandbox";

/**
 * The restricted glob language the validator can decide: literal characters,
 * `*` (a run of non-`/`), and `**` (any run). Anything else is rejected here
 * rather than at containment time, because an undecidable pattern must never
 * reach the point where a decision is expected.
 */
export const GlobString = z
  .string()
  .min(1)
  .refine((s) => !/[?[\]{}!()|+@\\]/.test(s), {
    message: "unsupported glob metacharacter; only literals, * and ** are allowed",
  })
  .refine((s) => !s.includes("***"), { message: "*** is not a valid glob" })
  .refine((s) => !s.split("/").includes(".."), {
    message: "path traversal is not allowed in a pattern",
  });

const GrantBase = z.object({
  action: z.string(),
  enforcedBy: z.enum(["token", "proxy", "ruleset", "sandbox"]),
  resources: z.array(GlobString).min(1),
  branches: z.array(GlobString).min(1).optional(),
  paths: z.array(GlobString).min(1).optional(),
  denyPaths: z.array(GlobString).min(1).optional(),
  base: GlobString.optional(),
  max: z.number().int().positive().max(100).optional(),
});

/** Which grant fields each catalog constraint kind authorises. */
const CONSTRAINT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  branches: ["branches"],
  paths: ["paths", "denyPaths"],
  base: ["base"],
  max: ["max"],
};

export const GrantSchema = GrantBase.superRefine((g, ctx) => {
  const op = getOperation(g.action);
  if (!op) {
    ctx.addIssue({ code: "custom", path: ["action"], message: `unknown operation: ${g.action}` });
    return;
  }
  for (const [kind, fields] of Object.entries(CONSTRAINT_FIELDS)) {
    if (op.constrainable.includes(kind as ConstraintKind)) continue;
    for (const field of fields) {
      if (g[field as keyof typeof g] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `operation ${g.action} cannot be constrained by ${field}`,
        });
      }
    }
  }
});

export type Grant = z.infer<typeof GrantBase>;

/**
 * `user:` or `app:` only. An agent is never an authorized requester: the PRD's
 * lifecycle has task context arriving from an authorized source, with an
 * agent's plan admissible as evidence but never as authority.
 */
const Principal = z
  .string()
  .regex(/^(user|app):[A-Za-z0-9._-]+$/, "requestedBy must be user:<id> or app:<id>");

export const MandateSchema = z
  .object({
    mandate: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "mandate id must be kebab-case"),
    task: z.string().min(1).max(4000),
    requestedBy: Principal,
    /**
     * GitHub installation tokens expire one hour from creation and cannot be
     * extended, so a mandate longer than that is not mintable as a single
     * token. The compiler re-mints while the mandate is still live.
     */
    expiresInMinutes: z.number().int().positive().max(60),
    ceiling: z.string().min(1),
    grants: z.array(GrantSchema).min(1).max(64),
    destinations: z.object({ allow: z.array(z.string().min(1)) }),
  })
  // Rejects `notGrantedNotable` and any other unknown key. That field is
  // derived from the catalog for display only; silently accepting and ignoring
  // it would be the worst of both outcomes.
  .strict();

export type Mandate = z.infer<typeof MandateSchema>;

/**
 * The writer's output type. Untrusted: only `validate()` may accept it, and a
 * lint rule keeps this type out of every package but the writer and validator.
 */
export type ProposedMandate = Mandate & { readonly __proposed?: true };
