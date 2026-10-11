import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditLog, auditKeyId, loadAuditKey, Recorder } from "@mandate-dev/proxy";
import { mandateHash, type Mandate } from "@mandate-dev/schema";
import { runAuditKeygen, runAuditVerify } from "./audit.js";

const tmp = mkdtempSync(join(tmpdir(), "mandate-audit-cli-"));
let n = 0;
const fresh = (name: string): string => join(tmp, `${++n}-${name}`);

const MANDATE: Mandate = {
  mandate: "fix-issue-42", task: "Fix issue #42", requestedBy: "user:alice",
  expiresInMinutes: 30, ceiling: "org-policy@v12",
  grants: [{ action: "contents.read", enforcedBy: "token", resources: ["acme/api"] }],
  destinations: { allow: [] },
};

const run = async <A>(f: (a: A, log: (s: string) => void) => Promise<number> | number, a: A) => {
  const out: string[] = [];
  const code = await f(a, (s) => out.push(s));
  return { code, out: out.join("\n") };
};

/** A key made by `audit keygen`, and a log written with it. */
async function keyAndLog(opts: { seal?: boolean; inFlight?: boolean } = {}) {
  const key = fresh("audit.pem");
  const pub = fresh("audit.pub");
  const made = await run(runAuditKeygen, { out: key, publicOut: pub });
  expect(made.code).toBe(0);
  const log = fresh("audit.jsonl");
  const sink = AuditLog.create(log, loadAuditKey(key));
  sink.open(MANDATE, { label: "org-policy-v12.cedar", sha256: "c".repeat(64) });
  const r = new Recorder({ mode: "enforced", mandateId: MANDATE.mandate, mandateHash: mandateHash(MANDATE) }, sink);
  r.recordCall({ tool: "get_file_contents", action: "contents.read", args: { owner: "acme", repo: "api", path: "a" } })
    .completed({ content: [] });
  r.recordDenial({
    tool: "merge_pull_request", args: {},
    decision: { kind: "deny", tool: "merge_pull_request", clause: "mandate.grants", reason: "no" },
  });
  if (opts.inFlight === true) {
    r.recordCall({ tool: "create_or_update_file", action: "contents.write", args: { owner: "acme", repo: "api", path: "src/x.ts" } });
  }
  if (opts.seal !== false) sink.seal();
  return { key, pub, log };
}

describe("mandate audit keygen", () => {
  it("writes an Ed25519 private key only its owner can read, and the public key beside it", async () => {
    const key = fresh("k.pem");
    const pub = fresh("k.pub");
    const { code, out } = await run(runAuditKeygen, { out: key, publicOut: pub });
    expect(code).toBe(0);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const loaded = loadAuditKey(key);
    expect(auditKeyId(readFileSync(pub, "utf8"))).toBe(loaded.keyId);
    expect(createPublicKey(readFileSync(pub, "utf8")).asymmetricKeyType).toBe("ed25519");
    expect(out).toContain(loaded.keyId);
    expect(out).toContain("MANDATE_AUDIT_KEY_PATH");
  });

  it("never overwrites an existing key", async () => {
    const key = fresh("k.pem");
    writeFileSync(key, "an existing key\n");
    const { code, out } = await run(runAuditKeygen, { out: key, publicOut: fresh("k.pub") });
    expect(code).toBe(2);
    expect(out).toMatch(/already exists/);
    expect(readFileSync(key, "utf8")).toBe("an existing key\n");
  });

  it("writes neither file when the public one cannot be written", async () => {
    const key = fresh("k.pem");
    const pub = fresh("k.pub");
    writeFileSync(pub, "taken\n");
    const { code } = await run(runAuditKeygen, { out: key, publicOut: pub });
    expect(code).toBe(2);
    expect(existsSync(key)).toBe(false);
  });
});

describe("mandate audit verify", () => {
  it("exits 0 for an intact, sealed log and says what it records", async () => {
    const { pub, log } = await keyAndLog();
    const { code, out } = await run(runAuditVerify, { file: log, publicKey: pub });
    expect(code).toBe(0);
    expect(out).toMatch(/Intact/);
    expect(out).toMatch(/Sealed/);
    expect(out).toContain("fix-issue-42");
    expect(out).toMatch(/2 decision\(s\): 1 allowed, 1 denied/);
    expect(out).toContain("org-policy-v12.cedar");
  });

  it("exits 1 for an unsealed log and says a kill and a truncation look the same", async () => {
    const { pub, log } = await keyAndLog({ seal: false });
    const { code, out } = await run(runAuditVerify, { file: log, publicKey: pub });
    expect(code).toBe(1);
    expect(out).toMatch(/Not sealed/);
    expect(out).toMatch(/killed.*cut off|cut off.*killed/);
  });

  it("names calls sent to GitHub that never completed", async () => {
    const { pub, log } = await keyAndLog({ inFlight: true });
    const { code, out } = await run(runAuditVerify, { file: log, publicKey: pub });
    expect(code).toBe(0);
    expect(out).toMatch(/1 call\(s\) were sent to GitHub and never completed/);
    expect(out).toContain("create_or_update_file");
    expect(out).toContain("src/x.ts");
  });

  it("exits 1 and names the line for a tampered log", async () => {
    const { pub, log } = await keyAndLog();
    writeFileSync(log, readFileSync(log, "utf8").replace("merge_pull_request", "merge_pull_requesx"));
    const { code, out } = await run(runAuditVerify, { file: log, publicKey: pub });
    expect(code).toBe(1);
    expect(out).toMatch(/line 4/);
    expect(out).not.toMatch(/Intact/);
  });

  it("exits 2 for a public key that is not one", async () => {
    const { log } = await keyAndLog();
    const bad = fresh("bad.pub");
    writeFileSync(bad, "nope\n");
    expect((await run(runAuditVerify, { file: log, publicKey: bad })).code).toBe(2);
    const rsa = fresh("rsa.pub");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ type: "spki", format: "pem" }).toString());
    expect((await run(runAuditVerify, { file: log, publicKey: rsa })).code).toBe(2);
  });

  it("exits 2 for a log that cannot be read", async () => {
    const { pub } = await keyAndLog();
    expect((await run(runAuditVerify, { file: fresh("missing.jsonl"), publicKey: pub })).code).toBe(2);
  });
});
