// The public packages, read from packages/*/package.json, and the order they
// publish in. Shared by the release scripts so they cannot disagree.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every package that is not private: { dir, name, version, deps }. */
export function publicPackages() {
  return readdirSync(join(ROOT, "packages")).sort()
    .map((dir) => ({ dir, json: JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) }))
    .filter((p) => p.json.private !== true)
    .map(({ dir, json }) => ({
      dir, name: json.name, version: json.version,
      deps: Object.keys(json.dependencies ?? {}).filter((d) => d.startsWith("@leastpilot/")),
    }));
}

/**
 * Dependencies first. The CLI pins its siblings exactly, so a sibling must
 * exist on the registry before anything that names it does. Ties break by
 * name, so the order is the same on every run.
 */
export function publishOrder(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const done = new Set();
  const order = [];
  while (order.length < packages.length) {
    const ready = packages.filter((p) => !done.has(p.name) && p.deps.every((d) => done.has(d) || !byName.has(d)));
    if (ready.length === 0) throw new Error("the public packages' dependencies form a cycle");
    for (const p of ready.sort((a, b) => a.name.localeCompare(b.name))) {
      order.push(p);
      done.add(p.name);
    }
  }
  return order;
}

/** The file `pnpm pack` writes for a package. */
export const tarballName = (p) => `${p.name.replace("@", "").replace("/", "-")}-${p.version}.tgz`;
