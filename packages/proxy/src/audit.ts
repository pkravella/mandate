import {
  appendFileSync, closeSync, openSync, readFileSync, statSync,
} from "node:fs";
import {
  createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { mandateHash, MandateSchema, type Mandate } from "@mandate-dev/schema";
import {
  parseNode, TraceParseError,
  type ActionGraph, type ActionNode, type ForwardedCall, type GraphSink, type TraceCeiling,
} from "./graph.js";

/**
 * R16: a signed, append-only log of a session -- the mandate, every call the
 * proxy forwarded, every decision -- written as it happens.
 *
 * **What the signature proves, and what it does not.** It proves the log was
 * written by someone holding the audit key and has not changed since. Without
 * `--sandbox` the agent runs as the operator's user, can read that key (as it
 * can the App's -- threat-model §3.1) and can write the log, so there the
 * signature proves nothing against the agent. With `--sandbox` the key never
 * enters the container. Either way it is tamper evidence for a log stored
 * somewhere the key is not.
 *
 * **Format** (`mandate-audit/1`). One JSON object per line, `{"e": <event as a
 * JSON string>, "sig": <base64>}`. `sig` is Ed25519 over the UTF-8 bytes of
 * `mandate-audit/1\n` followed by `e` exactly as it appears, so a verifier in
 * any language checks the bytes it has rather than a re-serialisation. Every
 * event carries `seq` (1, 2, ...) and `prev`: the sha256 of the whole previous
 * line, or null on the first. The first event is `open` (the mandate, its
 * hash, the ceiling, the key's id, a random session id), then `forwarded` and
 * `node` events, then a `seal` saying why the log ended.
 *
 * **Append-only, to the extent a file can be.** Editing, removing or
 * reordering an event breaks a signature or the chain. Cutting lines off the
 * end does not: a log with no seal was either killed or truncated, and nothing
 * in the file can tell which. The verifier says exactly that.
 */
export const AUDIT_FORMAT = "mandate-audit/1";

export class AuditKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditKeyError";
  }
}

export class AuditLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogError";
  }
}

/**
 * Why a log was sealed. A seal says the log is complete; it does not say the
 * agent ran. `never-opened`: the session failed before serving (the mint, or
 * the upstream), so nothing was forwarded. `closed`: the session served and
 * ended -- the agent left, a signal, or its expiry.
 */
export type SealReason = "closed" | "never-opened";

/** R16's "approvals": the requester's approval serve found before minting (R5). */
export interface AuditApproval {
  /** `owner/repo#number`. */
  readonly issue: string;
  readonly comment: number;
  readonly by: string;
  readonly at: string;
  /** What was approved: `approvalDigest(mandate, ceiling sha256, requester)`. */
  readonly digest: string;
}

