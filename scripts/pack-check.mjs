#!/usr/bin/env node
// The pack check (Task 9.1): what npm users get, proved from outside the
// workspace.
//
// Nothing in the test suite can see a published package. Every test runs from
// the checkout, where `workspace:*` resolves to a sibling directory and a file
// the tarball forgot is still on disk. So this packs every public package the
// way the release does (pnpm rewrites `workspace:*` to an exact version), checks
// what each tarball holds, installs the tarballs into an empty directory under
// the system temp dir, and runs the installed binary there:
//
//   - `--version` and `--help`;
//   - `validate` on a mandate that passes and one that is rejected, compared
//     with the checkout's own binary on the same files, so "the same answer the
//     repository's tests do" is checked rather than assumed;
//   - `sandbox build` against a stand-in `docker`, to show the build context it
//     hands docker is the installed package's own copy of the sandbox.
//
// Run after `pnpm build`. Needs the npm registry for third-party dependencies.
// Exits 1 listing every failure, not just the first.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_URL = "git+https://github.com/pkravella/mandate.git";
const SANDBOX_FILES = ["Dockerfile", "entrypoint.sh", "verify.mjs", "relay.mjs", "mcp.mjs"];

const failures = [];
const fail = (msg) => { failures.push(msg); console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);

const packages = readdirSync(join(ROOT, "packages"))
  .map((dir) => ({ dir, json: JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) }))
  .filter((p) => p.json.private !== true);
const versions = new Set(packages.map((p) => p.json.version));
if (versions.size !== 1) fail(`public packages disagree on a version: ${[...versions].join(", ")}`);
const VERSION = packages[0].json.version;
console.log(`${packages.length} public packages at ${VERSION}`);

