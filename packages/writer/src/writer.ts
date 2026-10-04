import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MandateSchema, type CeilingDigest, type ProposedMandate } from "@mandate-dev/schema";
import { coverGrants, coverPrompt, type ProposedGrant } from "./cover.js";
import { applyPrune, prunePrompt } from "./prune.js";
import { WriterError } from "./errors.js";

export interface WriteRequest {
  readonly task: string;
  readonly repo: string;
  readonly requestedBy: string;
  /**
   * The ceiling this mandate must sit inside, as data.
   *
   * Required, not optional: a writer that cannot see the ceiling is guessing
   * which operations its organization permits and what its branches are
   * called, and the live model guessed wrong on both. Guidance only — a
   * proposal that matches it still has to clear `validate()`.
   */
  readonly ceiling: CeilingDigest;
  readonly issueNumber?: number | undefined;
  /** PRD lifecycle step 1: evidence only, never authority. */
  readonly agentPlan?: string | undefined;
  /**
   * Mandate TTL in minutes. Defaults to `DEFAULT_TTL_MINUTES`, not to the
   * schema's 60-minute maximum: the cap is what the contract permits, not what
   * a task needs, and handing every task the longest possible authority
   * lifetime is the opposite of what this writer is for. A value above the cap
   * is a request error, never silently clamped.
   */
  readonly expiresInMinutes?: number | undefined;
}

export interface WriteResult {
  readonly proposed: ProposedMandate;
  readonly covered: readonly string[];
  readonly pruned: readonly string[];
  /**
   * Facets the model proposed that the operation cannot carry, as
   * `action: facet, ...`. Dropped rather than fatal, because the tool schema
   * asks for every facet and the model fills them in; an over-eager proposal
   * should not make the mandate unwritable. Reported so it stays visible.
   */
  readonly droppedFacets: readonly string[];
  readonly latencyMs: number;
}

/** The part of a model response the writer reads. Nothing else is consulted. */
export type WriterResponse = Pick<Anthropic.Message, "stop_reason" | "stop_details" | "content">;

export interface MessageStreamLike {
  finalMessage(): Promise<WriterResponse>;
}

/**
 * The only part of an Anthropic client the writer touches.
 *
 * Narrow on purpose. A real `Anthropic` satisfies it structurally, so the
 * writer needs no cast to accept one — and a test needs no cast to supply a
 * stub, which matters in a repository whose rule is that nothing crosses the
 * trust boundary by way of `as`.
 */
export interface AnthropicLike {
  readonly messages: {
    stream(params: Anthropic.MessageStreamParams): MessageStreamLike;
  };
}

const MODEL = "claude-opus-5-5";

/**
 * Generous, and streamed. Adaptive thinking is on and effort is `high`, so a
 * short ceiling here does not fail loudly — it returns a *truncated* tool
 * input, which can still parse into a smaller, wrong mandate.
 */
const MAX_TOKENS = 32000;

export const DEFAULT_TTL_MINUTES = 30;

/** `owner/name`, which is the only resource shape a mandate is written for. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// Tool inputs are tolerant of a missing or null facet, while the JSON schemas
// below mark every property required and nullable. Probed against the live API
// with `countTokens`: `strict: true` accepts optional properties, so this is a
// design choice rather than a constraint. Requiring every facet makes the model
// write `null` to leave one unconstrained, which turns an omission into a
// decision -- and an omitted `branches` on a file write is the difference
// between a mandate that validates and one the ceiling refuses.
//
// The same probe found what the API does *not* accept: `minimum` on an
// `integer` is a 400 ("For 'integer' type, property 'minimum' is not
// supported"). Bounds on `max` are Zod's and the mandate schema's job anyway --
// `.int().positive()` here, `.max(100)` in the contract.
const nullableGlobs = z.array(z.string()).min(1).nullish();

const ProposeGrantInput = z.object({
  action: z.string(),
  resources: z.array(z.string()).min(1),
  branches: nullableGlobs,
  paths: nullableGlobs,
  denyPaths: nullableGlobs,
  base: z.string().nullish(),
  max: z.number().int().positive().nullish(),
});

const ProposeInput = z.object({
  grants: z.array(ProposeGrantInput).min(1),
  destinations: z.array(z.string().min(1)).min(1),
});

const KeepInput = z.object({ keep: z.array(z.string()) });

const normalize = (g: z.infer<typeof ProposeGrantInput>): ProposedGrant => ({
  action: g.action,
  resources: g.resources,
  branches: g.branches ?? undefined,
  paths: g.paths ?? undefined,
  denyPaths: g.denyPaths ?? undefined,
  base: g.base ?? undefined,
  max: g.max ?? undefined,
});

const globList = (description: string) =>
  ({ type: ["array", "null"], items: { type: "string" }, description }) as const;

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_grants",
  description:
    "Propose the grants this task needs. Every facet is required: send null to "
    + "leave an operation unlimited by it, which is wider, not safer.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["grants", "destinations"],
    properties: {
      grants: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "resources", "branches", "paths", "denyPaths", "base", "max"],
          properties: {
            action: { type: "string", description: "A catalog operation id, e.g. contents.write." },
            resources: {
              type: "array", minItems: 1, items: { type: "string" },
              description: "Repositories as owner/name. Globs allowed: * within a path segment, ** across.",
            },
            branches: globList(
              "Branches this operation may touch. Required in practice for anything that "
              + "writes files, and it must not match a default branch.",
            ),
            paths: globList("Paths this operation may touch. null means every path."),
            denyPaths: globList(
              "Paths this operation may never touch, whatever `paths` allows.",
            ),
            base: {
              type: ["string", "null"],
              description: "For pull_request.create: the branch to merge into.",
            },
            max: {
              type: ["integer", "null"],
              description: "How many times this operation may run. Required for anything with an "
                + "outward-facing side effect.",
            },
          },
        },
      },
      destinations: {
        type: "array", minItems: 1, items: { type: "string" },
        description: "Hosts repository data may be sent to, e.g. github.com/acme/api.",
      },
    },
  },
};

const KEEP_TOOL: Anthropic.Tool = {
  name: "keep_grants",
  description: "Name the operation ids to keep.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["keep"],
    properties: {
      keep: {
        type: "array", items: { type: "string" },
        description: "Catalog operation ids from the proposed list.",
      },
    },
  },
};

/**
 * Exactly the tool definitions the writer sends, so a test can check them
 * against the API without paying for inference. `countTokens` validates the
 * request shape and runs no model, which is how the unsupported `minimum` above
 * was found.
 */
