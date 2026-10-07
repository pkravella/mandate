import { createHash } from "node:crypto";
import { z } from "zod";
import { extractArgs } from "./enforce.js";
import type { Decision } from "./proxy.js";

/**
 * R8: every call the proxy decided on, as a node carrying its operation,
 * resource, inputs, outputs and destination.
 *
 * This file is a **data contract**, not just a type. Task 17 scores a mandate
 * by replaying a recorded trace through the real argument enforcer, so a facet
 * the recorder drops is a facet the scorer cannot check, and a facet the
 * recorder invents is an under-grant the proxy would never have produced. The
 * extraction here is `extractArgs` — the same function the enforcer uses — and
 * it must stay that way.
 */
export interface ActionNode {
  /**
   * 1-based and strictly increasing, in the order nodes were **completed**.
   *
   * Not the order the proxy decided: an allowed call's node is written when its
   * upstream result arrives, so two calls in flight at once are numbered by
   * which finished first. Reserving the number at decision time instead would
   * make an abandoned handle leave a gap, and `parseJsonl` rejects a gap — a
   * trace that will not load is worse than one ordered by completion. Every
   * agent here calls tools one at a time, so the two orders coincide today.
   */
  readonly seq: number;
  /** When the call reached the proxy, not when it finished. */
  readonly at: string;
  readonly tool: string;
  /**
   * The catalog operation the deciding rule named. Absent when the proxy could
   * not attribute the call to one — an expired mandate and an ungranted tool
   * are both refused before any rule is consulted. `operationsForMcpTool` maps
   * the tool back to its candidates for a reader who wants them.
   */
  readonly action?: string;
  /** `owner/name`, when the call named both. */
  readonly resource?: string;
  readonly branch?: string;
  readonly paths: readonly string[];
  readonly base?: string;
  /**
   * `host/path` prefixes from destination-bearing fields only, exactly as R9a
   * defines them. A URL inside a `body` or a file's `content` is not a
   * destination and is deliberately not recorded here.
   */
  readonly destinations: readonly string[];
  readonly decision: "allow" | "deny";
  /** The clause that refused the call. Always present on a denial. */
  readonly clause?: string;
  /**
   * Why this node ended the way it did: the clause's reason on a denial, the
   * upstream error on a failure. Absent on a call that simply succeeded.
   */
  readonly reason?: string;
  /**
   * What the upstream call did. Always present on an allow, never on a denial.
   * `error` is an `isError: true` result — a call the mandate permitted and
   * GitHub refused, which is not the same evidence as one that worked.
   */
  readonly outcome?: "ok" | "error" | "upstream-failure";
  /** UTF-8 bytes of the serialized result, envelope included. 0 if none came back. */
  readonly outputBytes: number;
  /**
   * sha256 of the serialized result, truncated to 12 hex characters. Absent
   * when nothing came back, because sha256 of the empty string reads as a real
   * digest of real output. Repository contents are never stored.
   */
  readonly outputDigest?: string;
  readonly durationMs: number;
}

/**
 * Whether the run that produced this trace was under a mandate.
 *
 * Decision D8 builds the benchmark's ground truth from runs with the recorder
 * attached and **no mandate at all**. Without this field such a run has to
 * invent a mandate id, and afterwards nothing can tell ground truth from an
 * enforced run — which is exactly the distinction the replay scorer rests on.
 */
export type TraceMode = "enforced" | "unconstrained";

export interface ActionGraph {
  readonly mode: TraceMode;
  /** Present when and only when `mode` is `"enforced"`. */
  readonly mandateId?: string;
  readonly mandateHash?: string;
  readonly nodes: readonly ActionNode[];
}

/** The type makes an unconstrained trace unable to claim a mandate. */
export type RecorderMeta =
  | {
    readonly mode: "enforced";
    readonly mandateId: string;
    /** `mandateHash(mandate)` — the full sha256, as `ProxyRules` carries it. */
    readonly mandateHash: string;
  }
  | { readonly mode: "unconstrained" };

export interface CallInput {
  readonly tool: string;
  readonly action?: string;
  readonly args: Record<string, unknown>;
}

export interface DenialInput {
  readonly tool: string;
  readonly action?: string;
  readonly args: Record<string, unknown>;
  readonly decision: Extract<Decision, { kind: "deny" }>;
}

/**
 * Completes a recorded call. Both methods are idempotent and the first wins:
 * a handle completed twice would otherwise write two nodes sharing one `seq`,
 * which `parseJsonl` rejects — corrupting the trace rather than duplicating a
 * row.
 */
export interface RecordHandle {
  readonly completed: (result: unknown) => void;
  readonly upstreamFailed: (detail: string) => void;
}

const DIGEST_CHARS = 12;

const digest = (serialized: string): string =>
  createHash("sha256").update(serialized).digest("hex").slice(0, DIGEST_CHARS);

