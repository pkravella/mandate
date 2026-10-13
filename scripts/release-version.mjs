#!/usr/bin/env node
// Exits 0 only when the tag names the version every public package carries:
// `v` and exactly that version. The release workflow runs it before anything
// else, so a tag pushed at the wrong commit publishes nothing.
import { publicPackages } from "./public-packages.mjs";

const tag = process.argv[2] ?? "";
const versions = [...new Set(publicPackages().map((p) => p.version))];
if (versions.length !== 1) {
  console.error(`the public packages disagree on a version: ${versions.join(", ")}`);
  process.exit(1);
}
const [version] = versions;
if (tag !== `v${version}`) {
  console.error(`tag ${JSON.stringify(tag)} does not name the packages' version ${version}; expected v${version}`);
  process.exit(1);
}
console.log(`tag ${tag} matches the packages' version ${version}`);
