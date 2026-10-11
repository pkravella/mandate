import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * .github/dependabot.yml, checked as data, because nothing runs it until
 * Dependabot's weekly pass -- and GitHub's config check validates the schema,
 * not what a version range matches.
 *
 * The odd-numbered Node ignore was written as "23.x", which npm's requirement
 * class reads as a range and Docker's does not: Dependabot's Docker requirement
 * is a plain Gem::Requirement, where "23.x" matches only the literal string
 * "23.x". Found by the Phase 6 review; reproduced with Gem::Requirement.
 */
interface Update {
  readonly "package-ecosystem": string;
  readonly ignore?: readonly { readonly "dependency-name": string; readonly versions?: readonly string[] }[];
}
const config = parse(readFileSync(
  fileURLToPath(new URL("../../../.github/dependabot.yml", import.meta.url)), "utf8",
)) as { updates: readonly Update[] };

describe(".github/dependabot.yml", () => {
  const docker = config.updates.find((u) => u["package-ecosystem"] === "docker");
  const node = docker?.ignore?.find((i) => i["dependency-name"] === "node");

  it("ignores odd-numbered Node images with ranges a Docker requirement can read", () => {
    expect(node?.versions?.length).toBeGreaterThan(0);
    for (const v of node?.versions ?? []) expect(v).toMatch(/^>= (\d+), < (\d+)$/);
  });

  it("names every odd major from 23 up, each as exactly that major", () => {
    const ranges = (node?.versions ?? []).map((v) => /^>= (\d+), < (\d+)$/.exec(v)!.slice(1).map(Number));
    for (const [lo, hi] of ranges) {
      expect(lo! % 2).toBe(1);
      expect(hi).toBe(lo! + 1);
    }
    expect(ranges.map(([lo]) => lo)).toEqual([23, 25, 27, 29, 31]);
  });
});