/**
 * Keys sorted, array order preserved.
 *
 * Sorted keys so two identical payloads that arrived with different key order
 * digest the same; preserved array order because the order of content blocks
 * is meaningful, unlike the order-insensitive arrays in a mandate.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, (value as Record<string, unknown>)[k]] as const)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  // JSON.stringify(undefined) is undefined, not a string; everything reaching
  // here through the filters above is a JSON scalar.
  return JSON.stringify(value) ?? "null";
}

export class Recorder {
  readonly #meta: RecorderMeta;
  readonly #nodes: ActionNode[] = [];
  #seq = 0;

  constructor(meta: RecorderMeta) {
    this.#meta = meta;
  }

  /**
   * Records a call the mandate allowed. The node is written when the returned
   * handle is completed, so the duration and the output are real.
   */
  recordCall(input: CallInput): RecordHandle {
    const start = startOf(input);
    let written = false;
    const once = (node: ActionNode): void => {
      if (written) return;
      written = true;
      this.#nodes.push(node);
    };
    return {
      completed: (result: unknown): void => {
        const serialized = stableStringify(result);
        const isError = (result as { isError?: unknown } | null | undefined)?.isError === true;
        once({
          ...start.base(this.#next(written)),
          decision: "allow",
          outcome: isError ? "error" : "ok",
          outputBytes: Buffer.byteLength(serialized, "utf8"),
          outputDigest: digest(serialized),
          durationMs: start.elapsed(),
        });
      },
      upstreamFailed: (detail: string): void => {
        once({
          ...start.base(this.#next(written)),
          decision: "allow",
          outcome: "upstream-failure",
          reason: detail,
          outputBytes: 0,
          durationMs: start.elapsed(),
        });
      },
    };
  }

  /**
   * Records a call the mandate refused. Written immediately: nothing was sent
   * upstream, so there is nothing to wait for and nothing to digest.
   */
  recordDenial(input: DenialInput): void {
    const start = startOf(input);
    this.#nodes.push({
      ...start.base(this.#next(false)),
      decision: "deny",
      clause: input.decision.clause,
      reason: input.decision.reason,
      outputBytes: 0,
      durationMs: start.elapsed(),
    });
  }

  /** A snapshot. Later calls to `record*` do not change a graph already taken. */
  graph(): ActionGraph {
    return {
      ...(this.#meta.mode === "enforced"
        ? {
          mode: "enforced" as const,
          mandateId: this.#meta.mandateId,
          mandateHash: this.#meta.mandateHash,
        }
        : { mode: "unconstrained" as const }),
      nodes: [...this.#nodes],
    };
  }

  /** One header line, then one line per node. Append-only and streamable. */
  toJsonl(): string {
    const g = this.graph();
    const header = {
      type: "header",
      mode: g.mode,
      ...(g.mandateId !== undefined ? { mandateId: g.mandateId } : {}),
      ...(g.mandateHash !== undefined ? { mandateHash: g.mandateHash } : {}),
    };
    return [
      JSON.stringify(header),
      ...g.nodes.map((n) => JSON.stringify({ type: "node", ...n })),
    ].join("\n") + "\n";
  }

  /** Reserves the next sequence number, unless this handle already wrote one. */
  #next(written: boolean): number {
    return written ? this.#seq : ++this.#seq;
  }
}

/** The fields a node carries whatever happened to it, fixed at the call's start. */
function startOf(input: CallInput | DenialInput): {
    base: (seq: number) => Pick<
      ActionNode,
      "seq" | "at" | "tool" | "action" | "resource" | "branch" | "paths" | "base" | "destinations"
    >;
    elapsed: () => number;
  } {
  // Wall clock for `at`, monotonic for the duration: Date.now() can step
  // backwards over an NTP correction and produce a negative duration.
  const at = new Date().toISOString();
  const started = performance.now();
  const e = extractArgs(input.tool, input.args);
  return {
    base: (seq) => ({
      seq,
      at,
      tool: input.tool,
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(e.repo !== undefined ? { resource: e.repo } : {}),
      ...(e.branch !== undefined ? { branch: e.branch } : {}),
      paths: e.paths,
      ...(e.base !== undefined ? { base: e.base } : {}),
      destinations: e.destinations,
    }),
    elapsed: () => Math.round(performance.now() - started),
  };
}

export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceParseError";
  }
}

