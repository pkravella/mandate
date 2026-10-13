#!/usr/bin/env node
// Publishes the public packages' tarballs, dependencies first (Task 9.1).
//
//   node scripts/publish.mjs <directory of pnpm-packed tarballs>
//
// The CLI pins its siblings exactly, so a release is all of them or a CLI
// that cannot install. If a run fails part-way, some versions exist and others
// do not, and npm never lets a version be published twice. The remedy is to
// re-run the same release: this skips every version the registry already has
// and stops at the first failure, so a re-run picks up where the last stopped.
// Never bump only the packages that failed.
//
// Tarballs, not `npm publish` in a package directory: only pnpm rewrites
// `workspace:*` into a version, so npm publishing a directory would ship the
// literal `workspace:*`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { publicPackages, publishOrder, tarballName } from "./public-packages.mjs";

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: node scripts/publish.mjs <directory of tarballs>");
  process.exit(2);
}

const order = publishOrder(publicPackages());
const missing = order.filter((p) => !existsSync(join(dir, tarballName(p))));
if (missing.length > 0) {
  console.error(`no tarball for ${missing.map((p) => `${p.name}@${p.version}`).join(", ")} in ${dir}; nothing published`);
  process.exit(1);
}

/** true if the registry has this exact version, false if it says it does not; throws otherwise. */
function onRegistry(p) {
  const r = spawnSync("npm", ["view", `${p.name}@${p.version}`, "version", "--json"], { encoding: "utf8" });
  if (r.status === 0) return true;
  let code;
  try { code = JSON.parse(r.stdout).error?.code; } catch { code = undefined; }
  if (code === "E404") return false;
  throw new Error(`could not ask the registry about ${p.name}@${p.version} (${code ?? `exit ${r.status}`})`);
}

const stop = (why) => {
  console.error(`${why}\nStopped. Fix the cause and re-run this release; published versions are skipped.`);
  process.exit(1);
};

for (const p of order) {
  let exists;
  try { exists = onRegistry(p); } catch (e) { stop(e.message); }
  if (exists) {
    console.log(`skip     ${p.name}@${p.version}: already on the registry`);
    continue;
  }
  console.log(`publish  ${p.name}@${p.version}`);
  const r = spawnSync("npm", ["publish", join(dir, tarballName(p)), "--access", "public", "--provenance"], {
    stdio: "inherit",
  });
  if (r.status !== 0) stop(`npm publish ${p.name}@${p.version} exited ${r.status}`);
}
console.log(`published ${order.length} packages`);
