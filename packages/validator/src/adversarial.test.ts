import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMandateYaml, proofOf, type ProposedMandate } from "@leastpilot/schema";
import { ceilingSha256, loadCeiling } from "./ceiling.js";
import { validate, type RejectionCode } from "./validate.js";
import { workBudget } from "./glob/budget.js";
import type { UserAuthority } from "./userAuthority.js";

/**
 * The adversarial suite, validator half (Task 19 families A and D's mandate
 * side).
 *
 * LeastPilot does not detect prompt injection -- that is an explicit non-goal. So
 * the question is never "did the model notice the attack?" but "did the ceiling
 * hold anyway?". Every case here therefore simulates a FULLY COMPROMISED
 * writer that proposed exactly what the injected text asked for, and asserts
 * the deterministic layers refuse it regardless.
 *
 * Deliberately NOT a second copy of `fixtures/overgrants/`, which already
 * covers the blunt cases (a `*` destination, a foreign repository, a wider
 * branch, a forbidden operation). These cases attack what that suite does not:
 * the destination boundary, homoglyph resources, the ceiling LABEL as distinct
 * from the ceiling, and the cost of deciding containment.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(root(p), "utf8");

// Labelled as the shipped CLI labels it: by the operator's file. This harness
// used to pass "org-policy@v12" itself while prepare.ts passed the mandate's
// claim, so the pasted-cedar case held here and failed in production. The
// shipped path is now tested too, in cli/src/commands/validate.test.ts.
const CEILING_FILES = [
  read("fixtures/ceilings/org-policy-v12.cedar"),
  read("fixtures/ceilings/schema.cedarschema"),
  read("fixtures/ceilings/org-policy-v12.destinations"),
] as const;
const ceiling = loadCeiling("org-policy-v12.cedar", ...CEILING_FILES);

/**
 * The index is checked, not trusted. A corpus that loses a file, or an `expect`
 * block that loses its `outcome`, has to fail loudly -- a suite that silently
 * shrinks to zero cases is the failure mode this whole task exists to avoid.
 *
 * Checked by hand rather than with Zod because this package deliberately has no
 * Zod dependency: it sits on the trust boundary, and the whole point of
 * `ValidatedMandate` is that the validator's inputs arrive already parsed.
 */
export interface AdversarialCase {
  readonly family: string;
  readonly id: string;
  readonly attack: string;
  readonly invariant: string;
  readonly issue?: string;
  readonly mandate?: string;
  readonly file?: string;
  readonly expect?:
    /** A mandate the validator must refuse, with the exact rejection codes. */
    | { readonly outcome: "reject"; readonly codes: readonly string[] }
    /** A mandate that validates, with the reason that is not a breach. */
    | {
      readonly outcome: "accept";
      readonly why: string;
      readonly provesAgainst?: string;
      readonly knownGap?: boolean;
    }
    /** A tool call the proxy must deny, naming the clause. */
    | { readonly outcome: "deny"; readonly clause: string }
    /** A tool call the proxy allows, with the reason that is not a breach. */
    | { readonly outcome: "allow"; readonly why: string };
}

