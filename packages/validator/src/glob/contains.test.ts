import { describe, expect, it } from "vitest";
import { globSetContains, globMatches } from "./contains.js";
import { parseGlob, GlobParseError } from "./parse.js";

const contains = (outer: string[], inner: string[]) => globSetContains(outer, inner);

describe("parseGlob", () => {
  it("rejects metacharacters it cannot decide", () => {
    for (const bad of ["a?b", "a[bc]", "a{b,c}", "!a", "a(b)", "a|b", "a+b", "a@b", "a\\b"]) {
      expect(() => parseGlob(bad), bad).toThrow(GlobParseError);
    }
  });
  it("rejects *** and empty patterns", () => {
    expect(() => parseGlob("a***b")).toThrow(GlobParseError);
    expect(() => parseGlob("")).toThrow(GlobParseError);
  });
  it("accepts literals, * and **", () => {
    expect(parseGlob("agent/42-*").length).toBe(10);
    expect(parseGlob("**/.env*").map((t) => t.kind)).toEqual(
      ["globstarSlash", "lit", "lit", "lit", "lit", "star"],
    );
    expect(parseGlob("a/**").map((t) => t.kind)).toContain("globstar");
  });
});

// Membership is the primitive everything else rests on, so it is pinned
// directly rather than only through containment.
describe("globMatches", () => {
  it("matches literals exactly", () => {
    expect(globMatches(["acme/api"], "acme/api")).toBe(true);
    expect(globMatches(["acme/api"], "acme/apiX")).toBe(false);
    expect(globMatches(["acme/api"], "acme/ap")).toBe(false);
  });

  it("stops * at a slash but lets ** cross it", () => {
    expect(globMatches(["agent/*"], "agent/42-fix")).toBe(true);
    expect(globMatches(["agent/*"], "agent/42/fix")).toBe(false);
    expect(globMatches(["agent/**"], "agent/42/fix")).toBe(true);
  });

  it("lets * match an empty run", () => {
    expect(globMatches(["agent/*"], "agent/")).toBe(true);
  });

  // The security case. deny_paths of ["**/.env*"] is meant to protect every
  // .env anywhere, and a repository-root .env is the one that matters most.
  // If `**/` required a literal slash, the root file would be unprotected.
  it("treats **/ as zero or more leading segments", () => {
    expect(globMatches(["**/.env*"], ".env")).toBe(true);
    expect(globMatches(["**/.env*"], ".env.local")).toBe(true);
    expect(globMatches(["**/.env*"], "packages/x/.env")).toBe(true);
    expect(globMatches(["**/.env*"], "a/b/c/.env.production")).toBe(true);
  });

  it("does not let **/ match a partial segment", () => {
    expect(globMatches(["**/.env*"], "not-dotenv")).toBe(false);
    expect(globMatches(["**/.env*"], "src/notenv")).toBe(false);
  });

  it("matches a directory tree with a trailing globstar", () => {
    expect(globMatches([".github/workflows/**"], ".github/workflows/ci.yml")).toBe(true);
    expect(globMatches([".github/workflows/**"], ".github/workflows/a/b.yml")).toBe(true);
    expect(globMatches([".github/workflows/**"], ".github/dependabot.yml")).toBe(false);
  });

  it("treats a bare ** as everything", () => {
    for (const s of ["a", "a/b", ".env", "x/y/z.ts", ""]) {
      expect(globMatches(["**"], s), s).toBe(true);
    }
  });
});

