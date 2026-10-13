import { EventEmitter } from "node:events";
import { accessSync, constants, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MintDeps } from "@leastpilot/compiler";
import { proofOf } from "@leastpilot/schema";
import {
  AuditLog, AuditLogError, widenRefusal, type AuditKey, type Decision, type PauseRecord,
} from "@leastpilot/proxy";
import { auditInputs } from "./audit.js";
import {
  approvalInputs, requireApproval, type ApprovalReader, type ApprovalRecord,
} from "../approval.js";
import { renderRejections } from "../diff.js";
import { prepareMandate, type PrepareArgs } from "../prepare.js";
import { openSession, type Session, type SessionOptions } from "../session.js";
import type { AuthorityDeps } from "../authority.js";
import {
  checkRelaySecret, ListenError, listenForAgent, parseListenAddress, type AgentListener,
} from "../listen.js";

/**
 * `leastpilot serve` — the enforced MCP server an agent spawns.
 *
 * This is the integration point. Claude Code, Codex and every other MCP client
 * start their servers as subprocesses speaking JSON-RPC over stdio, so the way
 * to put LeastPilot between an agent and GitHub is to *be* the server it starts.
 * The agent needs no adapter and LeastPilot needs no agent-specific code, which is
 * also what makes PRD goal 5 — vendor neutrality — true rather than aspirational.
 *
 * **stdout belongs to the protocol.** Every diagnostic goes to stderr. A single
 * `console.log` here corrupts the JSON-RPC stream and the agent sees a parse
 * error rather than a tool list, so `log` is wired to stderr and there is no
 * path in this file that writes stdout.
 *
 * The token is minted by this process and never leaves it: it is not in the
 * MCP config the agent reads, not in argv, and not in the trace. An agent that
 * can read its own config still cannot read the credential.
 */
export interface ServeArgs extends PrepareArgs {
  /** Where to write the action graph when the session ends. R8. */
  readonly trace?: string | undefined;
  /**
   * `ip:port` to serve one sandboxed agent on, instead of stdio. The agent is
   * in a container and cannot spawn this process, so `leastpilot run --sandbox`
   * starts it on the host and the container's relay connects. See listen.ts.
   */
  readonly listen?: string | undefined;
  /** Written with `{host, port}` once listening, so the launcher can read the port. */
  readonly readyFile?: string | undefined;
  /**
   * R16: write a signed log of the session here, as it happens. Signed with
   * `deps.auditKeyPath`; never over an existing file.
   */
  readonly auditLog?: string | undefined;
  /**
   * R5: `owner/repo#number`. Nothing is minted unless the mandate's requester
   * approved this exact mandate there (see approval.ts).
   */
  readonly approval?: string | undefined;
  /**
   * R10: a directory to write each denial's pause record into, one JSON file
   * per denial, each one a file `leastpilot widen` reads.
   */
  readonly pauses?: string | undefined;
}

export interface ServeDeps extends AuthorityDeps {
  readonly github: MintDeps;
  /** Injected for tests; defaults to the real Docker upstream. */
  readonly upstream?: SessionOptions["upstream"];
  /**
   * Connects the proxy to a transport. Defaults to stdio, which is what an
   * agent spawns. A test pairs it with an in-memory client instead.
   */
  readonly connect?: (session: Session) => Promise<void>;
  /** Resolves when the server should shut down. Defaults to the process ending. */
  readonly until?: () => Promise<void>;
  /**
   * The relay's shared secret, for `listen`. Read from MANDATE_RELAY_SECRET by
   * the CLI, so it is never in argv, where any process can read it.
   */
  readonly relaySecret?: string | undefined;
  /** The stream whose end stops a stdio session. Injected for tests. */
  readonly stdin?: NodeJS.EventEmitter;
  /** Where SIGINT and SIGTERM arrive. Defaults to the process. */
  readonly signals?: NodeJS.EventEmitter;
  /** The audit signing key, for `auditLog`. From LEASTPILOT_AUDIT_KEY_PATH. */
  readonly auditKeyPath?: string | undefined;
  /** Reads an issue's comments, for `approval`. Defaults to none: --approval then refuses. */
  readonly approvals?: ApprovalReader | undefined;
}