export interface AuditKey {
  readonly privateKey: KeyObject;
  /** sha256 of the public key's SubjectPublicKeyInfo DER, hex. */
  readonly keyId: string;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

const signedBytes = (e: string): Buffer => Buffer.from(`${AUDIT_FORMAT}\n${e}`, "utf8");

/** The id a log's `open` event names its key by. Takes either half of the pair. */
export function auditKeyId(key: string | KeyObject): string {
  // createPublicKey derives from a private KeyObject or a PEM, and refuses a
  // KeyObject that is already public.
  const pub = typeof key !== "string" && key.type === "public" ? key : createPublicKey(key);
  return sha256(pub.export({ type: "spki", format: "der" }));
}

/**
 * Reads the audit signing key, the way the App key is handled: a path from the
 * environment, read once, never logged or put in an error.
 *
 * Refuses three things. A key other users can open, as ssh does. Anything
 * that is not an unencrypted PEM private key, without echoing it. And any key
 * that is not Ed25519 -- in particular the App's RSA key, which node would sign
 * with without complaint: the key that mints installation tokens signs nothing
 * else.
 */
export function loadAuditKey(path: string): AuditKey {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (e) {
    throw new AuditKeyError(`could not read the audit key at ${path} (${codeOf(e)})`);
  }
  if ((mode & 0o077) !== 0) {
    throw new AuditKeyError(
      `the audit key at ${path} is open to other users (mode ${(mode & 0o777).toString(8)}); `
      + `it must be readable by its owner only: chmod 600 it`,
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(path));
  } catch {
    throw new AuditKeyError(`the audit key at ${path} is not an unencrypted PEM private key`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new AuditKeyError(
      `the audit key at ${path} is an ${privateKey.asymmetricKeyType ?? "unknown"} key. The audit `
      + "log is signed with Ed25519, and with a key of its own: the GitHub App's key mints "
      + "installation tokens and should sign nothing else. Create one with `mandate audit keygen`.",
    );
  }
  return { privateKey, keyId: auditKeyId(privateKey) };
}

export interface AuditLogOptions {
  /** Told once when the log stops being written. Defaults to doing nothing. */
  readonly onError?: (message: string) => void;
  /** Writes one line. Injected for tests; defaults to appending to the file. */
  readonly append?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * The audit log, as a `GraphSink`. Each event is signed, chained and appended
 * to the file synchronously as it happens, so a process killed mid-session
 * leaves every event before the kill -- probed: lines written with
 * `appendFileSync` survive a SIGKILL. Not fsynced: a power cut can lose what
 * the OS had not flushed.
 *
 * Never throws once created. The first write that fails is reported through
 * `onError` and ends the log, unsealed: a chain with a line missing in the
 * middle would fail verification anyway, and stopping says so sooner.
 */
export class AuditLog implements GraphSink {
  readonly #key: AuditKey;
  readonly #append: (line: string) => void;
  readonly #close: () => void;
  readonly #onError: (message: string) => void;
  readonly #now: () => Date;
  #seq = 0;
  #prev: string | null = null;
  #state: "new" | "open" | "sealed" | "failed" = "new";
  #warnedLate = false;

  private constructor(
    key: AuditKey, append: (line: string) => void, close: () => void, opts: AuditLogOptions,
  ) {
    this.#key = key;
    this.#append = append;
    this.#close = close;
    this.#onError = opts.onError ?? (() => undefined);
    this.#now = opts.now ?? (() => new Date());
  }

  /**
   * Creates the file, refusing one that exists: an audit log is never
   * overwritten or appended to by a second session. Throws `AuditLogError`,
   * which a caller should treat as a refusal to start -- before anything is
   * minted, an operator who asked for an audit log gets one or nothing runs.
   */
  static create(path: string, key: AuditKey, opts: AuditLogOptions = {}): AuditLog {
    if (opts.append !== undefined) return new AuditLog(key, opts.append, () => undefined, opts);
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      throw new AuditLogError(codeOf(e) === "EEXIST"
        ? `${path} already exists; an audit log is never overwritten. Name a new file.`
        : `could not create the audit log at ${path} (${codeOf(e)})`);
    }
    return new AuditLog(key, (line) => { appendFileSync(fd, line); }, () => { closeSync(fd); }, opts);
  }

  /** The first event: what was authorised, by whom, against which ceiling, signed by which key. */
  open(mandate: Mandate, ceiling?: TraceCeiling, approval?: AuditApproval): void {
    if (this.#state !== "new") {
      this.#report("the audit log was opened twice; the second open was not written");
      return;
    }
    this.#state = "open";
    this.#emit({
      type: "open",
      format: AUDIT_FORMAT,
      at: this.#now().toISOString(),
      keyId: this.#key.keyId,
      // Random, so no two logs share a line even when two sessions run the same
      // mandate in the same millisecond -- Ed25519 is deterministic, and
      // without this their lines were byte-identical. Every later line chains
      // back to it, so a line moved between logs breaks the chain.
      session: randomBytes(16).toString("hex"),
      mandateId: mandate.mandate,
      mandateHash: mandateHash(mandate),
      ...(ceiling === undefined ? {} : { ceiling }),
      ...(approval === undefined ? {} : { approval }),
      // JSON drops a ValidatedMandate's symbol brand, so this is the plain mandate.
      mandate,
    });
  }