describe("globSetContains — the soundness cases", () => {
  it("accepts an identical pattern", () => {
    expect(contains(["agent/**"], ["agent/**"]).ok).toBe(true);
  });

  it("accepts a strictly narrower pattern", () => {
    expect(contains(["agent/**"], ["agent/42-fix"]).ok).toBe(true);
    expect(contains(["agent/**"], ["agent/42-*"]).ok).toBe(true);
  });

  it("REJECTS a wider pattern and names a counterexample", () => {
    const r = contains(["agent/42-*"], ["agent/**"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(globMatches(["agent/**"], r.counterexample)).toBe(true);
      expect(globMatches(["agent/42-*"], r.counterexample)).toBe(false);
    }
  });

  it("REJECTS a bare wildcard as a subset of anything narrower", () => {
    expect(contains(["acme/api"], ["*"]).ok).toBe(false);
    expect(contains(["acme/*"], ["**"]).ok).toBe(false);
  });

  it("knows * does not cross a slash but ** does", () => {
    expect(contains(["agent/**"], ["agent/*"]).ok).toBe(true);
    expect(contains(["agent/*"], ["agent/**"]).ok).toBe(false);
  });

  it("catches the branch-pattern escape the PRD's example invites", () => {
    const r = contains(["agent/42-*"], ["agent/42-*", "main"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.counterexample).toBe("main");
  });

  it("treats a union outer as the union of its members", () => {
    expect(contains(["agent/**", "fix/**"], ["fix/123"]).ok).toBe(true);
    expect(contains(["agent/**", "fix/**"], ["chore/123"]).ok).toBe(false);
  });

  it("requires every member of a union inner to be contained", () => {
    expect(contains(["agent/**"], ["agent/a", "agent/b"]).ok).toBe(true);
    expect(contains(["agent/**"], ["agent/a", "main"]).ok).toBe(false);
  });

  it("subtracts the inner deny list before checking containment", () => {
    const r = globSetContains(["**"], ["**"], {
      innerMinus: [".github/workflows/**"],
      outerMinus: [".github/workflows/**"],
    });
    expect(r.ok).toBe(true);
  });

  it("REJECTS when the mandate's deny list is weaker than the ceiling's", () => {
    const r = globSetContains(["**"], ["**"], {
      innerMinus: [".github/workflows/**"],
      outerMinus: [".github/**"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.counterexample.startsWith(".github/")).toBe(true);
  });

  it("accepts when the mandate's deny list is stronger than the ceiling's", () => {
    const r = globSetContains(["**"], ["**"], {
      innerMinus: [".github/**"],
      outerMinus: [".github/workflows/**"],
    });
    expect(r.ok).toBe(true);
  });

  it("is decidable on the adversarial dotfile pattern from the PRD example", () => {
    const r = globSetContains(["**"], ["**"], { innerMinus: ["**/.env*"], outerMinus: ["**/.env*"] });
    expect(r.ok).toBe(true);
    const leaky = globSetContains(["**"], ["**"], { innerMinus: [], outerMinus: ["**/.env*"] });
    expect(leaky.ok).toBe(false);
    if (!leaky.ok) expect(globMatches(["**/.env*"], leaky.counterexample)).toBe(true);
  });

  it("returns a counterexample that genuinely distinguishes the two sets", () => {
    const pairs: Array<[string[], string[]]> = [
      [["agent/42-*"], ["agent/**"]],
      [["acme/api"], ["acme/*"]],
      [["a/b"], ["a/**"]],
      [["**/x"], ["**"]],
    ];
    for (const [outer, inner] of pairs) {
      const r = globSetContains(outer, inner);
      expect(r.ok, `${inner} should not be inside ${outer}`).toBe(false);
      if (!r.ok) {
        expect(globMatches(inner, r.counterexample), `witness ${JSON.stringify(r.counterexample)} must be in inner`).toBe(true);
        expect(globMatches(outer, r.counterexample), `witness ${JSON.stringify(r.counterexample)} must be outside outer`).toBe(false);
      }
    }
  });

  it("propagates a parse error rather than guessing", () => {
    expect(() => globSetContains(["acme/api"], ["acme/api?"])).toThrow(GlobParseError);
    expect(() => globSetContains(["acme/api?"], ["acme/api"])).toThrow(GlobParseError);
  });

  it("refuses a pattern too complex to decide rather than hanging", () => {
    const pathological = "a".repeat(60) + "*".repeat(60);
    const started = Date.now();
    expect(() => globSetContains([pathological], [pathological])).toThrow(GlobParseError);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// The DFA is the authority for every containment decision, so it is
// cross-checked against an independent regex implementation of the same
// semantics. A disagreement means one of them is wrong, and must fail the build.
describe("globMatches — cross-checked against a regex oracle", () => {
  const oracle = (globs: readonly string[], s: string): boolean => {
    const source = globs
      .map((g) =>
        g
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          // `**/` is zero or more complete segments.
          .replace(/\*\*\//g, "\u0001")
          .replace(/\*\*/g, "\u0002")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0001/g, "(?:.*\\/)?")
          .replace(/\u0002/g, ".*"),
      )
      .join("|");
    return new RegExp(`^(?:${source})$`).test(s);
  };

  const CHARS = ["a", "b", "/", "-", ".", "e", "n", "v"];

  // A seeded generator rather than Math.random. A cross-check that can fail
  // intermittently in CI is worse than no cross-check: the failure is not
  // reproducible, so nobody can act on it. With a fixed seed the sampled
  // strings are identical on every run and a disagreement is debuggable.
  const makeRng = (seed: number) => {
    let state = seed >>> 0;
    return (): number => {
      // xorshift32
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x1_0000_0000;
    };
  };

  const stringsFor = (seed: number, count: number): string[] => {
    const rng = makeRng(seed);
    return Array.from({ length: count }, () =>
      Array.from(
        { length: Math.floor(rng() * 8) },
        () => CHARS[Math.floor(rng() * CHARS.length)]!,
      ).join(""),
    );
  };

  const PATTERN_SETS: string[][] = [
    ["a/**"], ["a/*"], ["**"], ["a/b"], ["a-*"], ["**/b"], ["**/.env*"],
    [".github/workflows/**"], ["a/**", "b/*"], ["*"], ["a*b"], ["**/a/**"],
  ];

  const SAMPLES = stringsFor(0x5eed_1234, 500);

  it("agrees with the oracle on 6000 deterministic samples", () => {
    const disagreements: string[] = [];
    for (const globs of PATTERN_SETS) {
      for (const s of SAMPLES) {
        const dfa = globMatches(globs, s);
        const re = oracle(globs, s);
        if (dfa !== re) {
          disagreements.push(`${JSON.stringify(globs)} vs ${JSON.stringify(s)}: dfa=${dfa} regex=${re}`);
        }
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
  });

  it("never claims containment while a sampled witness contradicts it", () => {
    const violations: string[] = [];
    for (const outer of PATTERN_SETS) {
      for (const inner of PATTERN_SETS) {
        if (!globSetContains(outer, inner).ok) continue;
        for (const s of SAMPLES) {
          if (globMatches(inner, s) && !globMatches(outer, s)) {
            violations.push(`${JSON.stringify(s)} in ${inner} but not ${outer}`);
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

// globMatches takes a concrete value, not a pattern. It used to pass that value
// through alphabetOf, which parses its input as a glob, so a real filename
// containing a metacharacter threw from inside the proxy's enforcement path.
describe("globMatches on values that are not patterns", () => {
  it("matches a filename containing glob metacharacters literally", () => {
    expect(globMatches(["src/**"], "src/pages/[id].tsx")).toBe(true);
    expect(globMatches(["src/**"], "src/a?.ts")).toBe(true);
    expect(globMatches(["src/**"], "src/{a,b}.ts")).toBe(true);
    expect(globMatches(["src/**"], "src/a(1).ts")).toBe(true);
  });

  it("still says no when such a filename is outside the pattern", () => {
    expect(globMatches(["src/**"], "app/pages/[id].tsx")).toBe(false);
    expect(globMatches([".github/workflows/**"], "src/[id].tsx")).toBe(false);
  });

  it("does not treat a metacharacter in the value as a wildcard", () => {
    // If `*` in the value were parsed as a pattern it would match anything.
    expect(globMatches(["src/a.ts"], "*")).toBe(false);
    expect(globMatches(["src/a.ts"], "src/*")).toBe(false);
    expect(globMatches(["src/a.ts"], "src/a.ts")).toBe(true);
  });

  it("catches the deny-path case that matters", () => {
    expect(globMatches([".github/workflows/**"], ".github/workflows/[env].yml")).toBe(true);
    expect(globMatches(["**.env**"], "packages/[id]/.env.local")).toBe(true);
  });
});
