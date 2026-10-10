import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ceilingSha256, type UserAuthority } from "@mandate-dev/validator";
import { runValidate, type ValidateArgs, type ResolveAuthority } from "./validate.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));

const CEILING = fixture("ceilings/org-policy-v12.cedar");
const SCHEMA = fixture("ceilings/schema.cedarschema");
const DESTINATIONS = fixture("ceilings/org-policy-v12.destinations");

const tmp = mkdtempSync(join(tmpdir(), "mandate-cli-"));
const write = (name: string, body: string): string => {
  const path = join(tmp, name);
  writeFileSync(path, body, "utf8");
  return path;
};

const ACCEPTED = write("good.yaml", `
mandate: fix-issue-42
task: "Fix issue #42 and open a PR"
requestedBy: user:alice
expiresInMinutes: 30
ceiling: org-policy@v12
grants:
  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }
  - { action: branch.create, enforcedBy: proxy, resources: ["acme/api"], branches: ["agent/42-fix"] }
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-fix"]
    paths: ["src/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
  - action: pull_request.create
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-fix"]
    base: main
    max: 1
destinations:
  allow: ["github.com/acme/api"]
`);

/**
 * `exactOptionalPropertyTypes` is on, so a test that means "no --level at all"
 * cannot say `{ level: undefined }` against `Partial<ValidateArgs>`. Spelling
 * the override type out here keeps that distinction expressible, which matters:
 * "absent" and "present but empty" are different inputs to the authority
 * decision and both are tested.
 */
type Override = { [K in keyof ValidateArgs]?: ValidateArgs[K] | undefined };

const args = (over: Override = {}): ValidateArgs => {
  // `level` and `repo` are spread conditionally rather than merged, because
  // under exactOptionalPropertyTypes an explicitly-undefined optional is not
  // the same as an absent one — and "no authority flag at all" is a case the
  // tests below need to express.
  const level = "level" in over ? over.level : "push";
  const repo = "repo" in over ? over.repo : undefined;
  return {
    file: over.file ?? ACCEPTED,
    ceiling: over.ceiling ?? CEILING,
    schema: over.schema ?? SCHEMA,
    destinations: over.destinations ?? DESTINATIONS,
    as: over.as ?? "alice",
    color: over.color ?? false,
    ...(over.repositories === undefined ? {} : { repositories: over.repositories }),
    ...(level === undefined ? {} : { level }),
    ...(repo === undefined ? {} : { repo }),
  };
};

const runAsync = async (
  over: Override = {}, resolve?: ResolveAuthority,
): Promise<{ code: number; out: string }> => {
  const chunks: string[] = [];
  const code = await runValidate(
    args(over), (s) => chunks.push(s), resolve === undefined ? undefined : { resolve },
  );
  return { code, out: chunks.join("\n") };
};

describe("runValidate exit codes", () => {
  it("accepts a mandate inside the ceiling with 0", async () => {
    const { code, out } = await runAsync();
    expect(code).toBe(0);
    expect(out).toContain("AUTHORITY CUT");
  });

  it("rejects an over-grant with 1 and names the clause", async () => {
    const { code, out } = await runAsync({ file: fixture("overgrants/branch-wider-than-ceiling.yaml") });
    expect(code).toBe(1);
    expect(out).toContain("Mandate rejected");
    expect(out).toContain("allow-agent-branch-writes");
    expect(out).toContain("Nothing was minted");
  });

  // Separate from a rejection on purpose: "I could not read your file" and
  // "your mandate grants too much" are different answers and a script needs to
  // tell them apart.
  it("reports unreadable input as 2, not as a rejection", async () => {
    const { code, out } = await runAsync({ file: join(tmp, "does-not-exist.yaml") });
    expect(code).toBe(2);
    expect(out).toContain("Could not read a mandate");
  });

  it("reports malformed YAML as 2", async () => {
    const { code } = await runAsync({ file: write("bad.yaml", "grants: [oh dear\n") });
    expect(code).toBe(2);
  });

  it("reports a mandate that is not schema-valid as 2", async () => {
    const { code, out } = await runAsync({ file: write("notmandate.yaml", "mandate: x\n") });
    expect(code).toBe(2);
    expect(out).toContain("Could not read a mandate");
  });

  it("reports an unloadable ceiling as 2", async () => {
    const { code, out } = await runAsync({ ceiling: join(tmp, "nope.cedar") });
    expect(code).toBe(2);
    expect(out).toContain("Could not load the ceiling");
  });

  // Without this, an unrecognised --level silently compares as an unknown
  // string, atLeast() returns false for everything, and every grant is
  // rejected for "user authority" with no hint that the flag was the problem.
  it("rejects an unknown --level as bad input rather than failing every grant", async () => {
    const { code, out } = await runAsync({ level: "pushh" as ValidateArgs["level"] });
    expect(code).toBe(2);
    expect(out).toContain("--level must be one of");
  });

  it("enforces the user's own authority, so push cannot mint an admin grant", async () => {
    const { code, out } = await runAsync({ level: "pull" });
    expect(code).toBe(1);
    expect(out).toContain("user-authority");
  });

  it("passes the repository count through to the authority-cut baseline", async () => {
    expect((await runAsync({ repositories: 20 })).out).toContain("of 620 operation-repository pairs");
  });
});

