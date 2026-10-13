#!/usr/bin/env node
// Writes the 0.0.0 placeholder for each public package into <dir>. Writes
// only; publishing them is the owner's step (docs/releasing.md).
//
//   node scripts/placeholders.mjs <dir>
//
// npm attaches a trusted publisher only to a package that already exists, so
// the first version of each package cannot come from the release workflow.
// A placeholder holds no code: a package.json and a README saying what it is.
// It is deprecated once the trusted publisher is attached, and the release
// workflow's first real version becomes `latest`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicPackages, ROOT } from "./public-packages.mjs";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: node scripts/placeholders.mjs <dir>");
  process.exit(2);
}

for (const p of publicPackages()) {
  const real = JSON.parse(readFileSync(join(ROOT, "packages", p.dir, "package.json"), "utf8"));
  const dir = join(out, p.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({
    name: p.name,
    version: "0.0.0",
    description: "Placeholder so npm trusted publishing can be configured. Contains no code; do not install.",
    license: real.license,
    repository: real.repository,
    publishConfig: { access: "public" },
  }, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), `# ${p.name} 0.0.0 (placeholder)

This version contains no code. npm only lets a trusted publisher be attached to
a package that already exists, so this placeholder was published by hand
before the first real release came from CI with provenance.

Install a real version instead: see https://github.com/pkravella/mandate.
`);
  console.log(`${p.name}@0.0.0 -> ${dir}`);
}