const work = realpathSync(mkdtempSync(join(tmpdir(), "leastpilot-pack-check-")));
const keep = process.env["PACK_CHECK_KEEP"] === "1";
try {
  // 1. Pack, the way the release does.
  const tgzDir = join(work, "tgz");
  mkdirSync(tgzDir);
  for (const p of packages) {
    execFileSync("pnpm", ["pack", "--pack-destination", tgzDir], {
      cwd: join(ROOT, "packages", p.dir), stdio: ["ignore", "ignore", "inherit"],
    });
  }
  const tarballs = readdirSync(tgzDir).filter((f) => f.endsWith(".tgz")).map((f) => join(tgzDir, f));

  // 2. What each tarball holds.
  for (const p of packages) {
    const tgz = join(tgzDir, `${p.json.name.replace("@", "").replace("/", "-")}-${p.json.version}.tgz`);
    if (!existsSync(tgz)) { fail(`${p.json.name}: no tarball at ${tgz}`); continue; }
    const entries = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean);
    const required = ["package/package.json", "package/README.md", "package/LICENSE", "package/NOTICE",
      "package/dist/index.js", "package/dist/index.d.ts"];
    if (p.dir === "cli") required.push(...SANDBOX_FILES.map((f) => `package/sandbox/${f}`));
    for (const r of required) {
      if (!entries.includes(r)) fail(`${p.json.name}: tarball lacks ${r.slice("package/".length)}`);
    }
    const stray = entries.filter((e) => /\.test\.|\/src\/|\.tsbuildinfo$/.test(e));
    if (stray.length > 0) fail(`${p.json.name}: tarball carries ${stray.slice(0, 3).join(", ")}`);

    const packed = JSON.parse(execFileSync("tar", ["xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
    if (packed.repository?.url !== REPOSITORY_URL) {
      fail(`${p.json.name}: repository.url is ${JSON.stringify(packed.repository?.url)}`);
    }
    if (packed.repository?.directory !== `packages/${p.dir}`) {
      fail(`${p.json.name}: repository.directory is ${JSON.stringify(packed.repository?.directory)}`);
    }
    if (packed.publishConfig?.access !== "public") fail(`${p.json.name}: publishConfig.access is not public`);
    for (const [dep, range] of Object.entries(packed.dependencies ?? {})) {
      if (dep.startsWith("@leastpilot/") && range !== VERSION) {
        fail(`${p.json.name}: depends on ${dep}@${range}, not exactly ${VERSION}`);
      }
      if (range.startsWith("workspace:")) fail(`${p.json.name}: ${dep} still says ${range}`);
    }
  }
  ok(`${tarballs.length} tarballs inspected`);

  // 3. Install outside the workspace. The project directory has no lockfile and
  // nothing else, so the exact pins have to resolve to these tarballs.
  const inst = join(work, "install");
  mkdirSync(inst);
  writeFileSync(join(inst, "package.json"), JSON.stringify({ name: "pack-check", private: true }));
  const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
    cwd: inst, encoding: "utf8",
  });
  if (npm.status !== 0) {
    fail(`npm install of the tarballs exited ${npm.status}:\n${npm.stderr}`);
    throw new Error("cannot continue without an install");
  }
  ok("installed outside the workspace");
  const BIN = join(inst, "node_modules", ".bin", "leastpilot");
  const REPO_BIN = join(ROOT, "packages", "cli", "dist", "index.js");
  const run = (bin, args, extra = {}) => spawnSync(bin === REPO_BIN ? process.execPath : bin,
    bin === REPO_BIN ? [bin, ...args] : args,
    { cwd: inst, encoding: "utf8", ...extra, env: { PATH: process.env["PATH"], ...extra.env } });

  // 4. The binary, from there.
  const v = run(BIN, ["--version"]);
  if (v.status !== 0 || v.stdout.trim() !== VERSION) {
    fail(`leastpilot --version printed ${JSON.stringify(v.stdout.trim())} (exit ${v.status}), not ${VERSION}`);
  } else ok(`--version is ${VERSION}`);
  const h = run(BIN, ["--help"]);
  if (h.status !== 0 || !h.stdout.startsWith("Usage: leastpilot")) fail(`leastpilot --help exited ${h.status}`);
  else ok("--help");

  // 5. validate: the installed binary gives the checkout's answer.
  for (const f of ["org-policy-v12.cedar", "org-policy-v12.destinations", "schema.cedarschema"]) {
    copyFileSync(join(ROOT, "fixtures", "ceilings", f), join(inst, f));
  }
  copyFileSync(join(ROOT, "fixtures", "pack-check", "fix-issue-42.yaml"), join(inst, "fix-issue-42.yaml"));
  copyFileSync(join(ROOT, "fixtures", "overgrants", "base-not-main.yaml"), join(inst, "base-not-main.yaml"));
  const validateArgs = (m) => ["validate", m, "--ceiling", "org-policy-v12.cedar",
    "--schema", "schema.cedarschema", "--ceiling-destinations", "org-policy-v12.destinations",
    "--as", "alice", "--level", "push"];
  for (const [mandate, want] of [["fix-issue-42.yaml", 0], ["base-not-main.yaml", 1]]) {
    const installed = run(BIN, validateArgs(mandate));
    const checkout = run(REPO_BIN, validateArgs(mandate));
    if (installed.status !== want) {
      fail(`validate ${mandate} exited ${installed.status}, not ${want}:\n${installed.stdout}${installed.stderr}`);
    } else if (installed.status !== checkout.status || installed.stdout !== checkout.stdout
      || installed.stderr !== checkout.stderr) {
      fail(`validate ${mandate}: the installed binary and the checkout disagree`);
    } else ok(`validate ${mandate} exits ${want}, as the checkout does`);
  }

  // 6. sandbox build hands docker the installed package's own sandbox.
  const fakeBin = join(work, "fake-bin");
  mkdirSync(fakeBin);
  const record = join(work, "docker-argv.json");
  writeFileSync(join(fakeBin, "docker"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(join(fakeBin, "docker"), 0o755);
  const sb = run(BIN, ["sandbox", "build"], { env: { PATH: `${fakeBin}:${process.env["PATH"]}` } });
  const argv = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : [];
  const context = argv.at(-1) ?? "";
  const expected = join(inst, "node_modules", "@leastpilot", "cli", "sandbox");
  if (sb.status !== 0) fail(`leastpilot sandbox build exited ${sb.status}:\n${sb.stderr}`);
  else if (argv[0] !== "build" || !argv.includes("mandate-sandbox")) fail(`docker got ${JSON.stringify(argv)}`);
  else if (realpathSync(context) !== realpathSync(expected)) {
    fail(`docker's build context is ${context}, not the installed package's ${expected}`);
  } else ok("sandbox build uses the installed package's sandbox");
} catch (e) {
  if (failures.length === 0) fail(String(e instanceof Error ? e.message : e));
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\npack check: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\npack check: passed");