/**
 * Where the user's level comes from (D2's user-authority half, R3).
 *
 * `--level` used to default to `push`, so every local run silently asserted
 * push authority with nothing in the output saying it was an assertion. That is
 * the gap the Phase 3 handoff called "the largest remaining hole in the trust
 * story": the output read like an authorisation record and was not one.
 *
 * The fix is not a louder banner. It is that the operator must say which they
 * mean — `--repo`, which looks the level up on GitHub, or `--level`, which
 * asserts it — and that the output records which was used. Supplying both is
 * ambiguous, and ambiguous authority is doubt, so it is refused.
 */
describe("runValidate — where the user's level comes from", () => {
  const PUSH: UserAuthority = { login: "alice", level: "push" };

  it("refuses to run with neither --repo nor --level", async () => {
    const { code, out } = await runAsync({ level: undefined });
    expect(code).toBe(2);
    expect(out).toContain("--repo");
    expect(out).toContain("--level");
  });

  it("refuses both at once rather than picking one", async () => {
    const { code, out } = await runAsync({ level: "push", repo: "acme/api" });
    expect(code).toBe(2);
    expect(out).toMatch(/both|only one/i);
  });

  it("labels an asserted level as unverified in the output", async () => {
    const { code, out } = await runAsync({ level: "push" });
    expect(code).toBe(0);
    expect(out).toMatch(/not verified|unverified/i);
    expect(out).toContain("--level");
  });

  it("labels a looked-up level as verified, and names the repository", async () => {
    const { code, out } = await runAsync(
      { level: undefined, repo: "acme/api" },
      async () => PUSH,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/verified/i);
    expect(out).not.toMatch(/not verified|unverified/i);
    expect(out).toContain("acme/api");
  });

  it("uses the looked-up level to decide, not the one the operator wanted", async () => {
    // The lookup says pull. The mandate needs push. It must be rejected, which
    // is the entire point of wiring this in.
    const { code, out } = await runAsync(
      { level: undefined, repo: "acme/api" },
      async () => ({ login: "alice", level: "pull" }),
    );
    expect(code).toBe(1);
    expect(out).toContain("user-authority");
  });

  it("asks about the login given to --as, on the repository given to --repo", async () => {
    const seen: { repo?: string; login?: string } = {};
    await runAsync(
      { level: undefined, repo: "acme/api", as: "bob" },
      async (repo, login) => { seen.repo = repo; seen.login = login; return PUSH; },
    );
    expect(seen).toEqual({ repo: "acme/api", login: "bob" });
  });

  // fetchUserAuthority already resolves `none` on any failure. The CLI must not
  // then paper over it: a lookup that could not be made is not an authorisation.
  it("rejects when the lookup resolves none, and says the lookup is why", async () => {
    const { code, out } = await runAsync(
      { level: undefined, repo: "acme/api" },
      async () => ({ login: "alice", level: "none" }),
    );
    expect(code).toBe(1);
    expect(out).toContain("user-authority");
    expect(out).toMatch(/no access|level none|could not/i);
  });

  it("reports a resolver that throws as 2 rather than falling back to a level", async () => {
    const { code, out } = await runAsync(
      { level: undefined, repo: "acme/api" },
      async () => { throw new Error("no credentials configured"); },
    );
    expect(code).toBe(2);
    expect(out).toContain("no credentials configured");
  });

  it("still rejects an unknown --level as bad input", async () => {
    const { code, out } = await runAsync({ level: "pushh" });
    expect(code).toBe(2);
    expect(out).toContain("--level must be one of");
  });
});

// Task 5.3. The shipped CLI labelled the operator's ceiling with the id the
// MANDATE declared, so the adversarial case whose issue text names its own
// policy "attacker-policy@v1" had the CLI print `ceiling clause:
// attacker-policy@v1.destinations` about a check run against
// org-policy-v12.cedar. The adversarial suite said the label was never read,
// because its harness labelled the ceiling itself; this goes through the
// shipped path.
describe("which ceiling the output names", () => {
  const PASTED = fixture("adversarial/mandates/pasted-cedar-permit.yaml");
  const sha = ceilingSha256(
    readFileSync(CEILING, "utf8"), readFileSync(SCHEMA, "utf8"), readFileSync(DESTINATIONS, "utf8"),
  );

  it("names the operator's ceiling file and its hash", async () => {
    const { code, out } = await runAsync({ file: PASTED });
    expect(code).toBe(0);
    expect(out).toContain(`Ceiling: org-policy-v12.cedar, sha256:${sha}`);
  });

  it("shows the mandate's ceiling name only as an unchecked claim", async () => {
    const { out } = await runAsync({ file: PASTED });
    expect(out).toMatch(/names its ceiling "attacker-policy@v1".*claim/);
    expect(out).not.toMatch(/Ceiling: attacker-policy@v1/);
    expect(out).not.toContain("(ceiling attacker-policy@v1)");
  });

  it("names the operator's ceiling in a rejection's clause, never the mandate's", async () => {
    const evil = write("pasted-evil.yaml", readFileSync(PASTED, "utf8")
      .replace(/allow: \[.*\]/, 'allow: ["evil.example.com"]'));
    const { code, out } = await runAsync({ file: evil });
    expect(code).toBe(1);
    expect(out).toContain("org-policy-v12.cedar.destinations");
    expect(out).not.toContain("attacker-policy@v1.destinations");
  });
});