export const WRITER_TOOLS: readonly Anthropic.Tool[] = [PROPOSE_TOOL, KEEP_TOOL];

const zodWhy = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");

/**
 * One tool call, with every way it can go wrong turned into a `WriterError`.
 *
 * Opus 5.5 rejects forced `tool_choice`, so the model is instructed to call
 * the tool and the block is looked for here. Every stop reason that is not a
 * completed turn is a refusal to propose anything: a truncated response in
 * particular is dangerous precisely because it often *does* parse, as a
 * shorter grant list than the model meant to send.
 */
async function callTool<T>(
  client: AnthropicLike, prompt: string, tool: Anthropic.Tool, schema: z.ZodType<T>,
): Promise<T> {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    // Opus 5.5 defaults to `medium`, one level below the rest of the family,
    // and mandate writing is correctness-sensitive.
    output_config: { effort: "high" },
    tools: [tool],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: prompt }],
  });

  const message = await stream.finalMessage();
  const stop = message.stop_reason;

  if (stop === "refusal") {
    throw new WriterError("refused", `writer refused: ${JSON.stringify(message.stop_details)}`);
  }
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") {
    throw new WriterError(
      "truncated",
      `the writer's response was truncated (${stop}); a partial tool input can still parse, ` +
      `so no mandate is proposed from it`,
    );
  }
  if (stop !== "tool_use" && stop !== "end_turn") {
    throw new WriterError(
      "unexpected-stop",
      `the writer stopped with ${String(stop)}, which has no rule here; nothing is proposed`,
    );
  }

  const block = message.content.find((b) => b.type === "tool_use" && b.name === tool.name);
  if (block === undefined || block.type !== "tool_use") {
    throw new WriterError("no-tool-call", `writer did not call ${tool.name}`);
  }

  const parsed = schema.safeParse(block.input);
  if (!parsed.success) {
    throw new WriterError(
      "invalid-tool-input",
      `${tool.name} input did not match its schema: ${zodWhy(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * R2: write a mandate for one task, cover then prune.
 *
 * The result is a `ProposedMandate` and nothing more. It has not been proved to
 * sit inside anything; `validate()` is the only function that may accept it.
 */
export async function writeMandate(client: AnthropicLike, req: WriteRequest): Promise<WriteResult> {
  const started = Date.now();

  if (!REPO_PATTERN.test(req.repo)) {
    throw new WriterError(
      "invalid-request",
      `the repository must be owner/name, not ${JSON.stringify(req.repo)}`,
    );
  }

  // ---- cover --------------------------------------------------------------
  const proposal = await callTool(client, coverPrompt(req), PROPOSE_TOOL, ProposeInput);
  const covered = coverGrants(proposal.grants.map(normalize), req.ceiling);
  const coveredGrants = covered.grants;
  const { droppedFacets } = covered;

  // ---- prune --------------------------------------------------------------
  const keep = await callTool(client, prunePrompt(req.task, coveredGrants), KEEP_TOOL, KeepInput);
  const finalGrants = applyPrune(coveredGrants, keep.keep);

  const assembled = MandateSchema.safeParse({
    mandate: slug(req.task),
    task: req.task,
    requestedBy: req.requestedBy,
    expiresInMinutes: req.expiresInMinutes ?? DEFAULT_TTL_MINUTES,
    ceiling: req.ceiling.id,
    grants: finalGrants,
    destinations: { allow: proposal.destinations },
  });
  if (!assembled.success) {
    throw new WriterError(
      "invalid-mandate",
      `the assembled mandate does not satisfy the contract: ${zodWhy(assembled.error)}`,
    );
  }
  const proposed: ProposedMandate = assembled.data;

  // Compared by action, not by reference: applyPrune returns a *new* grant for
  // a prerequisite it narrowed, so identity would report that grant as pruned.
  const kept = new Set(finalGrants.map((g) => g.action));
  return {
    proposed,
    covered: coveredGrants.map((g) => g.action),
    droppedFacets,
    pruned: coveredGrants.filter((g) => !kept.has(g.action)).map((g) => g.action),
    latencyMs: Date.now() - started,
  };
}

const MAX_SLUG = 48;

/**
 * The mandate id, derived from the task text. It is what an audit entry and a
 * runtime pause name, so it is cut at a word boundary rather than mid-word:
 * the live writer produced `fix-issue-42-the-retry-loop-in-src-retry-ts-swal`.
 */
function slug(task: string): string {
  const all = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (all.length === 0) return "task";
  if (all.length <= MAX_SLUG) return all;
  const cut = all.slice(0, MAX_SLUG);
  const dash = cut.lastIndexOf("-");
  const trimmed = (dash > 0 ? cut.slice(0, dash) : cut).replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : "task";
}
