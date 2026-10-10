import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMandateYaml, proofOf, type ProposedMandate } from "@mandate-dev/schema";
import { loadCeiling } from "./ceiling.js";
import { validate, type RejectionCode } from "./validate.js";
import { workBudget } from "./glob/budget.js";
import type { UserAuthority } from "./userAuthority.js";

/**
 * The adversarial suite, validator half (Task 19 families A and D's mandate
 * side).
 *
 * Mandate does not detect prompt injection -- that is an explicit non-goal. So
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

const ceiling = loadCeiling(
  "org-policy@v12",
  read("fixtures/ceilings/org-policy-v12.cedar"),
  read("fixtures/ceilings/schema.cedarschema"),
  read("fixtures/ceilings/org-policy-v12.destinations"),
);

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
      // not a breach, and two of them pin behaviour that is a known gap rather
      // than a guarantee. A `deny`/`allow` expectation belongs to the proxy
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
    // Measured at 24_717 of 8_000_000. Asserting a share rather than the exact
    // number, so a cheaper automaton is an improvement and not a failure.
    expect(spent).toBeGreaterThan(0);
    expect(spent / budget.total, `spent ${spent} of ${budget.total}`).toBeLessThan(0.01);
  });

  it("still validates a path-heavy mandate at the schema's 64-grant maximum", () => {
    // The worst legitimate case there is: every grant a separate package of a
    // monorepo, each with its own path and deny-path sets. Measured at 47% of
    // the budget, which is the thinnest real headroom and the reason the
    // constant is not lower.
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
