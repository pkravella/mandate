import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runExportGhAw } from "./export.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "mandate-export-test-"));
const write = (name: string, body: string): string => {
  const path = join(tmp, name);
  writeFileSync(path, body, "utf8");
  return path;
};

const FIX = write("fix.yaml", `
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
  allow: ["github.com/acme/api", "api.github.com"]
`);

const READ_ONLY = write("read-only.yaml", `
mandate: look-at-issue-42
task: "Look at issue #42"
requestedBy: user:alice
expiresInMinutes: 30
ceiling: org-policy@v12
grants:
  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }
destinations:
  allow: ["github.com/acme/api"]
`);

const run = async (file: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runExportGhAw({
    file, ceiling: fixture("ceilings/org-policy-v12.cedar"),
    schema: fixture("ceilings/schema.cedarschema"),
    destinations: fixture("ceilings/org-policy-v12.destinations"),
    as: "alice", level: "push",
  }, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
};

/** The YAML between the two `---` lines. */
const frontmatter = (out: string): Record<string, unknown> => {
  const m = /^---\n([\s\S]*?)\n---\n?$/.exec(out);
  if (m === null) throw new Error(`not a frontmatter block:\n${out}`);
  return parse(m[1] ?? "") as Record<string, unknown>;
};

describe("mandate export gh-aw", () => {
  it("prints a workflow frontmatter block that parses, and exits 0", async () => {
    const { code, out } = await run(FIX);
    expect(code).toBe(0);
    const fm = frontmatter(out);
    expect(fm["on"]).toEqual({ workflow_dispatch: null });
    expect(fm).toMatchObject({
      "safe-outputs": { "create-pull-request": { "allowed-files": ["src/**"], "base-branch": "main", max: 1 } },
      tools: { github: { "read-only": true, "allowed-repos": ["acme/api"] } },
    });
  });

  // The record of where it came from, in the file someone will commit and
  // review: which mandate, which ceiling, which gh-aw, and what it narrowed.
  it("says in the file which mandate, ceiling and gh-aw version it came from, and what is narrower", async () => {
    const { out } = await run(FIX);
    expect(out).toMatch(/^# .*mandate fix-issue-42 \(sha256 [0-9a-f]{64}\)/m);
    expect(out).toMatch(/^# .*ceiling org-policy-v12\.cedar \(sha256 [0-9a-f]{64}\)/m);
    expect(out).toMatch(/^# .*gh-aw v0\.89\.21/m);
    // --level was used: the file must not read as an authorisation record.
    expect(out).toMatch(/^# .*asserted, not verified/m);
    expect(out).toMatch(/^# .*commit .*acme\/api/im);
    expect(out).toMatch(/^# .*protected-files/m);
    expect(out).toMatch(/^# .*trigger/im);
    expect(out).toMatch(/^# Not from the mandate:\n#   - network: defaults/m);
  });

  // gh-aw's schema rejects unknown keys; a key it does not know makes the
  // workflow fail to compile. Checked against its schema at the pinned tag.
  it("writes only keys gh-aw v0.89.21's schema accepts", async () => {
    const keys = JSON.parse(readFileSync(fixture("gh-aw/v0.89.21/frontmatter-keys.json"), "utf8")) as Record<string, string[]>;
    const fm = frontmatter((await run(FIX)).out);
    const check = (o: unknown, path: string): void => {
      if (o === null || typeof o !== "object" || Array.isArray(o)) return;
      const allowed = keys[path];
      if (allowed === undefined) return;
      for (const [k, v] of Object.entries(o)) {
        expect(allowed, `${path || "(top level)"}.${k}`).toContain(k);
        check(v, path === "" ? k : `${path}.${k}`);
      }
    };
    check(fm, "");
    const pr = (fm["safe-outputs"] as Record<string, Record<string, unknown>>)["create-pull-request"];
    expect(keys["enum:safe-outputs.create-pull-request.protected-files"]).toContain(pr?.["protected-files"]);
    expect(keys["enum:network"]).toContain(fm["network"]);
  });

  it("exits 1 for a mandate the validator refuses, printing no workflow", async () => {
    const { code, out, err } = await run(fixture("overgrants/base-not-main.yaml"));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/rejected/i);
  });

  it("exits 1 for a mandate gh-aw cannot hold, naming why, printing no workflow", async () => {
    const { code, out, err } = await run(READ_ONLY);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/create-issue/);
    expect(err).toMatch(/Nothing was exported/);
  });

  it("exits 2 when the mandate cannot be read", async () => {
    expect((await run(join(tmp, "missing.yaml"))).code).toBe(2);
  });
});
