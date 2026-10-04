import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MandateSchema, type ProposedMandate } from "@mandate-dev/schema";
import { coverGrants, coverPrompt, type ProposedGrant } from "./cover.js";
import { applyPrune, prunePrompt } from "./prune.js";
import { WriterError } from "./errors.js";

export interface WriteRequest {
  readonly task: string;
  readonly repo: string;
  readonly requestedBy: string;
  readonly ceilingId: string;
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
// below mark every property required and nullable. `strict: true` guarantees
// the input validates against the schema it is given, and the stricter reading
// of that guarantee -- every property present -- is the one that cannot be
// probed without calling the API, so the schema satisfies both readings and
// Zod normalises null to absent.
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

const nullableArray = { type: ["array", "null"], items: { type: "string" } } as const;

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_grants",
  description:
    "Propose the grants this task needs. Send null for a facet the operation " +
    "should not be limited by.",
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
            action: { type: "string" },
            resources: { type: "array", minItems: 1, items: { type: "string" } },
            branches: nullableArray,
            paths: nullableArray,
            denyPaths: nullableArray,
            base: { type: ["string", "null"] },
            max: { type: ["integer", "null"], minimum: 1 },
          },
        },
      },
      destinations: { type: "array", minItems: 1, items: { type: "string" } },
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
    properties: { keep: { type: "array", items: { type: "string" } } },
  },
};

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
  const coveredGrants = coverGrants(proposal.grants.map(normalize));

  // ---- prune --------------------------------------------------------------
  const keep = await callTool(client, prunePrompt(req.task, coveredGrants), KEEP_TOOL, KeepInput);
  const finalGrants = applyPrune(coveredGrants, keep.keep);

  const assembled = MandateSchema.safeParse({
    mandate: slug(req.task),
    task: req.task,
    requestedBy: req.requestedBy,
    expiresInMinutes: req.expiresInMinutes ?? DEFAULT_TTL_MINUTES,
    ceiling: req.ceilingId,
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
    pruned: coveredGrants.filter((g) => !kept.has(g.action)).map((g) => g.action),
    latencyMs: Date.now() - started,
  };
}

function slug(task: string): string {
  const s = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s.length > 0 ? s : "task";
}