  forwarded(call: number, start: ForwardedCall): void {
    this.#event({ type: "forwarded", call, ...start });
  }

  completed(node: ActionNode, call?: number): void {
    this.#event({ type: "node", ...(call === undefined ? {} : { call }), node });
  }

  /**
   * The claim that the log is complete. Nothing is written after it. Returns
   * whether the log is sealed: false if it failed earlier or the seal itself
   * could not be written.
   */
  seal(reason: SealReason = "closed"): boolean {
    if (this.#state !== "open") return this.#state === "sealed";
    this.#emit({ type: "seal", at: this.#now().toISOString(), reason });
    if (this.#state === "open") this.#state = "sealed";
    this.#safeClose();
    return this.#state === "sealed";
  }

  #event(event: Record<string, unknown>): void {
    if (this.#state === "open") {
      this.#emit(event);
    } else if (this.#state === "sealed" && !this.#warnedLate) {
      // A call in flight at the seal, coming back after it.
      this.#warnedLate = true;
      this.#onError(
        `a ${String(event["type"])} event arrived after the log was sealed and was not written`,
      );
    } else if (this.#state === "new") {
      this.#report(`a ${String(event["type"])} event arrived before the log was opened`);
    }
  }

  #emit(event: Record<string, unknown>): void {
    try {
      const e = JSON.stringify({ seq: this.#seq + 1, prev: this.#prev, ...event });
      const sig = sign(null, signedBytes(e), this.#key.privateKey).toString("base64");
      const line = JSON.stringify({ e, sig });
      this.#append(`${line}\n`);
      this.#seq += 1;
      this.#prev = sha256(line);
    } catch (e) {
      this.#report(`could not write to the audit log (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /** Ends the log on its first failure, unsealed, and says so once. */
  #report(what: string): void {
    if (this.#state === "failed") return;
    this.#state = "failed";
    this.#safeClose();
    this.#onError(`${what}; no further events will be written, and the log will have no seal`);
  }

  #safeClose(): void {
    try {
      this.#close();
    } catch {
      // The file is complete or already failed; nothing left to protect.
    }
  }
}

const codeOf = (e: unknown): string =>
  (e as { code?: unknown } | null)?.code !== undefined
    ? String((e as { code: unknown }).code)
    : e instanceof Error ? e.message : String(e);

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a readable timestamp");
const Envelope = z.object({ e: z.string(), sig: z.string().min(1) }).strict();
const Chain = { seq: z.number().int().positive(), prev: Sha256Hex.nullable() };

const OpenEvent = z.object({
  ...Chain,
  type: z.literal("open"),
  format: z.literal(AUDIT_FORMAT),
  at: Timestamp,
  keyId: Sha256Hex,
  session: z.string().regex(/^[0-9a-f]{32}$/),
  mandateId: z.string().min(1),
  mandateHash: Sha256Hex,
  ceiling: z.object({ label: z.string().min(1), sha256: Sha256Hex }).strict().optional(),
  approval: z.object({
    issue: z.string().min(1), comment: z.number().int().positive(), by: z.string().min(1),
    at: Timestamp, digest: Sha256Hex,
  }).strict().optional(),
  mandate: z.unknown(),
}).strict();

const ForwardedEvent = z.object({
  ...Chain,
  type: z.literal("forwarded"),
  call: z.number().int().positive(),
  at: Timestamp,
  tool: z.string().min(1),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  paths: z.array(z.string()),
  base: z.string().min(1).optional(),
  destinations: z.array(z.string()),
  unreadableDestinations: z.array(z.object({ field: z.string(), value: z.string() }).strict())
    .min(1).optional(),
  method: z.string().optional(),
}).strict();

const NodeEvent = z.object({
  ...Chain,
  type: z.literal("node"),
  call: z.number().int().positive().optional(),
  node: z.unknown(),
}).strict();

const SealEvent = z.object({
  ...Chain, type: z.literal("seal"), at: Timestamp, reason: z.enum(["closed", "never-opened"]),
}).strict();

const Event = z.discriminatedUnion("type", [OpenEvent, ForwardedEvent, NodeEvent, SealEvent]);

/** A forwarded call with no node: sent to GitHub, outcome never recorded. */
export type UnfinishedCall = { readonly call: number } & ForwardedCall;

export type AuditVerdict =
  | {
    readonly ok: true;
    /** False when the log ends without a seal: killed, or cut off. Indistinguishable. */
    readonly sealed: boolean;
    /** Present when sealed: whether the session served at all. */
    readonly sealedAs?: SealReason;
    readonly keyId: string;
    readonly mandateId: string;
    readonly mandateHash: string;
    readonly mandate: Mandate;
    /** The requester's approval serve found before minting, when it required one. */
    readonly approval?: AuditApproval;
    /** The trace the session's recorder held, as replay reads it. */
    readonly graph: ActionGraph;
    readonly unfinished: readonly UnfinishedCall[];
    /** Events that verified. */
    readonly events: number;
  }
  | { readonly ok: false; readonly line: number; readonly reason: string };

/**
 * Checks a log against the public key the operator published, and returns
 * what it records. `ok: false` names the first line that does not hold.
 *
 * One leniency: a last line with no newline that does not parse, before any
 * seal, is read as a write cut off by a kill and the log is reported intact up
 * to it and unsealed. Truncation is already undetectable at the tail, so this
 * hides nothing that dropping the line would not.
 *
 * Throws `AuditKeyError` if the key is not an Ed25519 public key.
 */
export function verifyAuditLog(src: string, publicKeyPem: string): AuditVerdict {
  // createPublicKey would derive the public half from a private key and carry
  // on. An auditor holding the signing key should be told, not given a clean
  // verdict with the one file that can forge a log.
  let isPrivate = true;
  try {
    createPrivateKey(publicKeyPem);
  } catch {
    isPrivate = false;
  }
  if (isPrivate) {
    throw new AuditKeyError(
      "that is a private key. Verify with the public key (`.pub`); whoever holds this file "
      + "can sign any log, so treat it as exposed if it was shared",
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new AuditKeyError("the public key is not a PEM public key");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new AuditKeyError(
      `the public key is an ${publicKey.asymmetricKeyType ?? "unknown"} key; audit logs are signed with Ed25519`,
    );
  }
  const givenKeyId = auditKeyId(publicKey);

  const raw = src.split("\n");
  const terminated = src.endsWith("\n");
  if (terminated) raw.pop();
  if (raw.length === 0 || (raw.length === 1 && raw[0] === "")) {
    return { ok: false, line: 1, reason: "the log is empty" };
  }

  let open: z.infer<typeof OpenEvent> | undefined;
  let mandate: Mandate | undefined;
  let sealed = false;
  let sealedAs: SealReason | undefined;
  let prevLine: string | undefined;
  let verified = 0;
  const nodes: ActionNode[] = [];
  const forwarded = new Map<number, ForwardedCall>();
  const done = new Set<number>();

  for (const [index, text] of raw.entries()) {
    const line = index + 1;
    const cutOff = !terminated && index === raw.length - 1;
    const fail = (reason: string): AuditVerdict => ({ ok: false, line, reason });

    const envelope = Envelope.safeParse(tryJson(text));
    if (!envelope.success) {
      if (cutOff && !sealed && open !== undefined) break;
      return fail("not a signed audit line");
    }
    const { e, sig } = envelope.data;
    const parsed = Event.safeParse(tryJson(e));
    if (!parsed.success) {
      return fail(`not a recognised event — ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
    const event = parsed.data;

    // Before the signature, so a log checked against the wrong key says which
    // key it needs rather than only that a signature failed.
    if (line === 1 && event.type === "open" && event.keyId !== givenKeyId) {
      return fail(`the log was signed by key ${event.keyId}; the key given is ${givenKeyId}`);
    }
    if (!verify(null, signedBytes(e), publicKey, Buffer.from(sig, "base64"))) {
      return fail("the signature does not match this event: it was altered, or signed by another key");
    }
    if (event.seq !== line) return fail(`event seq ${event.seq} on line ${line}; events are numbered by line`);
    const expectedPrev = prevLine === undefined ? null : sha256(prevLine);
    if (event.prev !== expectedPrev) {
      return fail("the chain is broken: this event does not follow the line before it");
    }
    if (sealed) return fail("an event after the seal; nothing follows a seal");

    switch (event.type) {
      case "open": {
        if (line !== 1) return fail("a second open event");
        const m = MandateSchema.safeParse(event.mandate);
        if (!m.success) return fail("the open event's mandate is not a valid mandate");
        if (mandateHash(m.data) !== event.mandateHash) {
          return fail(`the mandate does not hash to the stated mandateHash ${event.mandateHash}`);
        }
        if (m.data.mandate !== event.mandateId) return fail("mandateId does not match the mandate");
        open = event;
        mandate = m.data;
        break;
      }
      case "forwarded": {
        if (event.call !== forwarded.size + 1) {
          return fail(`forwarded call ${event.call}, expected ${forwarded.size + 1}`);
        }
        forwarded.set(event.call, {
          at: event.at,
          tool: event.tool,
          ...(event.action !== undefined ? { action: event.action } : {}),
          ...(event.resource !== undefined ? { resource: event.resource } : {}),
          ...(event.branch !== undefined ? { branch: event.branch } : {}),
          paths: event.paths,
          ...(event.base !== undefined ? { base: event.base } : {}),
          destinations: event.destinations,
          ...(event.unreadableDestinations !== undefined
            ? { unreadableDestinations: event.unreadableDestinations } : {}),
          ...(event.method !== undefined ? { method: event.method } : {}),
        });
        break;
      }
      case "node": {
        let node: ActionNode;
        try {
          node = parseNode(event.node);
        } catch (err) {
          return fail(err instanceof TraceParseError ? err.message : String(err));
        }
        if (node.seq !== nodes.length + 1) return fail(`node seq ${node.seq}, expected ${nodes.length + 1}`);
        if (node.decision === "allow") {
          if (event.call === undefined) return fail("an allowed node with no forwarded call");
          if (!forwarded.has(event.call)) return fail(`node for call ${event.call}, which was never forwarded`);
          if (done.has(event.call)) return fail(`a second node for call ${event.call}`);
          done.add(event.call);
        } else if (event.call !== undefined) {
          return fail("a denied node cannot finish a forwarded call; nothing was sent");
        }
        nodes.push(node);
        break;
      }
      case "seal": {
        sealed = true;
        sealedAs = event.reason;
        break;
      }
    }
    prevLine = text;
    verified += 1;
  }

  // Every case above accepts an event before the open; this is where that fails.
  if (open === undefined || mandate === undefined) {
    return { ok: false, line: 1, reason: "the log does not start with an open event" };
  }
  return {
    ok: true,
    sealed,
    ...(sealedAs === undefined ? {} : { sealedAs }),
    keyId: open.keyId,
    mandateId: open.mandateId,
    mandateHash: open.mandateHash,
    mandate,
    ...(open.approval === undefined ? {} : { approval: open.approval }),
    graph: {
      mode: "enforced",
      mandateId: open.mandateId,
      mandateHash: open.mandateHash,
      ...(open.ceiling === undefined ? {} : { ceiling: open.ceiling }),
      nodes,
    },
    unfinished: [...forwarded.entries()]
      .filter(([call]) => !done.has(call))
      .map(([call, start]) => ({ call, ...start })),
    events: verified,
  };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