function loadIndex(): readonly AdversarialCase[] {
  const raw: unknown = JSON.parse(read("fixtures/adversarial/index.json"));
  if (!Array.isArray(raw)) throw new Error("adversarial index is not an array");

  return raw.map((entry, i): AdversarialCase => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`adversarial index [${i}] is not an object`);
    }
    const c = entry as Record<string, unknown>;
    const text = (k: string): string => {
      const v = c[k];
      if (typeof v !== "string" || v.length === 0) {
        throw new Error(`adversarial index [${i}] has no ${k}`);
      }
      return v;
    };
    const optional = (k: string): string | undefined => {
      const v = c[k];
      if (v === undefined) return undefined;
      if (typeof v !== "string") throw new Error(`adversarial index [${i}].${k} is not a string`);
      return v;
    };

    let expectation: AdversarialCase["expect"];
    const e = c["expect"];
    if (e !== undefined) {
      if (typeof e !== "object" || e === null) {
        throw new Error(`adversarial index [${i}].expect is not an object`);
      }
      const x = e as Record<string, unknown>;
      if (x["outcome"] === "reject") {
        const codes = x["codes"];
        if (!Array.isArray(codes) || codes.length === 0) {
          throw new Error(`adversarial index [${i}] rejects but names no codes`);
        }
        expectation = { outcome: "reject", codes: codes.map(String) };
      } else if (x["outcome"] === "accept") {
        if (typeof x["why"] !== "string" || x["why"].length === 0) {
          throw new Error(`adversarial index [${i}] accepts but does not say why`);
        }
        expectation = {
          outcome: "accept",
          why: x["why"],
          ...(typeof x["provesAgainst"] === "string" ? { provesAgainst: x["provesAgainst"] } : {}),
          ...(typeof x["knownGap"] === "boolean" ? { knownGap: x["knownGap"] } : {}),
        };
      } else if (x["outcome"] === "deny") {
        if (typeof x["clause"] !== "string" || x["clause"].length === 0) {
          throw new Error(`adversarial index [${i}] denies but names no clause`);
        }
        expectation = { outcome: "deny", clause: x["clause"] };
      } else if (x["outcome"] === "allow") {
        if (typeof x["why"] !== "string" || x["why"].length === 0) {
          throw new Error(`adversarial index [${i}] allows but does not say why`);
        }
        expectation = { outcome: "allow", why: x["why"] };
      } else {
        throw new Error(`adversarial index [${i}].expect.outcome is ${String(x["outcome"])}`);
      }
    }

    return {
      family: text("family"),
      id: text("id"),
      attack: text("attack"),
      invariant: text("invariant"),
      ...(optional("issue") !== undefined ? { issue: optional("issue") as string } : {}),
      ...(optional("mandate") !== undefined ? { mandate: optional("mandate") as string } : {}),
      ...(optional("file") !== undefined ? { file: optional("file") as string } : {}),
      ...(expectation !== undefined ? { expect: expectation } : {}),
    };
  });
}

const INDEX = loadIndex();

const AUTHORITY: UserAuthority = { login: "alice", level: "push" };

describe("adversarial corpus — the index itself", () => {
  // Pins the corpus size per family. Task 19 asks for four families of at least
  // six cases; if a family is emptied or a file is deleted, this fails before
  // any invariant gets the chance to pass vacuously.
  it("has four families of at least six cases each, 42 in total", () => {
    const counts = new Map<string, number>();
    for (const c of INDEX) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);

    expect([...counts.keys()].sort()).toEqual(["args", "mandate", "plan", "tools"]);
    for (const [family, n] of counts) {
      expect(n, `family ${family}`).toBeGreaterThanOrEqual(6);
    }
    expect(INDEX.length).toBe(42);
  });

  it("names a real file for every case, and every case states its invariant", () => {
    for (const c of INDEX) {
      for (const p of [c.issue, c.mandate, c.file]) {
        if (p === undefined) continue;
        expect(() => read(`fixtures/adversarial/${p}`), `${c.id}: ${p}`).not.toThrow();
      }
      expect(c.invariant.length, c.id).toBeGreaterThan(40);
    }
  });
});

const mandateCases = INDEX.filter((c) => c.family === "mandate");

describe("adversarial: the ceiling holds whatever the task text says", () => {
  it("covers nine proposals from a compromised writer", () => {
    expect(mandateCases.length).toBe(9);
  });

  for (const c of mandateCases) {
    const expected = c.expect;
    const mandateFile = c.mandate;

    it(`${c.id}: ${c.invariant.slice(0, 72)}`, () => {
      // Not `if (!parsed.success) continue`. A case whose fixture stopped
      // parsing must fail, not quietly leave the loop body unexecuted.
      expect(mandateFile, `${c.id} has no mandate fixture`).toBeDefined();
      expect(expected, `${c.id} has no expect block`).toBeDefined();

      const proposed: ProposedMandate =
        parseMandateYaml(read(`fixtures/adversarial/${mandateFile ?? ""}`));

      // The injected text is carried in the mandate's own `task`, so the
      // attacker's words are present at the moment the decision is taken.
      expect(proposed.task.length).toBeGreaterThan(0);

      const result = validate(proposed, { ceiling, authority: AUTHORITY });

      if (expected?.outcome === "reject") {
        expect(result.ok, `${c.id} must be refused`).toBe(false);
        if (result.ok) return;
        const codes = [...new Set<RejectionCode>(result.rejections.map((r) => r.code))].sort();
        expect(codes).toEqual([...expected.codes].sort());
        // Every rejection carries a reason a person can act on; R10's "name the
        // clause it hit" is worthless if the message is empty.
        for (const r of result.rejections) expect(r.message.length).toBeGreaterThan(20);
        return;
      }

      // The accepted cases are the interesting ones: each documents WHY it is
      // not a breach. A case may also be marked `knownGap` to pin behaviour
      // that is a gap rather than a guarantee, so closing it has a test to flip. A `deny`/`allow` expectation belongs to the proxy
      // families and must never appear on a mandate case.
      expect(expected?.outcome, `${c.id} expects a proxy outcome`).toBe("accept");
      if (expected?.outcome !== "accept") return;

      expect(result.ok, `${c.id} should validate: ${expected.why}`).toBe(true);
      if (!result.ok) return;

      if (expected.provesAgainst !== undefined) {
        // The whole attack is the `ceiling:` label. The proof must record the
        // ceiling the OPERATOR loaded, never the one the mandate claimed.
        const proof = proofOf(result.mandate);
        expect(proof.ceilingId).toBe(expected.provesAgainst);
        expect(proof.ceilingId).not.toBe(proposed.ceiling);
        // The label identifies nothing on its own. The hash is of the
        // operator's files, and a ceiling one byte different proves under a
        // different hash, so two files cannot produce the same proof.
        expect(proof.ceilingSha256).toBe(ceilingSha256(...CEILING_FILES));
        const [cedar, schema, dests] = CEILING_FILES;
        expect(proof.ceilingSha256).not.toBe(ceilingSha256(`${cedar}\n`, schema, dests));
      }
    });
  }
});

