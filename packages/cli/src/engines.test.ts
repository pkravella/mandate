import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Node version the project claims to run on, checked against what it ships
 * and what it depends on.
 *
 * Only the private root declared `engines`, so `npm install @leastpilot/cli`
 * on an older Node warned about nothing. And commander 15 needs Node 22.12
 * while the root said 22.0, which CI could not notice: it runs the latest 22.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

interface Pkg {
  readonly name: string;
  readonly private?: boolean;
  readonly engines?: { readonly node?: string };
  readonly dependencies?: Record<string, string>;
}
const read = (p: string): Pkg => JSON.parse(readFileSync(p, "utf8")) as Pkg;

const rootPkg = read(root("package.json"));
const published = readdirSync(root("packages"))
  .map((d) => ({ dir: root(`packages/${d}`), pkg: read(root(`packages/${d}/package.json`)) }))
  .filter((p) => p.pkg.private !== true);

/**
 * The lowest version a range admits. Only `>=X[.Y[.Z]]` is understood, which is
 * every form in the tree today; anything else fails the test rather than being
 * guessed at.
 */
const minimum = (range: string): readonly [number, number, number] => {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (m === null) throw new Error(`cannot read engines range ${JSON.stringify(range)}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
};
const atLeast = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

describe("engines", () => {
  const ours = rootPkg.engines?.node ?? "";

  it("is declared on every published package, the same as the root's", () => {
    expect(published.length).toBeGreaterThan(0);
    for (const { pkg } of published) expect(pkg.engines?.node, pkg.name).toBe(ours);
  });

  it("admits no Node older than a runtime dependency requires", () => {
    const floor = minimum(ours);
    for (const { dir, pkg } of published) {
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (dep.startsWith("@leastpilot/")) continue;
        const manifest = read(realpathSync(join(dir, "node_modules", dep, "package.json")));
        const theirs = manifest.engines?.node;
        if (theirs === undefined) continue;
        expect(atLeast(floor, minimum(theirs)), `${pkg.name} -> ${dep} needs ${theirs}`).toBe(true);
      }
    }
  });
});
