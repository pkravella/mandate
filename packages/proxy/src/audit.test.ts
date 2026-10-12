import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject,
} from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { mandateHash, type Mandate } from "@leastpilot/schema";
import {
  AUDIT_FORMAT, AuditKeyError, AuditLog, auditKeyId, loadAuditKey, verifyAuditLog,
} from "./audit.js";
import { Recorder, type ActionNode } from "./graph.js";

const MANDATE: Mandate = {
  mandate: "fix-issue-42",
  task: "Fix issue #42 and open a PR",
  requestedBy: "user:alice",
  expiresInMinutes: 30,
  ceiling: "org-policy@v12",
  grants: [
    { action: "contents.read", enforcedBy: "token", resources: ["acme/api"] },
  ],
  destinations: { allow: ["github.com/acme/api"] },
};

const CEILING = { label: "org-policy-v12.cedar", sha256: "c".repeat(64) };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mandate-audit-")); });

const pemOf = (k: KeyObject, type: "pkcs8" | "spki"): string =>
  k.export({ type, format: "pem" }).toString();

/** An Ed25519 key on disk at 0600, as `openssl genpkey -algorithm ed25519` leaves one. */
function keyFile(name = "audit.pem"): { path: string; publicPem: string; privateKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const path = join(dir, name);
  writeFileSync(path, pemOf(privateKey, "pkcs8"), { mode: 0o600 });
  return { path, publicPem: pemOf(publicKey, "spki"), privateKey };
}

/**
 * Appends a correctly signed and chained line, written from the format's
 * description rather than through AuditLog -- so the verifier is tested against
 * the format, and against lines AuditLog itself refuses to write.
 */
function forge(ls: string[], event: Record<string, unknown>, privateKey: KeyObject): void {
  const last = ls[ls.length - 1];
  const e = JSON.stringify({
    seq: ls.length + 1,
    prev: last === undefined ? null : createHash("sha256").update(last).digest("hex"),
    ...event,
  });
  const sig = sign(null, Buffer.from(`${AUDIT_FORMAT}\n${e}`), privateKey).toString("base64");
  ls.push(JSON.stringify({ e, sig }));
}

const ok = (text: string) => ({ content: [{ type: "text", text }] });

/**
 * A session's worth of events, written through a real Recorder: one read that
 * completed, one denial, and -- unless `finish` -- a write still in flight.
 */
function session(logPath: string, keyPath: string, opts: { finish?: boolean; seal?: boolean } = {}) {
  const log = AuditLog.create(logPath, loadAuditKey(keyPath));
  log.open(MANDATE, CEILING);
  const r = new Recorder({
    mode: "enforced", mandateId: MANDATE.mandate, mandateHash: mandateHash(MANDATE),
    ceiling: CEILING,
  }, log);
  r.recordCall({
    tool: "get_file_contents", action: "contents.read",
    args: { owner: "acme", repo: "api", path: "src/a.ts" },
  }).completed(ok("file"));
  r.recordDenial({
    tool: "merge_pull_request", args: { owner: "acme", repo: "api", pullNumber: 1 },
    decision: { kind: "deny", tool: "merge_pull_request", clause: "mandate.grants", reason: "not granted" },
  });
  const inFlight = r.recordCall({
    tool: "get_file_contents", action: "contents.read",
    args: { owner: "acme", repo: "api", path: "src/b.ts" },
  });
  if (opts.finish === true) inFlight.completed(ok("other"));
  if (opts.seal !== false) log.seal();
  return { recorder: r, log };
}

const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
const rewrite = (path: string, ls: readonly string[]): void => {
  writeFileSync(path, ls.map((l) => `${l}\n`).join(""));
};
const eventOf = (line: string): Record<string, unknown> =>
  JSON.parse((JSON.parse(line) as { e: string }).e) as Record<string, unknown>;