describe("adversarial: deciding containment cannot cost unbounded work", () => {
  /**
   * `MAX_DFA_STATES` bounds ONE automaton. A mandate is many: 64 grants, each
   * with several facets, each facet a separate containment decision. Measured
   * before this bound existed: the 22 KB `pattern-flood` fixture validated
   * `ok: true` in 2.6 s, and a 698 KB mandate built the same way ran for over
   * five minutes without finishing. Both are schema-legal and neither
   * over-grants anything -- the attack is the cost.
   *
   * "Reject on any doubt" (R3) includes doubt about termination, so the budget
   * is shared across the whole `validate()` call and exhausting it is a
   * rejection, not a slow pass.
   */
  it("refuses the pattern flood rather than grinding through it", () => {
    const proposed: ProposedMandate =
      parseMandateYaml(read("fixtures/adversarial/mandates/pattern-flood.yaml"));

    const started = Date.now();
    const result = validate(proposed, { ceiling, authority: AUTHORITY });
    const elapsed = Date.now() - started;

    // The verdict is the invariant, and it is deterministic: the same mandate
    // spends the same units on any machine. The elapsed bound below is only a
    // sanity check that the budget is doing its job at all -- 5 s rather than
    // the measured 1.8 s so a loaded CI runner cannot fail it, because the
    // alternative is a test whose outcome depends on load.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.map((r) => r.code)).toContain("undecidable");
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(5000);
  });

  /**
   * The guard on the other side. A budget tight enough to stop the flood is
   * also tight enough to reject real work, and the first two constants tried
   * here did exactly that -- 120_000 units refused a 19-grant monorepo refactor
   * in 147 ms. These two cases are what makes lowering the budget a test
   * failure rather than a silent regression in false rejections.
   */
  it("leaves a realistic mandate two orders of magnitude of headroom", () => {
    const budget = workBudget();
    const proposed: ProposedMandate = parseMandateYaml(`
mandate: benchmark-shape
task: "Fix issue #42 and open a PR"
requestedBy: user:alice
expiresInMinutes: 60
ceiling: org-policy@v12
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["acme/api"]
  - action: branch.create
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    paths: ["src/**", "test/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
  - action: pull_request.create
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    base: main
    max: 1
destinations:
  allow: ["github.com/acme/api"]
`);
    const result = validate(proposed, { ceiling, authority: AUTHORITY, budget });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.rejections)).toBe(true);

    const spent = budget.total - budget.remaining;
    // Measured at 24_717 of 8_000_000, 14_379 since Phase 8's per-call cache.
    // Asserting a share rather than the exact
    // number, so a cheaper automaton is an improvement and not a failure.
    expect(spent).toBeGreaterThan(0);
    expect(spent / budget.total, `spent ${spent} of ${budget.total}`).toBeLessThan(0.01);
  });

  it("still validates a path-heavy mandate at the schema's 64-grant maximum", () => {
    // The worst legitimate case there is: every grant a separate package of a
    // monorepo, each with its own path and deny-path sets. Measured at 47% of
    // the budget, 6.7% since Phase 8's per-call cache; the deny-list cases
    // below are now the thinnest.
    const grants = [
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      ...Array.from({ length: 63 }, (_, i) => ({
        action: "contents.write",
        enforcedBy: "proxy",
        resources: ["acme/api"],
        branches: ["agent/42-*"],
        paths: [`packages/p${i}/src/**`, `packages/p${i}/test/**`],
        denyPaths: [".github/workflows/**", "**.env**"],
      })),
    ];
    const budget = workBudget();
    const result = validate(
      {
        mandate: "monorepo-wide",
        task: "Refactor the retry helper across every package",
        requestedBy: "user:alice",
        expiresInMinutes: 60,
        ceiling: "org-policy@v12",
        grants,
        destinations: { allow: ["github.com/acme/api"] },
      } as unknown as ProposedMandate,
      { ceiling, authority: AUTHORITY, budget },
    );

    expect(result.ok, JSON.stringify(result.ok ? [] : result.rejections)).toBe(true);
    expect(budget.remaining, "a legitimate mandate must not exhaust the budget")
      .toBeGreaterThan(0);
  });

  it("still validates an ordinary mandate well inside the budget", () => {
    // The guard against fixing the flood by making the validator useless: this
    // is the shape of mandate the benchmark actually produces.
    const proposed: ProposedMandate = parseMandateYaml(`
mandate: ordinary
task: "Fix issue #42 and open a PR"
requestedBy: user:alice
expiresInMinutes: 60
ceiling: org-policy@v12
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["acme/api"]
  - action: branch.create
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    paths: ["src/**", "test/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
  - action: pull_request.create
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    base: main
    max: 1
destinations:
  allow: ["github.com/acme/api"]
`);
    const started = Date.now();
    const result = validate(proposed, { ceiling, authority: AUTHORITY });
    const elapsed = Date.now() - started;

    expect(result.ok, JSON.stringify(result.ok ? [] : result.rejections)).toBe(true);
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(2000);
  });
});

