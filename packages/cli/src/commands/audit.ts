import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import {
  AuditKeyError, auditKeyId, loadAuditKey, verifyAuditLog, type AuditKey,
} from "@mandate-dev/proxy";

/**
 * `mandate audit` -- R16's signed log, from the outside: making the key that
 * signs it and checking a log someone hands you.
 *
 * Exit codes follow the rest of the CLI: 0 the log is intact and sealed, 1 it
 * is not (broken, or unsealed), 2 bad input.
 */

const KEYGEN_HINT = "Create one with `mandate audit keygen --out <path>`.";

/**
 * What `serve` and `run` check before anything is minted when `--audit-log`
 * is given: that there is a key, that it is an Ed25519 key only its owner can
 * read, and that the log does not exist yet. An operator who asked for an
 * audit log gets one or nothing runs.
 */
export function auditInputs(
  auditLog: string | undefined, keyPath: string | undefined,
): { readonly key?: AuditKey } | { readonly error: string } {
  if (auditLog === undefined) return {};
  if (keyPath === undefined) {
    return {
      error: "--audit-log needs MANDATE_AUDIT_KEY_PATH, the Ed25519 key that signs the log. "
        + `${KEYGEN_HINT} Nothing was minted.`,
    };
  }
  let key: AuditKey;
  try {
    key = loadAuditKey(keyPath);
  } catch (e) {
    if (!(e instanceof AuditKeyError)) throw e;
    return { error: `${e.message} Nothing was minted.` };
  }
  if (existsSync(auditLog)) {
    return {
      error: `${auditLog} already exists; an audit log is never overwritten. Name a new file. `
        + "Nothing was minted.",
    };
  }
  return { key };
}

export interface AuditKeygenArgs {
  /** The private key. Written at mode 0600, never over an existing file. */
  readonly out: string;
  /** The public key, which is what an auditor is given. */
  readonly publicOut: string;
}

export function runAuditKeygen(args: AuditKeygenArgs, log: (s: string) => void): number {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let priv: number;
  try {
    // 0600 at creation, so the key is never readable by others, even briefly.
    priv = openSync(args.out, "wx", 0o600);
  } catch (e) {
    log(refusal(args.out, e));
    return 2;
  }
  let pub: number;
  try {
    pub = openSync(args.publicOut, "wx", 0o644);
  } catch (e) {
    closeSync(priv);
    unlinkSync(args.out);
    log(refusal(args.publicOut, e));
    return 2;
  }
  try {
    writeSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    writeSync(pub, publicKey.export({ type: "spki", format: "pem" }).toString());
  } finally {
    closeSync(priv);
    closeSync(pub);
  }
  log(`Wrote the audit signing key to ${args.out} (mode 600) and its public key to ${args.publicOut}.`);
  log(`Key id: ${auditKeyId(publicKey)}`);
  log(
    `Set MANDATE_AUDIT_KEY_PATH=${args.out} where serve runs, and give ${args.publicOut} to whoever `
    + "checks the logs. This is not the GitHub App's key and should not be stored with it.",
  );
  return 0;
}

const refusal = (path: string, e: unknown): string =>
  (e as { code?: unknown } | null)?.code === "EEXIST"
    ? `${path} already exists; a key is never overwritten.`
    : `Could not write ${path}: ${e instanceof Error ? e.message : String(e)}`;

export interface AuditVerifyArgs {
  readonly file: string;
  /** The public key the log's signer published. */
  readonly publicKey: string;
}

export function runAuditVerify(args: AuditVerifyArgs, log: (s: string) => void): number {
  let src: string;
  let pem: string;
  try {
    src = readFileSync(args.file, "utf8");
    pem = readFileSync(args.publicKey, "utf8");
  } catch (e) {
    log(`Could not read ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  let v: ReturnType<typeof verifyAuditLog>;
  try {
    v = verifyAuditLog(src, pem);
  } catch (e) {
    if (!(e instanceof AuditKeyError)) throw e;
    log(`${args.publicKey}: ${e.message}`);
    return 2;
  }
  if (!v.ok) {
    log(`Not intact: line ${v.line}: ${v.reason}.`);
    log("Nothing in this log can be relied on past the line before it.");
    return 1;
  }

  const allowed = v.graph.nodes.filter((n) => n.decision === "allow").length;
  const denied = v.graph.nodes.length - allowed;
  log(`Intact: ${v.events} event(s), signed by key ${v.keyId}.`);
  log(`Mandate ${v.mandateId} (sha256 ${v.mandateHash}), requested by ${v.mandate.requestedBy}.`);
  if (v.graph.ceiling !== undefined) {
    log(`Proved against ceiling ${v.graph.ceiling.label} (sha256 ${v.graph.ceiling.sha256}).`);
  }
  log(v.approval === undefined
    ? "No approval was required for this session."
    : `Approved by ${v.approval.by} in ${v.approval.issue} (comment ${v.approval.comment}, ${v.approval.at}).`);
  log(`${v.graph.nodes.length} decision(s): ${allowed} allowed, ${denied} denied.`);
  if (v.unfinished.length > 0) {
    log(
      `${v.unfinished.length} call(s) were sent to GitHub and never completed; whether they took `
      + "effect is not recorded:",
    );
    for (const u of v.unfinished) {
      const where = [u.resource, u.branch, ...u.paths].filter((x) => x !== undefined).join(" ");
      log(`  call ${u.call} at ${u.at}: ${u.tool}${where === "" ? "" : ` ${where}`}`);
    }
  }
  if (v.sealed) {
    log(v.sealedAs === "never-opened"
      ? "Sealed: the session never opened (the mint or the upstream failed), so nothing was "
        + "served; this is the whole log."
      : "Sealed: the session served and then closed, and this is the whole log.");
    return 0;
  }
  log(
    "Not sealed: the session was killed, or the end of the log was cut off. Nothing in the "
    + "file can tell which, so events after the last one here may be missing.",
  );
  return 1;
}