const HeaderLineSchema = z.discriminatedUnion("mode", [
  z.object({
    type: z.literal("header"),
    mode: z.literal("enforced"),
    mandateId: z.string().min(1),
    mandateHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({
    type: z.literal("header"),
    mode: z.literal("unconstrained"),
  }).strict(),
]);

const NodeLineSchema = z.object({
  type: z.literal("node"),
  seq: z.number().int().positive(),
  at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a readable timestamp"),
  tool: z.string().min(1),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  paths: z.array(z.string()),
  base: z.string().min(1).optional(),
  destinations: z.array(z.string()),
  decision: z.enum(["allow", "deny"]),
  clause: z.string().min(1).optional(),
  reason: z.string().optional(),
  outcome: z.enum(["ok", "error", "upstream-failure"]).optional(),
  outputBytes: z.number().int().nonnegative(),
  outputDigest: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  durationMs: z.number().nonnegative(),
})
  .strict()
  // Fail closed on a node that cannot be explained. A denial with no clause
  // breaks R10's promise that every stop names what it hit, and a denial
  // carrying an outcome or a digest is claiming output from a call that was
  // never sent.
  .refine(
    (n) => n.decision === "allow" || n.clause !== undefined,
    "a denied node must name the clause that refused it",
  )
  .refine(
    (n) => n.decision === "deny" || n.outcome !== undefined,
    "an allowed node must say what the upstream call did",
  )
  .refine(
    (n) => n.decision === "allow"
      || (n.outcome === undefined && n.outputDigest === undefined && n.outputBytes === 0),
    "a denied node cannot carry output; nothing was sent upstream",
  );

type NodeLine = z.infer<typeof NodeLineSchema>;

function toNode(l: NodeLine): ActionNode {
  return {
    seq: l.seq,
    at: l.at,
    tool: l.tool,
    ...(l.action !== undefined ? { action: l.action } : {}),
    ...(l.resource !== undefined ? { resource: l.resource } : {}),
    ...(l.branch !== undefined ? { branch: l.branch } : {}),
    paths: l.paths,
    ...(l.base !== undefined ? { base: l.base } : {}),
    destinations: l.destinations,
    decision: l.decision,
    ...(l.clause !== undefined ? { clause: l.clause } : {}),
    ...(l.reason !== undefined ? { reason: l.reason } : {}),
    ...(l.outcome !== undefined ? { outcome: l.outcome } : {}),
    outputBytes: l.outputBytes,
    ...(l.outputDigest !== undefined ? { outputDigest: l.outputDigest } : {}),
    durationMs: l.durationMs,
  };
}

const issues = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/**
 * Reads a trace file.
 *
 * This is the one place a file on disk becomes typed evidence the replay
 * scorer acts on, so every line is validated and anything unexpected is a
 * rejection rather than a silently dropped row: an unknown line type, an
 * unrecognized field, a second header, a gap or repeat in the sequence. A
 * hand-edited trace that scores well is worse than one that will not load.
 */
export function parseJsonl(src: string): ActionGraph {
  let header: z.infer<typeof HeaderLineSchema> | undefined;
  const nodes: ActionNode[] = [];
  const rawLines = src.split("\n");

  for (const [index, raw] of rawLines.entries()) {
    const at = `line ${index + 1}`;
    if (raw.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new TraceParseError(
        `${at} is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const type = (parsed as { type?: unknown } | null)?.type;
    if (type === "header") {
      if (header !== undefined) throw new TraceParseError(`${at} is a second header`);
      const r = HeaderLineSchema.safeParse(parsed);
      if (!r.success) throw new TraceParseError(`${at} is not a usable header — ${issues(r.error)}`);
      header = r.data;
      continue;
    }
    if (type === "node") {
      const r = NodeLineSchema.safeParse(parsed);
      if (!r.success) throw new TraceParseError(`${at} is not a usable node — ${issues(r.error)}`);
      const node = toNode(r.data);
      const previous = nodes[nodes.length - 1];
      const expected = previous === undefined ? 1 : previous.seq + 1;
      if (node.seq !== expected) {
        throw new TraceParseError(
          `${at} has seq ${node.seq}, expected ${expected}; a trace with a gap or a `
          + `repeat in its sequence is missing or duplicating decisions`,
        );
      }
      nodes.push(node);
      continue;
    }
    throw new TraceParseError(
      `${at} is neither a header nor a node (type ${JSON.stringify(type)})`,
    );
  }

  if (header === undefined) throw new TraceParseError("trace has no header line");

  return {
    ...(header.mode === "enforced"
      ? { mode: "enforced" as const, mandateId: header.mandateId, mandateHash: header.mandateHash }
      : { mode: "unconstrained" as const }),
    nodes,
  };
}

/**
 * The seam R16's signed append-only log replaces the in-memory array through.
 * **Interface only in v0.1.**
 *
 * R16 is P1: "signed, append-only log of mandates, approvals and decisions,
 * exportable as compliance evidence". `Recorder` currently holds its nodes in
 * memory and serialises them at the end, which is fine for a run that finishes
 * and useless for one that is killed — the evidence dies with the process.
 *
 * A sink receives each node as it completes, so an implementation can append
 * and sign incrementally. Two properties any implementation must keep:
 *
 *   - **It must not be able to change a decision.** `append` returns
 *     `Promise<void>`, so a sink has no way to signal "do not allow this". A
 *     sink that could veto would be a second enforcement point whose rules
 *     nothing validated, and R15's "a model may flag, never allow" exists for
 *     the same reason.
 *   - **A failing sink must not fail the call.** Audit is not authorisation:
 *     losing a log line is bad, and refusing a granted call because the logger
 *     was unreachable turns an audit outage into a denial of service.
 *
 * `seq` is completion order, so a sink receives nodes in the order
 * `parseJsonl` will demand to read them back.
 */
export interface GraphSink {
  append(node: ActionNode): Promise<void>;
}
