import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
}
interface Job {
  readonly permissions?: unknown;
  readonly environment?: unknown;
  readonly steps: readonly Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions?: unknown;
  readonly jobs: Record<string, Job>;
}
const workflow = (name: string): Workflow =>
  parse(readFileSync(root(`.github/workflows/${name}`), "utf8")) as Workflow;
const indexOf = (steps: readonly Step[], pred: (s: Step) => boolean): number => steps.findIndex(pred);

describe("the pack check in CI", () => {
  // The only check that sees what npm users get; nothing else runs it.
  it("runs scripts/pack-check.mjs after a build, on the engines floor too", () => {
    const ci = workflow("ci.yml");
    const job = Object.values(ci.jobs).find((j) => j.steps.some((s) => s.run?.includes("scripts/pack-check.mjs")));
    expect(job).toBeDefined();
    const steps = job?.steps ?? [];
    const build = indexOf(steps, (s) => s.run === "pnpm build");
    const check = indexOf(steps, (s) => s.run?.includes("scripts/pack-check.mjs") ?? false);
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    const matrix = (job as unknown as { strategy?: { matrix?: { node?: unknown[] } } }).strategy?.matrix?.node;
    expect(matrix).toContain(22);
  });
});

/**
 * .github/workflows/release.yml, checked as data: it runs once per release,
 * and a mistake in it is either a publish that should not have happened or a
 * credential with more reach than it needs. Nothing else exercises it before
 * the owner pushes a tag.
 */
