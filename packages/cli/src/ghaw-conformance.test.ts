import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileGhAw } from "@mandate-dev/compiler";
import { MandateSchema, markValidated, type Grant, type ValidatedMandate } from "@mandate-dev/schema";
import { globMatches } from "@mandate-dev/validator";

/**
 * The gh-aw export's conformance test: whatever gh-aw would let through, the
 * mandate allows. Run through gh-aw's own matchers (fixtures/gh-aw/v0.89.21,
 * copied unmodified), not a description of them, against Mandate's own
 * `globMatches` -- the membership check the proxy uses on real arguments.
 *
 * Over generated paths and branch names, for every mandate that exports: the
 * five fix-task mandates the writer produced for the published benchmark, and
 * hand-made ones with patterns and overlapping deny paths.
 */

const vendor = (f: string): string =>
  fileURLToPath(new URL(`../../../fixtures/gh-aw/v0.89.21/${f}`, import.meta.url));
const require = createRequire(import.meta.url);
const { globPatternToRegex } = require(vendor("glob_pattern_helpers.cjs")) as {
  globPatternToRegex: (p: string, o?: { pathMode?: boolean; caseSensitive?: boolean }) => RegExp;
};
const { normalizeBranchName } = require(vendor("normalize_branch_name.cjs")) as {
  normalizeBranchName: (b: string, salt?: string | null) => string;
};
const { isAllowedBranch } = require(vendor("is_allowed_branch.cjs")) as {
  isAllowedBranch: (b: string, patterns: string[]) => boolean;
};

const PROOF = {
  ceilingId: "c.cedar", ceilingSha256: "0".repeat(64), userLevel: "push" as const,
  checkedAt: "2026-10-11T00:00:00.000Z", grantProofs: [],
};
const asValidated = (m: unknown): ValidatedMandate => markValidated(MandateSchema.parse(m), PROOF);

const published = (): ValidatedMandate[] => {
  const runs = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../../docs/benchmark-results.json", import.meta.url)), "utf8",
  )) as { taskId: string; mandate?: unknown }[];
  const byTask = new Map<string, unknown>();
  for (const r of runs) if (r.mandate !== undefined && r.mandate !== null) byTask.set(r.taskId, r.mandate);
  return [...byTask.values()].map(asValidated);
};