// Phase 8: the headroom the plan worried about was on the wrong axis. Cost
// grows with the deny list, and every grant rebuilt the same deny automaton:
// a 19-grant monorepo with a six-pattern deny list spent 102% of the budget and
// was refused as too complex; 63 such grants spent 341% (measured). A cache
// scoped to one validate() call builds each shared automaton once.
describe("the work budget and an ordinary deny list", () => {
  const DENY = [".github/workflows/**", "**.env**", "**/secrets/**", "**/*.pem", "**/*.key", "infra/**"];
  const monorepo = (packages: number): ProposedMandate => parseMandateYaml(JSON.stringify({
    mandate: "monorepo-wide",
    task: "Refactor the retry helper across every package",
    requestedBy: "user:alice",
    expiresInMinutes: 60,
    ceiling: "org-policy@v12",
    grants: [
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      ...Array.from({ length: packages }, (_, i) => ({
        action: "contents.write",
        enforcedBy: "proxy",
        resources: ["acme/api"],
        branches: ["agent/42-*"],
        paths: [`packages/p${i}/src/**`, `packages/p${i}/test/**`],
        denyPaths: DENY,
      })),
    ],
    destinations: { allow: ["github.com/acme/api"] },
  }));

  it.each([19, 63])("validates %i grants sharing a six-pattern deny list within the default budget", (n) => {
    const budget = workBudget();
    const result = validate(monorepo(n), { ceiling, authority: AUTHORITY, budget });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.rejections)).toBe(true);
    const spent = budget.total - budget.remaining;
    expect(spent / budget.total, `spent ${spent} of ${budget.total}`).toBeLessThan(0.5);
  });

  // Found by review: one alphabet for the whole call made every automaton as
  // wide as the widest grant's characters. One grant with a path of 300
  // distinct CJK characters (1.8M units alone) took 62 ordinary grants (1.6M)
  // to 8.0M together, refused. A grant's characters now cost only that grant.
  it("does not let one grant's characters inflate every other grant", () => {
    const cjk = Array.from({ length: 300 }, (_, k) => String.fromCodePoint(0x4e00 + k)).join("");
    const m = monorepo(62);
    const wide = { ...m, grants: [...m.grants, {
      action: "contents.write" as const, enforcedBy: "proxy" as const, resources: ["acme/api"],
      branches: ["agent/42-*"], paths: [`docs/${cjk}/**`], denyPaths: DENY,
    }] };
    const alone = (x: ProposedMandate): number => {
      const b = workBudget();
      validate(x, { ceiling, authority: AUTHORITY, budget: b });
      return b.total - b.remaining;
    };
    const budget = workBudget();
    const result = validate(wide, { ceiling, authority: AUTHORITY, budget });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.rejections)).toBe(true);
    const together = budget.total - budget.remaining;
    // No more than the two halves would cost apart, give or take what they share.
    expect(together).toBeLessThan(alone(m) + alone({ ...m, grants: [m.grants[0]!, wide.grants.at(-1)!] }));
  });

  it("spends exactly the same on the same mandate, whatever ran before", () => {
    const spend = (): number => {
      const budget = workBudget();
      validate(monorepo(19), { ceiling, authority: AUTHORITY, budget });
      return budget.total - budget.remaining;
    };
    const first = spend();
    validate(monorepo(4), { ceiling, authority: AUTHORITY, budget: workBudget() });
    expect(spend()).toBe(first);
  });
});

