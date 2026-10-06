import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runValidate, type ValidateArgs } from "./validate.js";

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

const args = (over: Partial<ValidateArgs> = {}): ValidateArgs => ({
  file: ACCEPTED, ceiling: CEILING, schema: SCHEMA, destinations: DESTINATIONS,
  as: "alice", level: "push", color: false, ...over,
});

const run = (over: Partial<ValidateArgs> = {}): { code: number; out: string } => {
  const chunks: string[] = [];
  const code = runValidate(args(over), (s) => chunks.push(s));
  return { code, out: chunks.join("\n") };
};

describe("runValidate exit codes", () => {
  it("accepts a mandate inside the ceiling with 0", () => {
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("AUTHORITY CUT");
  });

  it("rejects an over-grant with 1 and names the clause", () => {
    const { code, out } = run({ file: fixture("overgrants/branch-wider-than-ceiling.yaml") });
    expect(code).toBe(1);
    expect(out).toContain("Mandate rejected");
    expect(out).toContain("allow-agent-branch-writes");
    expect(out).toContain("Nothing was minted");
  });

  // Separate from a rejection on purpose: "I could not read your file" and
  // "your mandate grants too much" are different answers and a script needs to
  // tell them apart.
  it("reports unreadable input as 2, not as a rejection", () => {
    const { code, out } = run({ file: join(tmp, "does-not-exist.yaml") });
    expect(code).toBe(2);
    expect(out).toContain("Could not read a mandate");
  });

  it("reports malformed YAML as 2", () => {
    const { code } = run({ file: write("bad.yaml", "grants: [oh dear\n") });
    expect(code).toBe(2);
  });

  it("reports a mandate that is not schema-valid as 2", () => {
    const { code, out } = run({ file: write("notmandate.yaml", "mandate: x\n") });
    expect(code).toBe(2);
    expect(out).toContain("Could not read a mandate");
  });

  it("reports an unloadable ceiling as 2", () => {
    const { code, out } = run({ ceiling: join(tmp, "nope.cedar") });
    expect(code).toBe(2);
    expect(out).toContain("Could not load the ceiling");
  });

  // Without this, an unrecognised --level silently compares as an unknown
  // string, atLeast() returns false for everything, and every grant is
  // rejected for "user authority" with no hint that the flag was the problem.
  it("rejects an unknown --level as bad input rather than failing every grant", () => {
    const { code, out } = run({ level: "pushh" as ValidateArgs["level"] });
    expect(code).toBe(2);
    expect(out).toContain("--level must be one of");
  });

  it("enforces the user's own authority, so push cannot mint an admin grant", () => {
    const { code, out } = run({ level: "pull" });
    expect(code).toBe(1);
    expect(out).toContain("user-authority");
  });

  it("passes the repository count through to the authority-cut baseline", () => {
    expect(run({ repositories: 20 }).out).toContain("of 620 operation-repository pairs");
  });
});