describe("loadAuditKey", () => {
  it("loads an Ed25519 key and names it by the sha256 of its public key", () => {
    const { path, publicPem } = keyFile();
    const key = loadAuditKey(path);
    const spki = createPublicKey(publicPem).export({ type: "spki", format: "der" });
    expect(key.keyId).toBe(createHash("sha256").update(spki).digest("hex"));
    expect(auditKeyId(publicPem)).toBe(key.keyId);
  });

  // The App's key is RSA, and node's sign(null, ...) signs with RSA without
  // complaint -- so pointing LEASTPILOT_AUDIT_KEY_PATH at the App key would sign
  // the log with the one credential that mints installation tokens.
  it("refuses an RSA key, which is what a GitHub App key is", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const path = join(dir, "app.pem");
    writeFileSync(path, privateKey.export({ type: "pkcs1", format: "pem" }).toString(), { mode: 0o600 });
    expect(() => loadAuditKey(path)).toThrow(AuditKeyError);
    expect(() => loadAuditKey(path)).toThrow(/rsa key.*Ed25519/i);
  });

  it("refuses a key other users can read, and says how to fix it", () => {
    const { path } = keyFile();
    chmodSync(path, 0o644);
    expect(() => loadAuditKey(path)).toThrow(/open to other users.*chmod 600/);
  });

  it("refuses something that is not a private key without echoing it", () => {
    const path = join(dir, "junk.pem");
    writeFileSync(path, "not-a-key-SECRETVALUE", { mode: 0o600 });
    expect(() => loadAuditKey(path)).toThrow(AuditKeyError);
    expect(() => loadAuditKey(path)).not.toThrow(/SECRETVALUE/);
  });
});