// Found measuring the above: a budget that ran out inside the sensitive-paths
// lint was caught as an undecidable pattern and reported as "contents.write
// does not exclude **.env**" -- for a grant whose deny list names it. Refused
// either way; the reason given was false.
describe("a budget that runs out says so", () => {
  it("never blames a deny list that is there, at any budget", () => {
    const proposed = parseMandateYaml(`
mandate: m
task: t
requestedBy: user:alice
expiresInMinutes: 60
ceiling: org-policy@v12
grants:
  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    paths: ["src/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
destinations:
  allow: ["github.com/acme/api"]
`);
    const full = workBudget();
    expect(validate(proposed, { ceiling, authority: AUTHORITY, budget: full }).ok).toBe(true);
    const needed = full.total - full.remaining;
    for (let units = 1; units < needed; units += Math.max(1, Math.floor(needed / 97))) {
      const r = validate(proposed, { ceiling, authority: AUTHORITY, budget: workBudget(units) });
      expect(r.ok, `at ${units} units`).toBe(false);
      if (r.ok) continue;
      for (const rej of r.rejections) {
        expect(rej.message, `at ${units} units`).not.toMatch(/does not exclude/);
      }
      expect(r.rejections.some((x) => x.code === "undecidable"), `at ${units} units`).toBe(true);
    }
  });
});

// Worse than a false reason: the default-branch lint's membership check
// degraded to "no match" on any undecidable pattern, and a spent budget is
// one. Under a ceiling loose enough to permit writes to main -- the case that
// lint exists for -- a mandate sized to run the budget out at that lint would
// validate. The budget is deterministic, so the size can be found.
describe("a budget that runs out inside the default-branch lint", () => {
  const loose = loadCeiling(
    "loose.cedar",
    `@id("allow-read")
permit (principal, action == Mandate::Action::"repo.read", resource)
when { resource.repo like "acme/*" };

@id("allow-writes-anywhere")
permit (principal, action == Mandate::Action::"contents.write", resource)
when { resource.repo like "acme/*" }
unless { context has path && (context.path like ".github/workflows/*" || context.path like "*.env*") };
`,
    CEILING_FILES[1],
    CEILING_FILES[2],
  );
  const reachesMain = parseMandateYaml(`
mandate: m
task: t
requestedBy: user:alice
expiresInMinutes: 60
ceiling: loose
grants:
  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }
  # The first write grant warms the call's cache with the deny list, so the second
  # grant's sensitive-paths check is a cache hit that charges nothing and so
  # cannot throw. Nothing after the second grant's branch check then masks a
  # branch check that read a spent budget as "cannot reach main".
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    paths: ["src/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["**"]
    paths: ["lib/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
destinations:
  allow: ["github.com/acme/api"]
`);

  it("refuses a grant that reaches main, at every budget", () => {
    const full = workBudget();
    const r = validate(reachesMain, { ceiling: loose, authority: AUTHORITY, budget: full });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections.map((x) => x.message).join("\n")).toMatch(/no-default-branch-write/);
    const needed = full.total - full.remaining;
    // The lints run last, so the window is the final stretch: the cost of one
    // branch check, about 30 units. The old code validated this mandate at
    // 14_897..14_926 of 15_092 units. The last 1000 in steps of 5 sample that
    // window six times, in about two seconds.
    for (let units = Math.max(1, needed - 1000); units <= needed; units += 5) {
      const at = validate(reachesMain, { ceiling: loose, authority: AUTHORITY, budget: workBudget(units) });
      expect(at.ok, `validated with ${units} of ${needed} units`).toBe(false);
    }
  }, 60_000);
});