const handMade = (contentsWrite: Partial<Grant>, branch = "agent/42-fix"): ValidatedMandate => asValidated({
  mandate: "hand-made", task: "t", requestedBy: "user:alice", expiresInMinutes: 30, ceiling: "c",
  destinations: { allow: ["github.com/acme/api"] },
  grants: [
    { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    { action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"], branches: [branch] },
    { action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"], branches: [branch], ...contentsWrite },
    { action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"], branches: [branch], base: "main", max: 1 },
  ],
});

const MANDATES: readonly ValidatedMandate[] = [
  ...published(),
  handMade({ paths: ["src/**"], denyPaths: [".github/workflows/**", "**.env**"] }),
  handMade({ paths: ["src/*.js", "test/**/*.test.js"], denyPaths: ["src/secret*"] }),
  handMade({ denyPaths: [".github/**", "**/.env*"] }),
  handMade({ paths: ["docs/**", "README.md"] }),
  // Refused today. Were it exported, gh-aw would push names outside it.
  handMade({ paths: ["src/**"] }, "agent/42-*"),
];

/** Strings a pattern's wildcards could stand for, including slashes, dots and dashes. */
function expand(pattern: string): string[] {
  const fills = ["", "x", "a/b", ".env", "x.js", "-", "!!", "..", "A"];
  let out = [pattern];
  for (const token of ["**", "*"]) {
    out = out.flatMap((p) => (p.includes(token) ? fills.map((f) => p.split(token).join(f)) : [p]));
  }
  return out;
}

function pathSamples(patterns: readonly string[]): string[] {
  const base = patterns.flatMap(expand);
  const fixed = [
    ".github/workflows/ci.yml", "src/.env", "src/a/.env.local", "SRC/retry.js", "src/retry.js/",
    "src//retry.js", "src/retry.jsx", "./src/retry.js", "/src/retry.js", "src/../.env", "README.md",
  ];
  const variants = base.flatMap((p) => [p, `a/${p}`, `${p}/x`, `${p}x`, p.toUpperCase(), `./${p}`]);
  return [...new Set([...variants, ...fixed])];
}

function branchSamples(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((n) => [
    n, `${n}!!`, `${n}-x`, `${n}/x`, `x${n}`, n.toUpperCase(), `${n}--`, ` ${n}`, `${n}.`,
    n.replace(/-/g, "!"), `${n}${"y".repeat(130)}`,
  ]))];
}

const grantOf = (m: ValidatedMandate, action: string): Grant | undefined =>
  m.grants.find((g) => g.action === action);

describe("the gh-aw export lets through nothing the mandate refuses", () => {
  const exported = MANDATES.map((m) => ({ m, r: compileGhAw(m) }));

  // The published triage mandate is repo.read alone, and gh-aw would add a
  // create-issue output to a workflow that writes nothing; the branch pattern
  // is refused because normalisation escapes it. Both by design.
  it("exports every mandate that writes to named branches, and refuses the other two", () => {
    const refused = exported.filter((e) => !e.r.ok).map((e) =>
      e.m.grants.some((g) => g.branches?.some((b) => b.includes("*")) ?? false) ? "pattern" : "read-only");
    expect(refused.sort()).toEqual(["pattern", "read-only"]);
    expect(exported.filter((e) => e.r.ok)).toHaveLength(9);
  });

  for (const { m, r } of exported) {
    if (!r.ok) continue;
    const pr = (r.frontmatter["safe-outputs"] as Record<string, Record<string, unknown>>)["create-pull-request"];
    if (pr === undefined) continue;
    const write = grantOf(m, "contents.write");

    it(`${m.mandate}: every file gh-aw would commit, the mandate allows`, () => {
      const allowed = (pr["allowed-files"] as string[] | undefined)?.map((p) => globPatternToRegex(p));
      const excluded = ((pr["excluded-files"] as string[] | undefined) ?? []).map((p) => globPatternToRegex(p));
      const samples = pathSamples([...(write?.paths ?? []), ...(write?.denyPaths ?? []), "src/x.js"]);
      let committed = 0;
      for (const path of samples) {
        const ghAwCommits = (allowed === undefined || allowed.some((re) => re.test(path)))
          && !excluded.some((re) => re.test(path));
        if (!ghAwCommits) continue;
        committed += 1;
        const mandateAllows = (write?.paths === undefined || globMatches(write.paths, path))
          && !(write?.denyPaths !== undefined && globMatches(write.denyPaths, path));
        expect(mandateAllows, `gh-aw would commit ${JSON.stringify(path)}`).toBe(true);
      }
      // Not vacuous: the mandate's own literal paths get through.
      expect(committed).toBeGreaterThan(0);
    });

    it(`${m.mandate}: every branch gh-aw would push, every grant allows`, () => {
      const allowed = pr["allowed-branches"] as string[];
      const limited = m.grants.filter((g) => g.branches !== undefined);
      let pushed = 0;
      for (const raw of branchSamples(allowed)) {
        if (!isAllowedBranch(raw, allowed)) continue;
        // preserve-branch-name is set, so no salt; normalisation still runs.
        const branch = normalizeBranchName(raw, pr["preserve-branch-name"] === true ? null : "salt0");
        pushed += 1;
        for (const g of limited) {
          expect(globMatches(g.branches ?? [], branch), `${g.action}: gh-aw would push ${JSON.stringify(branch)}`)
            .toBe(true);
        }
      }
      expect(pushed).toBeGreaterThan(0);
    });
  }
});

// Why branch patterns and lone "*" are refused, shown with gh-aw's own code.
describe("what gh-aw does that Mandate's matcher does not", () => {
  it("admits a name inside agent/42-* and pushes it outside", () => {
    expect(isAllowedBranch("agent/42-!!", ["agent/42-*"])).toBe(true);
    const pushed = normalizeBranchName("agent/42-!!");
    expect(pushed).toBe("agent/42");
    expect(globMatches(["agent/42-*"], pushed)).toBe(false);
  });

  it("reads a lone * as every branch, slashes included", () => {
    expect(isAllowedBranch("release/v1", ["*"])).toBe(true);
    expect(globMatches(["*"], "release/v1")).toBe(false);
  });

  it("matches files exactly as Mandate does: * stops at a slash, ** does not", () => {
    for (const [p, v] of [["src/*", "src/a/b"], ["src/**", "src/a/b"], ["**.env**", "a/.env.x"], ["src/*.js", "src/.js"]] as const) {
      expect(globPatternToRegex(p).test(v), `${p} vs ${v}`).toBe(globMatches([p], v));
    }
  });
});
