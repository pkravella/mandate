import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the npm packages say about themselves (Task 9.1).
 *
 * `scripts/pack-check.mjs` proves the tarballs from outside the workspace, but
 * it needs the registry and runs as its own CI job. These are the same
 * properties read from the checkout, so `pnpm test` catches a regression first.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const REPOSITORY_URL = "git+https://github.com/pkravella/mandate.git";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly repository?: { type?: string; url?: string; directory?: string };
  readonly homepage?: string;
  readonly bugs?: { url?: string };
  readonly publishConfig?: { access?: string };
  readonly dependencies?: Record<string, string>;
}

const all = readdirSync(root("packages")).map((dir) => ({
  dir, json: JSON.parse(readFileSync(root(`packages/${dir}/package.json`), "utf8")) as Manifest,
}));
const published = all.filter((p) => p.json.private !== true);

describe("the published packages", () => {
  it("are the eight the owner chose, and bench is not one of them", () => {
    expect(published.map((p) => p.json.name).sort()).toEqual([
      "@leastpilot/catalog", "@leastpilot/cli", "@leastpilot/compiler", "@leastpilot/proxy",
      "@leastpilot/replay", "@leastpilot/schema", "@leastpilot/validator", "@leastpilot/writer",
    ]);
    expect(all.find((p) => p.dir === "bench")?.json.private).toBe(true);
  });

  // The CLI pins its siblings exactly, so they ship together at one version.
  it("share one version", () => {
    expect(new Set(published.map((p) => p.json.version)).size).toBe(1);
  });

  // npm provenance checks repository.url against the repository that built
  // the package, and the npm page links it.
  it.each(published.map((p) => [p.json.name, p] as const))("%s names its repository", (_n, p) => {
    expect(p.json.repository).toEqual({ type: "git", url: REPOSITORY_URL, directory: `packages/${p.dir}` });
    expect(p.json.homepage).toBe(`https://github.com/pkravella/mandate/tree/main/packages/${p.dir}#readme`);
    expect(p.json.bugs?.url).toBe("https://github.com/pkravella/mandate/issues");
  });

  // A scoped package is restricted by default; publishing one public needs this.
  it.each(published.map((p) => [p.json.name, p] as const))("%s publishes public", (_n, p) => {
    expect(p.json.publishConfig?.access).toBe("public");
  });

  // Apache-2.0 §4(d): the NOTICE travels with the work. npm adds README and
  // LICENSE to a tarball on its own; NOTICE only ships if `files` names it.
  it.each(published.map((p) => [p.json.name, p] as const))("%s ships a README and the NOTICE", (_n, p) => {
    expect(existsSync(root(`packages/${p.dir}/README.md`))).toBe(true);
    expect(p.json.files).toContain("NOTICE");
    expect(readFileSync(root(`packages/${p.dir}/NOTICE`), "utf8")).toBe(readFileSync(root("NOTICE"), "utf8"));
  });
});

describe("leastpilot --version", () => {
  // It was a string literal in index.ts, so bumping package.json would have
  // published a binary that reports the version before.
  it("reports the CLI package's own version", () => {
    const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    if (!existsSync(bin)) throw new Error(`${bin} is missing; run \`pnpm build\` first`);
    const r = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    const cli = published.find((p) => p.dir === "cli");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(cli?.json.version);
  });
});