describe("the release workflow", () => {
  const release = workflow("release.yml");
  const jobs = Object.values(release.jobs);
  const publishJob = jobs.find((j) => j.steps.some((s) => s.run?.includes("scripts/publish.mjs")));
  const steps = publishJob?.steps ?? [];

  it("runs only on a version tag", () => {
    expect(Object.keys(release.on)).toEqual(["push"]);
    expect(release.on["push"]).toEqual({ tags: ["v*.*.*"] });
  });

  // npm trusted publishing exchanges the job's OIDC token for a publish
  // credential, so id-token: write is the one write this job needs.
  it("grants nothing by default and the publish job exactly contents: read and id-token: write", () => {
    expect(release.permissions).toEqual({});
    expect(publishJob?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  // The trusted publisher on npmjs.com names this environment, so a run
  // outside it gets no credential; protection rules on it are the owner's.
  it("publishes from the npm environment", () => {
    expect(publishJob?.environment).toBe("npm");
  });

  it("pins every action to a commit", () => {
    expect(steps.filter((s) => s.uses !== undefined).length).toBeGreaterThan(0);
    for (const s of jobs.flatMap((j) => j.steps)) {
      if (s.uses !== undefined) expect(s.uses, s.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  it("never interpolates an expression into a run block", () => {
    expect(steps.filter((s) => s.run !== undefined).length).toBeGreaterThan(0);
    for (const s of jobs.flatMap((j) => j.steps)) {
      if (s.run !== undefined) expect(s.run, s.name ?? "?").not.toMatch(/\$\{\{/);
    }
  });

  it("checks out without leaving a credential in .git/config", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("refuses a tag that is not on main, and one that disagrees with the packages, before anything else", () => {
    const onMain = indexOf(steps, (s) => s.run?.includes("merge-base --is-ancestor") ?? false);
    const matches = indexOf(steps, (s) => s.run?.includes("scripts/release-version.mjs") ?? false);
    const firstInstall = indexOf(steps, (s) => s.run?.includes("pnpm install") ?? false);
    expect(onMain).toBeGreaterThan(-1);
    expect(matches).toBeGreaterThan(-1);
    expect(onMain).toBeLessThan(firstInstall);
    expect(matches).toBeLessThan(firstInstall);
  });

  it("runs the gate and the pack check before it publishes", () => {
    const publish = indexOf(steps, (s) => s.run?.includes("scripts/publish.mjs") ?? false);
    for (const cmd of ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build"]) {
      const at = indexOf(steps, (s) => s.run === cmd);
      expect(at, cmd).toBeGreaterThan(-1);
      expect(at, cmd).toBeLessThan(publish);
    }
    const pack = indexOf(steps, (s) => s.run?.includes("scripts/pack-check.mjs") ?? false);
    expect(pack).toBeGreaterThan(-1);
    expect(pack).toBeLessThan(publish);
  });

  // One pack, checked and then published: a second pack could differ from
  // what the pack check installed and ran.
  it("publishes the tarballs the pack check checked", () => {
    const pack = steps.find((s) => s.run?.includes("scripts/pack-check.mjs"))?.run ?? "";
    const publish = steps.find((s) => s.run?.includes("scripts/publish.mjs"))?.run ?? "";
    const out = /pack-check\.mjs --out (\S+)/.exec(pack)?.[1];
    expect(out).toBeDefined();
    expect(publish.trim()).toBe(`node scripts/publish.mjs ${out}`);
    expect(steps.some((s) => /pnpm (pack|publish)|npm publish/.test(s.run ?? ""))).toBe(false);
  });

  // Trusted publishing needs npm 11.5.1 or later; Node 24.1 ships 11.3.0.
  it("installs an exact npm that trusted publishing supports", () => {
    const npm = steps.find((s) => /npm install -g npm@/.test(s.run ?? ""));
    const version = /npm@(\d+)\.(\d+)\.(\d+)(\s|$)/.exec(npm?.run ?? "");
    expect(version, "npm must be pinned to an exact version").not.toBeNull();
    const [maj, min, pat] = version!.slice(1, 4).map(Number) as [number, number, number];
    expect(maj > 11 || (maj === 11 && (min > 5 || (min === 5 && pat >= 1)))).toBe(true);
  });
});

/**
 * scripts/publish.mjs, run for real against a stand-in npm on PATH.
 *
 * The CLI pins its siblings exactly, so a release is all eight or a broken
 * CLI. If the workflow fails part-way some versions exist and others do not;
 * the remedy is to re-run it, never to bump only the failed ones, so the
 * script must skip what is already published and stop at the first failure.
 */
const SCRIPT = root("scripts/publish.mjs");
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
const list = (v) => (process.env[v] ?? "").split(",").filter(Boolean);
if (args[0] === "view") {
  const name = args[1].slice(0, args[1].lastIndexOf("@"));
  if (list("FAKE_NPM_VIEW_ERROR").includes(name)) {
    console.log(JSON.stringify({ error: { code: "ECONNRESET", summary: "socket hang up" } }));
    process.exit(1);
  }
  if (list("FAKE_NPM_PUBLISHED").includes(name)) { console.log(JSON.stringify("0.2.0")); process.exit(0); }
  console.log(JSON.stringify({ error: { code: "E404", summary: "No match found" } }));
  process.exit(1);
}
if (args[0] === "publish") {
  const failing = list("FAKE_NPM_PUBLISH_FAIL").some((n) => args[1].includes(n.replace("@", "").replace("/", "-") + "-"));
  process.exit(failing ? 1 : 0);
}
process.exit(2);
`;

interface PublishRun { status: number | null; stderr: string; calls: string[][] }
function publishRun(env: Record<string, string> = {}, omit: string[] = []): PublishRun {
  const dir = mkdtempSync(join(tmpdir(), "leastpilot-publish-test-"));
  const bin = join(dir, "bin");
  const tgz = join(dir, "tgz");
  for (const d of [bin, tgz]) mkdirSync(d);
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  chmodSync(join(bin, "npm"), 0o755);
  for (const p of published) {
    const file = `${p.json.name.replace("@", "").replace("/", "-")}-${p.json.version}.tgz`;
    if (!omit.includes(p.json.name)) writeFileSync(join(tgz, file), "");
  }
  const log = join(dir, "npm.log");
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, [SCRIPT, tgz], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_NPM_LOG: log, ...env },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  return { status: r.status, stderr: r.stderr, calls };
}
const publishedNames = (calls: string[][]): string[] =>
  calls.filter((c) => c[0] === "publish").map((c) => /\/leastpilot-([a-z]+)-\d[^/]*\.tgz$/.exec(c[1] ?? "")![1]!);

describe("scripts/publish.mjs", () => {
  it("publishes all eight, each after every package it depends on", () => {
    const r = publishRun();
    expect(r.status, r.stderr).toBe(0);
    const order = publishedNames(r.calls);
    expect(order.sort()).toEqual(published.map((p) => p.dir).sort());
    const again = publishedNames(publishRun().calls);
    for (const p of published) {
      for (const dep of Object.keys(p.json.dependencies ?? {}).filter((d) => d.startsWith("@leastpilot/"))) {
        expect(again.indexOf(dep.slice("@leastpilot/".length)), `${dep} before ${p.json.name}`)
          .toBeLessThan(again.indexOf(p.dir));
      }
    }
  });

  // --provenance makes a run that cannot attest fail, instead of publishing
  // without the attestation the exit criterion asks for.
  it("publishes each tarball public, with provenance, under the default tag", () => {
    const pub = publishRun().calls.filter((c) => c[0] === "publish");
    expect(pub).toHaveLength(published.length);
    for (const c of pub) {
      expect(c.slice(2)).toEqual(["--access", "public", "--provenance"]);
      expect(c[1]).toMatch(/\.tgz$/);
    }
  });

  it("skips a version the registry already has, so a failed release can be re-run", () => {
    const r = publishRun({ FAKE_NPM_PUBLISHED: "@leastpilot/catalog,@leastpilot/schema" });
    expect(r.status, r.stderr).toBe(0);
    expect(publishedNames(r.calls)).not.toContain("catalog");
    expect(publishedNames(r.calls)).not.toContain("schema");
    expect(publishedNames(r.calls)).toHaveLength(6);
  });

  it("stops at the first failed publish and publishes nothing after it", () => {
    const r = publishRun({ FAKE_NPM_PUBLISH_FAIL: "@leastpilot/schema" });
    expect(r.status).toBe(1);
    expect(publishedNames(r.calls).at(-1)).toBe("schema");
    expect(r.stderr).toMatch(/re-run/i);
  });

  // A network error is not "not published": treating it as one would try to
  // publish a version that may already exist, or skip the check entirely.
  it("stops when the registry cannot be asked, rather than reading that as unpublished", () => {
    const r = publishRun({ FAKE_NPM_VIEW_ERROR: "@leastpilot/catalog" });
    expect(r.status).toBe(1);
    expect(r.calls[0]?.slice(0, 2)).toEqual(["view", `@leastpilot/catalog@${published[0]!.json.version}`]);
    expect(publishedNames(r.calls)).toEqual([]);
    expect(r.stderr).toContain("ECONNRESET");
  });

  it("refuses before publishing anything when a tarball is missing", () => {
    const r = publishRun({}, ["@leastpilot/cli"]);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toContain("@leastpilot/cli");
  });
});

describe("scripts/release-version.mjs", () => {
  const check = (tag: string): number | null => {
    const r = spawnSync(process.execPath, [root("scripts/release-version.mjs"), tag], { encoding: "utf8" });
    // Said either way, so a missing script cannot pass the refusals.
    expect(r.stdout + r.stderr).toContain(version);
    return r.status;
  };
  const version = published[0]!.json.version;

  it("accepts the tag that names the packages' version", () => {
    expect(check(`v${version}`)).toBe(0);
  });

  it.each(["v9.9.9", version, `v${version}-rc.1`, `v${version}x`, ""])("refuses %j", (tag) => {
    expect(check(tag)).toBe(1);
  });
});