/**
 * Resolves when the client has gone away or the process is asked to stop.
 *
 * `stdin` ending is the normal case: the agent closed the pipe, so there is
 * nobody left to serve. The transport attaches `data` and `error` to stdin and
 * not `end`, so listening here does not conflict with it.
 *
 * Exported for the test. The default path revokes a live repository-scoped
 * token, which is the single thing in this file that must not be left to a
 * signal handler nobody has ever run — it is reachable with a pipe and so it is
 * tested with one.
 */
export const untilSignalled = (
  signals: NodeJS.EventEmitter = process,
  input: NodeJS.EventEmitter = process.stdin,
): Promise<void> =>
  new Promise<void>((resolve) => {
    const done = (): void => resolve();
    signals.once("SIGINT", done);
    signals.once("SIGTERM", done);
    input.once("end", done);
    input.once("close", done);
  });

/** Returns the process exit code: 0 served and shut down, 1 refused, 2 bad input. */
export async function runServe(
  args: ServeArgs, log: (s: string) => void, deps: ServeDeps,
): Promise<number> {
  // Listen-mode inputs are checked before anything is minted: a token minted
  // for a server that then cannot listen is a credential nobody can use.
  let listenAt: { host: string; port: number } | undefined;
  if (args.listen !== undefined) {
    try {
      listenAt = parseListenAddress(args.listen);
      if (deps.relaySecret === undefined) {
        throw new ListenError(
          "listening for a sandboxed agent needs MANDATE_RELAY_SECRET, the secret its relay presents",
        );
      }
      checkRelaySecret(deps.relaySecret);
    } catch (e) {
      log(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }

  // The audit key and the log's path, before anything is minted -- an
  // operator who asked for an audit log gets one or nothing runs.
  const audited = auditInputs(args.auditLog, deps.auditKeyPath);
  if ("error" in audited) {
    log(audited.error);
    return 2;
  }
  const auditKey: AuditKey | undefined = audited.key;

  // Same rule for the pause directory: one that cannot be written is found
  // now, not at the first denial.
  if (args.pauses !== undefined) {
    try {
      mkdirSync(args.pauses, { recursive: true });
      accessSync(args.pauses, constants.W_OK);
    } catch (e) {
      log(`--pauses ${args.pauses} cannot be written: ${e instanceof Error ? e.message : String(e)}. `
        + "Nothing was minted.");
      return 2;
    }
  }

  const approvalIn = approvalInputs(args.approval, deps.approvals);
  if ("error" in approvalIn) {
    log(approvalIn.error);
    return 2;
  }

  // Listening for SIGINT and SIGTERM from here, before anything is minted.
  // Found reviewing Phase 5: the listeners used to go on only once serve was
  // serving, so a signal during the mint -- the launcher's start-up timeout,
  // an operator's Ctrl-C -- killed it by the default action with a live token
  // nobody would revoke.
  const signalled = untilSignalled(deps.signals ?? process, new EventEmitter());
  let stopRequested = false;
  void signalled.then(() => { stopRequested = true; });

  const prepared = await prepareMandate(args, deps);
  if (stopRequested) {
    log("Stopped before anything was minted.");
    return 0;
  }
  if (!prepared.ok) {
    if (prepared.code === 1) {
      log(renderRejections(prepared.rejections, prepared.proposed));
      log(prepared.provenance);
      log("Nothing was minted and no server was started.");
      return 1;
    }
    log(prepared.message);
    return 2;
  }

  // Before the audit log and the mint: an unapproved mandate gets neither.
  let approved: ApprovalRecord | undefined;
  if (approvalIn.ref !== undefined && deps.approvals !== undefined) {
    const check = await requireApproval(prepared.mandate, approvalIn.ref, deps.approvals);
    if (!check.ok) {
      log(check.message);
      log("Nothing was minted.");
      return check.code;
    }
    approved = check.record;
    log(`Approved by ${approved.by} in ${approved.issue} (comment ${approved.comment}, ${approved.at}).`);
  }

  // Opened before the mint, so the log records a session that failed to open
  // as well as one that ran.
  let audit: AuditLog | undefined;
  if (args.auditLog !== undefined && auditKey !== undefined) {
    const path = args.auditLog;
    try {
      audit = AuditLog.create(path, auditKey, {
        onError: (m) => { log(`Audit log ${path}: ${m}.`); },
      });
    } catch (e) {
      if (!(e instanceof AuditLogError)) throw e;
      log(`${e.message} Nothing was minted.`);
      return 2;
    }
    const proof = proofOf(prepared.mandate);
    audit.open(prepared.mandate, { label: proof.ceilingId, sha256: proof.ceilingSha256 }, approved);
  }
  const sealAudit = (reason: "closed" | "never-opened"): void => {
    if (audit === undefined) return;
    log(audit.seal(reason)
      ? `Sealed the audit log at ${args.auditLog ?? ""}.`
      : `The audit log at ${args.auditLog ?? ""} is not sealed; see the error above.`);
  };

  const decisions: Decision[] = [];
  let session: Session;
  let listener: AgentListener | undefined;
  try {
    session = await openSession({
      mandate: prepared.mandate,
      github: deps.github,
      ...(deps.upstream === undefined ? {} : { upstream: deps.upstream }),
      onDecision: (d) => decisions.push(d),
      ...(audit === undefined ? {} : { sink: audit }),
      ...(args.pauses === undefined ? {} : { onPause: pauseWriter(args, log) }),
    });
  } catch (e) {
    log(`Could not open an enforced session: ${e instanceof Error ? e.message : String(e)}`);
    sealAudit("never-opened");
    return 2;
  }

  try {
    log(prepared.provenance);
    log(
      `Serving ${session.rules.allowedTools.length} tool(s) under mandate `
      + `${session.rules.mandateId} (${session.rules.mandateHash.slice(0, 12)}), `
      + `token ${session.minted.fingerprint}, expires ${session.minted.expiresAt}. `
      + (session.rules.cappedBy === undefined
        ? `The mandate runs until ${session.rules.expiresAt}.`
        : `The session ends at ${session.rules.expiresAt}, a margin before the token does; `
          + `the mandate itself would have run until ${session.rules.cappedBy.mandateExpiresAt}.`),
    );
    if (!prepared.verified) {
      log(
        "The requester's level was asserted, not verified. This session enforces the "
        + "mandate either way, but nothing here establishes that the requester was "
        + "entitled to ask for it.",
      );
    }

    // The session ends at its expiry -- the mandate's, or a margin before the
    // token's -- not only when the agent leaves. Found reviewing Phase 5: the
    // proxy refused every call past expiry, but the session, the listener and
    // a still-valid token stayed up until disconnect. Unref'd so it never
    // holds the process open by itself.
    let expiryTimer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      const at = Date.parse(session.rules.expiresAt);
      expiryTimer = setTimeout(() => {
        log(`The session reached its expiry at ${session.rules.expiresAt}.`);
        resolve();
      }, Number.isNaN(at) ? 0 : Math.max(0, at - Date.now()));
      expiryTimer.unref();
    });
    const stopping = Promise.race([signalled, expired]);
    try {
      if (stopRequested) {
        // Signalled while the token was being minted: straight to the finally,
        // which writes the trace and revokes.
        log("Stopped while the session was opening.");
      } else if (listenAt !== undefined && deps.relaySecret !== undefined) {
        const s = session;
        listener = await listenForAgent({
          ...listenAt, secret: deps.relaySecret,
          connect: async (t) => { await s.proxy.connect(t); },
        });
        if (args.readyFile !== undefined) {
          // Renamed into place, so the launcher never reads a half-written file.
          writeFileSync(
            `${args.readyFile}.tmp`,
            `${JSON.stringify({ host: listener.host, port: listener.port })}\n`, "utf8",
          );
          renameSync(`${args.readyFile}.tmp`, args.readyFile);
        }
        log(`Listening on ${listener.host}:${listener.port} for the sandbox relay.`);
        // Not stdin: a serve started by `leastpilot run` has no agent on it, and
        // waiting for it to end would shut the session down at once.
        const l = listener;
        await (deps.until ?? (() => Promise.race([l.ended, stopping])))();
      } else {
        const connect = deps.connect
          ?? (async (s: Session) => { await s.proxy.connect(new StdioServerTransport()); });
        await connect(session);

        await (deps.until
          ?? (() => Promise.race([stopping, untilSignalled(new EventEmitter(), deps.stdin ?? process.stdin)])))();
      }
    } finally {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    }
  } finally {
    if (listener !== undefined) await listener.close();
    // Ordered: the trace is evidence of what happened and is written even when
    // the session ended badly, before the token goes back.
    if (args.trace !== undefined) {
      try {
        writeFileSync(args.trace, session.recorder.toJsonl(), "utf8");
        log(`Wrote ${decisions.length} decision(s) to ${args.trace}.`);
      } catch (e) {
        log(`Could not write the trace to ${args.trace}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await session.close();
    log("Session closed and the token revoked.");
    // After close: a call still in flight comes back as the upstream closes,
    // and the seal is the claim that nothing follows it.
    sealAudit("closed");
  }

  const denied = decisions.filter((d) => d.kind === "deny").length;
  log(`${decisions.length} call(s) decided, ${denied} denied.`);
  return 0;
}

/**
 * Writes each pause record to its own file and says, on stderr, what was
 * refused and -- where a widen is the right answer -- the command that asks
 * for it. The file name carries the time and a counter, so two sessions
 * writing to one directory never collide, and nothing is ever overwritten.
 * A failed write is reported and the session carries on: the refusal already
 * happened, and it is what protects.
 */
function pauseWriter(args: ServeArgs, log: (s: string) => void): (p: PauseRecord) => void {
  const dir = resolve(args.pauses ?? "");
  let seq = 0;
  return (p) => {
    seq += 1;
    // The tool name is the agent's: a `mandate.grants` denial carries whatever
    // it called. It never decides where the file goes.
    const tool = p.tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    // The pid keeps two serves sharing a directory from ever choosing one name.
    const path = join(dir,
      `${p.at.replace(/[:.]/g, "-")}-${process.pid}-${String(seq).padStart(3, "0")}-${tool}.json`);
    // Agent text reaches the operator's terminal JSON-quoted, so a newline or
    // an escape sequence in it cannot forge or erase a line.
    const said = `Paused ${JSON.stringify(p.tool)} at ${p.clause}: ${JSON.stringify(p.reason)}`;
    try {
      if (!path.startsWith(dir + sep)) throw new Error("the record's path left the directory");
      writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`, { flag: "wx" });
    } catch (e) {
      log(`${said}, but the pause record was not written: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    log(`${said}. Pause record: ${path}`);
    if (p.widenRequest !== undefined) {
      const argv = [
        "leastpilot", "widen", args.file, path,
        "--ceiling", args.ceiling, "--schema", args.schema, "--ceiling-destinations", args.destinations,
        "--as", args.as,
        ...(args.repo !== undefined ? ["--repo", args.repo] : []),
        ...(args.level !== undefined ? ["--level", args.level] : []),
      ];
      log(`  To ask for more scope, review and run: ${argv.map(shellQuote).join(" ")}`);
    } else {
      log(`  No widen offered: ${widenRefusal(p.clause) ?? "the call named nothing that can be proposed as "
        + "a narrow pattern (several paths, a wildcard or a control character)"}.`);
    }
  };
}

/** One argument, quoted for a POSIX shell when it needs it. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