describe("AuditLog", () => {
  it("refuses to overwrite an existing log", () => {
    const { path: keyPath } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    writeFileSync(logPath, "earlier evidence\n");
    expect(() => AuditLog.create(logPath, loadAuditKey(keyPath))).toThrow(/already exists/);
    expect(readFileSync(logPath, "utf8")).toBe("earlier evidence\n");
  });

  it("writes each event as it happens, not at the end", () => {
    const { path: keyPath } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    const log = AuditLog.create(logPath, loadAuditKey(keyPath));
    log.open(MANDATE, CEILING);
    expect(lines(logPath)).toHaveLength(1);
    log.forwarded(1, {
      at: new Date().toISOString(), tool: "get_file_contents", paths: [], destinations: [],
    });
    expect(lines(logPath)).toHaveLength(2);
    expect(eventOf(lines(logPath)[1]!)).toMatchObject({ seq: 2, type: "forwarded", call: 1 });
  });

  it("chains each event to the line before it", () => {
    const { path: keyPath } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const ls = lines(logPath);
    expect(eventOf(ls[0]!)["prev"]).toBeNull();
    for (let i = 1; i < ls.length; i++) {
      expect(eventOf(ls[i]!)["prev"]).toBe(createHash("sha256").update(ls[i - 1]!).digest("hex"));
    }
  });

  it("gives each log its own session id, so two sessions never share a line", () => {
    const { path: keyPath } = keyFile();
    session(join(dir, "a.jsonl"), keyPath);
    session(join(dir, "b.jsonl"), keyPath);
    const ids = ["a", "b"].map((n) => eventOf(lines(join(dir, `${n}.jsonl`))[0]!)["session"]);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("embeds the mandate itself, its hash, the ceiling and the signing key", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    expect(eventOf(lines(logPath)[0]!)).toMatchObject({
      type: "open", format: AUDIT_FORMAT, keyId: auditKeyId(publicPem),
      mandateId: "fix-issue-42", mandateHash: mandateHash(MANDATE), ceiling: CEILING,
      mandate: MANDATE,
    });
  });

  // A call still in flight at the seal comes back after it. The seal is the
  // claim that the log is complete, so nothing may follow it.
  it("writes nothing after the seal, and says so", () => {
    const { path: keyPath } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    const errors: string[] = [];
    const log = AuditLog.create(logPath, loadAuditKey(keyPath), { onError: (m) => errors.push(m) });
    log.open(MANDATE, CEILING);
    log.seal();
    log.forwarded(1, { at: new Date().toISOString(), tool: "t", paths: [], destinations: [] });
    expect(lines(logPath).map((l) => eventOf(l)["type"])).toEqual(["open", "seal"]);
    expect(errors.join("")).toMatch(/after the log was sealed/);
  });

  // Audit is not authorisation: a logger that fails must not refuse a call.
  it("reports its first write failure once and then stops writing, without throwing", () => {
    const { path: keyPath } = keyFile();
    const errors: string[] = [];
    const written: string[] = [];
    let calls = 0;
    const log = AuditLog.create(join(dir, "audit.jsonl"), loadAuditKey(keyPath), {
      onError: (m) => errors.push(m),
      append: (l) => {
        calls++;
        if (calls === 2) throw new Error("ENOSPC: no space left on device");
        written.push(l);
      },
    });
    log.open(MANDATE, CEILING);
    expect(() => {
      log.forwarded(1, { at: new Date().toISOString(), tool: "t", paths: [], destinations: [] });
      log.forwarded(2, { at: new Date().toISOString(), tool: "t", paths: [], destinations: [] });
      log.seal();
    }).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ENOSPC.*no further events/);
    expect(written).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe("verifyAuditLog", () => {
  it("accepts an untouched sealed log and gives back the trace replay reads", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    const { recorder } = session(logPath, keyPath, { finish: true });
    const v = verifyAuditLog(readFileSync(logPath, "utf8"), publicPem);
    expect(v).toMatchObject({
      ok: true, sealed: true, mandateId: "fix-issue-42", mandateHash: mandateHash(MANDATE),
      unfinished: [],
    });
    if (!v.ok) return;
    expect(v.graph).toEqual(recorder.graph());
    expect(v.mandate).toEqual(MANDATE);
  });

  // The case completion-only recording loses: sent to GitHub, never answered.
  // A seal says the log is complete, not that the agent ran. A session whose
  // mint or upstream failed is sealed too, and must not read as one that ran.
  it("records why the log was sealed", () => {
    const { path: keyPath, publicPem } = keyFile();
    const ran = join(dir, "ran.jsonl");
    session(ran, keyPath);
    expect(verifyAuditLog(readFileSync(ran, "utf8"), publicPem)).toMatchObject({ sealedAs: "closed" });

    const never = join(dir, "never.jsonl");
    const log = AuditLog.create(never, loadAuditKey(keyPath));
    log.open(MANDATE, CEILING);
    log.seal("never-opened");
    expect(verifyAuditLog(readFileSync(never, "utf8"), publicPem))
      .toMatchObject({ ok: true, sealed: true, sealedAs: "never-opened" });
  });

  // An auditor handed the signing key by mistake must be told, not given a
  // clean verdict while holding the one file that can forge a log.
  it("refuses a private key given as the public key", () => {
    const { path: keyPath } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    expect(() => verifyAuditLog(readFileSync(logPath, "utf8"), readFileSync(keyPath, "utf8")))
      .toThrow(/private key/);
  });

  it("names a call that was forwarded and never completed", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const v = verifyAuditLog(readFileSync(logPath, "utf8"), publicPem);
    expect(v).toMatchObject({ ok: true, sealed: true });
    if (!v.ok) return;
    expect(v.unfinished).toHaveLength(1);
    expect(v.unfinished[0]).toMatchObject({ call: 2, tool: "get_file_contents", paths: ["src/b.ts"] });
  });

  // A killed process and a log whose tail was cut off look the same. Say so.
  it("accepts a log with no seal as intact but unsealed", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath, { seal: false });
    expect(verifyAuditLog(readFileSync(logPath, "utf8"), publicPem))
      .toMatchObject({ ok: true, sealed: false });
  });

  it("treats a final line cut off mid-write as unsealed, not as tampering", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const src = readFileSync(logPath, "utf8");
    const cut = src.slice(0, src.length - 20);
    expect(verifyAuditLog(cut, publicPem)).toMatchObject({ ok: true, sealed: false });
  });

  it("rejects an edited event", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const src = readFileSync(logPath, "utf8").replace("merge_pull_request", "get_me_pull_request");
    expect(verifyAuditLog(src, publicPem)).toMatchObject({
      ok: false, line: 4, reason: expect.stringMatching(/signature/),
    });
  });

  it("rejects a log with an event removed from the middle", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const ls = lines(logPath);
    rewrite(logPath, [...ls.slice(0, 2), ...ls.slice(3)]);
    expect(verifyAuditLog(readFileSync(logPath, "utf8"), publicPem)).toMatchObject({ ok: false, line: 3 });
  });

  it("rejects two events swapped", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const ls = lines(logPath);
    rewrite(logPath, [ls[0]!, ls[2]!, ls[1]!, ...ls.slice(3)]);
    expect(verifyAuditLog(readFileSync(logPath, "utf8"), publicPem)).toMatchObject({ ok: false, line: 2 });
  });

  it("rejects a log checked against a different key, naming both keys", () => {
    const { path: keyPath } = keyFile();
    const other = keyFile("other.pem");
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const v = verifyAuditLog(readFileSync(logPath, "utf8"), other.publicPem);
    expect(v).toMatchObject({ ok: false, line: 1 });
    if (v.ok) return;
    expect(v.reason).toContain(loadAuditKey(keyPath).keyId);
    expect(v.reason).toContain(auditKeyId(other.publicPem));
  });

  it("rejects anything after the seal", () => {
    const { path: keyPath, publicPem, privateKey } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    const ls = lines(logPath);
    forge(ls, { type: "forwarded", call: 9, at: new Date().toISOString(), tool: "t", paths: [], destinations: [] }, privateKey);
    expect(verifyAuditLog(ls.map((l) => `${l}\n`).join(""), publicPem))
      .toMatchObject({ ok: false, line: ls.length, reason: expect.stringMatching(/seal/) });
  });

  it("accepts a line forged from the format's description, so the format is what is checked", () => {
    const { publicPem, privateKey } = keyFile();
    const ls: string[] = [];
    forge(ls, {
      type: "open", format: AUDIT_FORMAT, at: new Date().toISOString(),
      keyId: auditKeyId(publicPem), session: "d".repeat(32), mandateId: MANDATE.mandate,
        mandateHash: mandateHash(MANDATE),
      mandate: MANDATE,
    }, privateKey);
    forge(ls, { type: "seal", at: new Date().toISOString(), reason: "closed" }, privateKey);
    expect(verifyAuditLog(ls.map((l) => `${l}\n`).join(""), publicPem))
      .toMatchObject({ ok: true, sealed: true });
  });

  it("rejects an open event whose mandate does not hash to the hash it states", () => {
    const { publicPem, privateKey } = keyFile();
    const ls: string[] = [];
    forge(ls, {
      type: "open", format: AUDIT_FORMAT, at: new Date().toISOString(),
      keyId: auditKeyId(publicPem), session: "d".repeat(32), mandateId: MANDATE.mandate,
      mandateHash: "b".repeat(64), mandate: MANDATE,
    }, privateKey);
    expect(verifyAuditLog(ls.map((l) => `${l}\n`).join(""), publicPem))
      .toMatchObject({ ok: false, line: 1, reason: expect.stringMatching(/hash/) });
  });

  it("rejects an allowed node that was never forwarded", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    const log = AuditLog.create(logPath, loadAuditKey(keyPath));
    log.open(MANDATE, CEILING);
    const node: ActionNode = {
      seq: 1, at: new Date().toISOString(), tool: "get_file_contents", action: "contents.read",
      paths: [], destinations: [], decision: "allow", outcome: "ok", outputBytes: 0, durationMs: 1,
    };
    log.completed(node, 1);
    expect(verifyAuditLog(readFileSync(logPath, "utf8"), publicPem))
      .toMatchObject({ ok: false, line: 2, reason: expect.stringMatching(/never forwarded/) });
  });

  it("rejects a log that does not start with an open event", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    rewrite(logPath, lines(logPath).slice(1));
    expect(verifyAuditLog(readFileSync(logPath, "utf8"), publicPem)).toMatchObject({ ok: false, line: 1 });
  });

  // seq alone catches a removed or swapped line. The chain is what catches a
  // line lifted from another log signed with the same key, at the same seq.
  it("rejects a line spliced in from another log signed with the same key", () => {
    const { path: keyPath, publicPem } = keyFile();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    session(a, keyPath);
    session(b, keyPath, { finish: true });
    const la = lines(a);
    const lb = lines(b);
    expect(la[2]).not.toBe(lb[2]);
    rewrite(a, [la[0]!, la[1]!, lb[2]!, ...la.slice(3)]);
    expect(verifyAuditLog(readFileSync(a, "utf8"), publicPem)).toMatchObject({
      ok: false, line: 3, reason: expect.stringMatching(/chain/),
    });
  });

  it("does not read garbage after a seal as a write cut off by a kill", () => {
    const { path: keyPath, publicPem } = keyFile();
    const logPath = join(dir, "audit.jsonl");
    session(logPath, keyPath);
    expect(verifyAuditLog(`${readFileSync(logPath, "utf8")}{"e":"tru`, publicPem))
      .toMatchObject({ ok: false, line: lines(logPath).length + 1 });
  });

  describe("rules a forged but correctly signed log must still meet", () => {
    const opened = (publicPem: string, privateKey: KeyObject): string[] => {
      const ls: string[] = [];
      forge(ls, {
        type: "open", format: AUDIT_FORMAT, at: new Date().toISOString(),
        keyId: auditKeyId(publicPem), session: "d".repeat(32), mandateId: MANDATE.mandate,
        mandateHash: mandateHash(MANDATE),
        mandate: MANDATE,
      }, privateKey);
      return ls;
    };
    const fwd = (call: number) => ({
      type: "forwarded", call, at: new Date().toISOString(), tool: "get_file_contents",
      paths: [], destinations: [],
    });
    const allowNode = (seq: number) => ({
      seq, at: new Date().toISOString(), tool: "get_file_contents", action: "contents.read",
      paths: [], destinations: [], decision: "allow", outcome: "ok", outputBytes: 0, durationMs: 1,
    });
    const check = (ls: string[], publicPem: string) =>
      verifyAuditLog(ls.map((l) => `${l}\n`).join(""), publicPem);

    it("a denied node cannot claim a forwarded call", () => {
      const { publicPem, privateKey } = keyFile();
      const ls = opened(publicPem, privateKey);
      forge(ls, fwd(1), privateKey);
      forge(ls, {
        type: "node", call: 1,
        node: {
          seq: 1, at: new Date().toISOString(), tool: "get_file_contents", paths: [], destinations: [],
          decision: "deny", clause: "mandate.grants", reason: "no", outputBytes: 0, durationMs: 0,
        },
      }, privateKey);
      expect(check(ls, publicPem)).toMatchObject({ ok: false, line: 3 });
    });

    it("one forwarded call has one node", () => {
      const { publicPem, privateKey } = keyFile();
      const ls = opened(publicPem, privateKey);
      forge(ls, fwd(1), privateKey);
      forge(ls, { type: "node", call: 1, node: allowNode(1) }, privateKey);
      forge(ls, { type: "node", call: 1, node: allowNode(2) }, privateKey);
      expect(check(ls, publicPem)).toMatchObject({ ok: false, line: 4, reason: expect.stringMatching(/second node/) });
    });

    it("events are numbered by line, even when the chain holds", () => {
      const { publicPem, privateKey } = keyFile();
      const ls = opened(publicPem, privateKey);
      const e = JSON.stringify({
        seq: 5, prev: createHash("sha256").update(ls[0]!).digest("hex"), ...fwd(1),
      });
      ls.push(JSON.stringify({
        e, sig: sign(null, Buffer.from(`${AUDIT_FORMAT}\n${e}`), privateKey).toString("base64"),
      }));
      expect(check(ls, publicPem)).toMatchObject({ ok: false, line: 2, reason: expect.stringMatching(/seq/) });
    });

    it("the first event is the open, not merely an event before it", () => {
      const { publicPem, privateKey } = keyFile();
      const ls: string[] = [];
      forge(ls, fwd(1), privateKey);
      expect(check(ls, publicPem)).toMatchObject({
        ok: false, line: 1, reason: expect.stringMatching(/open event/),
      });
    });

    it("the open event carries a valid mandate", () => {
      const { publicPem, privateKey } = keyFile();
      const ls: string[] = [];
      forge(ls, {
        type: "open", format: AUDIT_FORMAT, at: new Date().toISOString(),
        keyId: auditKeyId(publicPem), session: "d".repeat(32), mandateId: "x",
        mandateHash: "b".repeat(64),
        mandate: { mandate: "x" },
      }, privateKey);
      expect(check(ls, publicPem)).toMatchObject({
        ok: false, line: 1, reason: expect.stringMatching(/not a valid mandate/),
      });
    });

    it("there is one open event", () => {
      const { publicPem, privateKey } = keyFile();
      const ls = opened(publicPem, privateKey);
      const { seq: _seq, prev: _prev, ...again } = eventOf(ls[0]!);
      forge(ls, again, privateKey);
      expect(check(ls, publicPem)).toMatchObject({
        ok: false, line: 2, reason: expect.stringMatching(/second open/),
      });
    });

    it("forwarded calls are numbered without gaps", () => {
      const { publicPem, privateKey } = keyFile();
      const ls = opened(publicPem, privateKey);
      forge(ls, fwd(1), privateKey);
      forge(ls, fwd(3), privateKey);
      expect(check(ls, publicPem)).toMatchObject({ ok: false, line: 3 });
    });

    it("an allowed node names the call it finishes", () => {
      const { publicPem, privateKey } = keyFile();
      const ls = opened(publicPem, privateKey);
      forge(ls, fwd(1), privateKey);
      forge(ls, { type: "node", node: allowNode(1) }, privateKey);
      expect(check(ls, publicPem)).toMatchObject({
        ok: false, line: 3, reason: expect.stringMatching(/no forwarded call/),
      });
    });
  });

  it("rejects an empty log", () => {
    const { publicPem } = keyFile();
    expect(verifyAuditLog("", publicPem)).toMatchObject({ ok: false });
  });
});
