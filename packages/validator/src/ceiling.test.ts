import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCeiling, rulesFor, cedarAllows, ceilingSha256, CeilingProfileError } from "./ceiling.js";
import { globMatches } from "./glob/contains.js";

// Resolved from this file, not from process.cwd(): vitest runs workspace
// projects with the repository root as cwd, so a path relative to the package
// would escape the repository.
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/ceilings/${name}`, import.meta.url)), "utf8");

const src = fixture("org-policy-v12.cedar");
const schema = fixture("schema.cedarschema");
const destinations = fixture("org-policy-v12.destinations");
const ceiling = loadCeiling("org-policy@v12", src, schema, destinations);

const load = (policies: string, dests = destinations) =>
  loadCeiling("probe", policies, schema, dests);

// Task 5.3. A ceiling's identity is what it contains, never what a mandate
// calls it: the shipped CLI used to label the operator's file with the id the
// mandate declared, so a writer steered by issue text could name the policy
// that "was checked". The hash covers the text of all three inputs as read --
// the schema included, since it shapes what the Cedar cross-check accepts --
// and normalises nothing, because a normaliser is a second parser that can
// disagree with Cedar.
describe("ceiling identity", () => {
  it("is a sha256 over the policy, the schema and the destinations", () => {
    expect(ceiling.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ceiling.sha256).toBe(ceilingSha256(src, schema, destinations));
  });

  it("does not depend on the label it is loaded under", () => {
    expect(loadCeiling("anything-else", src, schema, destinations).sha256).toBe(ceiling.sha256);
  });

  it("changes when any one of the three inputs changes, comments included", () => {
    const base = ceilingSha256(src, schema, destinations);
    expect(ceilingSha256(`${src}\n// edited\n`, schema, destinations)).not.toBe(base);
    expect(ceilingSha256(src, `${schema}\n`, destinations)).not.toBe(base);
    expect(ceilingSha256(src, schema, `${destinations}evil.example.com\n`)).not.toBe(base);
  });

  // Concatenating the three without lengths would let bytes slide from one
  // input into the next and keep the same hash.
  it("cannot be matched by moving bytes across the boundary between inputs", () => {
    expect(ceilingSha256("ab", "c", "d")).not.toBe(ceilingSha256("a", "bc", "d"));
    expect(ceilingSha256("a", "b", "cd")).not.toBe(ceilingSha256("a", "bc", "d"));
  });

  // Holds whether the prefix counts bytes or UTF-16 code units -- a mutant
  // using code units survives, and is equivalent: UTF-8 is self-synchronising,
  // so the encoding stays prefix-free either way. Kept as a regression test for
  // the boundary on non-ASCII text, not as evidence about the unit.
  it("keeps the boundary between inputs for non-ASCII text", () => {
    expect(ceilingSha256("é", "x", "")).not.toBe(ceilingSha256("", "éx", ""));
  });
});

describe("loadCeiling", () => {
  it("extracts one rule per policy, keyed by @id", () => {
    expect(ceiling.rules.map((r) => r.id)).toEqual([
      "allow-read-any-repo",
      "allow-agent-branch-writes",
      "allow-pr-create-to-main",
      "allow-branch-create",
    ]);
  });

  // Cedar's `like` has exactly one wildcard, `*`, and it matches any sequence
  // INCLUDING `/`. Our glob `*` stops at a separator, so the faithful
  // translation of a Cedar Wildcard is `**`. Translating it to `*` would make
  // the extracted ceiling narrower than the Cedar policy actually is, and the
  // Cedar cross-check cannot detect that skew because a narrower layer 1 still
  // implies Cedar allows every witness.
  it("translates a Cedar Wildcard to ** because Cedar's * crosses separators", () => {
    const r = rulesFor(ceiling, "repo.read")[0]!;
    expect(r.resources).toEqual(["acme/**"]);
    expect(globMatches(r.resources, "acme/api")).toBe(true);
    expect(globMatches(r.resources, "acme/team/api")).toBe(true);
  });

  it("extracts when-clause patterns for a write rule", () => {
    const r = rulesFor(ceiling, "contents.write")[0]!;
    expect(r.resources).toEqual(["acme/**"]);
    expect(r.branches).toEqual(["agent/**"]);
  });

  it("extracts unless-clause patterns as denyPaths", () => {
    const r = rulesFor(ceiling, "contents.write")[0]!;
    expect(r.denyPaths).toEqual([".github/workflows/**", "**.env**"]);
  });

  it("treats == as a single-literal pattern with no wildcard", () => {
    const r = rulesFor(ceiling, "pull_request.create")[0]!;
    expect(r.base).toEqual(["main"]);
    expect(globMatches(r.base, "main")).toBe(true);
    expect(globMatches(r.base, "release/1.0")).toBe(false);
  });

  it("leaves unconstrained facets empty rather than guessing", () => {
    const r = rulesFor(ceiling, "repo.read")[0]!;
    expect(r.branches).toEqual([]);
    expect(r.paths).toEqual([]);
    expect(r.denyPaths).toEqual([]);
    expect(r.base).toEqual([]);
  });

  it("rejects a forbid policy", () => {
    expect(() => load(`@id("f") forbid (principal, action, resource);`))
      .toThrow(CeilingProfileError);
  });

  it("rejects a policy with no @id, since a pause could not name it", () => {
    expect(() => load(`permit (principal, action == Mandate::Action::"repo.read", resource);`))
      .toThrow(CeilingProfileError);
  });

  it("rejects an unconstrained action", () => {
    expect(() => load(`@id("a") permit (principal, action, resource);`))
      .toThrow(CeilingProfileError);
  });

  it("rejects action in [...] because it is not a single operation", () => {
    expect(() => load(
      `@id("a") permit (principal, action in [Mandate::Action::"repo.read"], resource);`,
    )).toThrow(CeilingProfileError);
  });

  it("rejects an action that is not in the operation catalog", () => {
    expect(() => load(
      `@id("a") permit (principal, action == Mandate::Action::"repo.yolo", resource);`,
    )).toThrow(CeilingProfileError);
  });

  it("rejects a constrained principal or resource scope", () => {
    expect(() => load(
      `@id("a") permit (principal == Mandate::User::"alice", action == Mandate::Action::"repo.read", resource);`,
    )).toThrow(CeilingProfileError);
    expect(() => load(
      `@id("a") permit (principal, action == Mandate::Action::"repo.read", resource == Mandate::Repo::"acme/api");`,
    )).toThrow(CeilingProfileError);
  });

  it("rejects Cedar that does not parse", () => {
    expect(() => load(`permit (((`)).toThrow(CeilingProfileError);
  });

  it("rejects policies that do not validate against the schema", () => {
    // An unguarded optional-context access is a Cedar validation error.
    expect(() => load(
      `@id("a") permit (principal, action == Mandate::Action::"repo.read", resource)\n` +
      `when { context.branch like "x" };`,
    )).toThrow(CeilingProfileError);
  });

  // A literal `*` is expressible in Cedar (`like "a\*b"`) but not in the
  // restricted glob language, where `*` is always a wildcard. Translating it
  // would silently WIDEN the ceiling, so it must be refused.
  it("rejects a like pattern containing an escaped literal star", () => {
    expect(() => load(
      `@id("a") permit (principal, action == Mandate::Action::"repo.read", resource)\n` +
      `when { resource.repo like "acme/a\\*b" };`,
    )).toThrow(CeilingProfileError);
  });

  it("rejects a ceiling with no permits, which would grant nothing", () => {
    expect(() => load(`// only a comment`)).toThrow(CeilingProfileError);
  });

  it("rejects a when clause over an attribute outside the profile", () => {
    expect(() => load(
      `@id("a") permit (principal, action == Mandate::Action::"repo.read", resource)\n` +
      `when { resource.repo like "acme/*" && principal.name like "al*" };`,
    )).toThrow(CeilingProfileError);
  });
});

describe("cedarAllows — the independent cross-check", () => {
  it("allows a write on an agent branch outside the deny paths", () => {
    const r = cedarAllows(ceiling, {
      action: "contents.write", repo: "acme/api", branch: "agent/42-fix", path: "src/a.ts",
    });
    expect(r.allowed).toBe(true);
    // The reason must carry OUR rule id, not a Cedar-generated policy1.
    expect(r.reason).toEqual(["allow-agent-branch-writes"]);
  });

  it("denies a write to a workflow file", () => {
    expect(cedarAllows(ceiling, {
      action: "contents.write", repo: "acme/api", branch: "agent/42-fix",
      path: ".github/workflows/ci.yml",
    }).allowed).toBe(false);
  });

  it("denies a write to a dotenv file", () => {
    expect(cedarAllows(ceiling, {
      action: "contents.write", repo: "acme/api", branch: "agent/42-fix",
      path: "packages/x/.env.local",
    }).allowed).toBe(false);
  });

  it("denies a write on a non-agent branch", () => {
    expect(cedarAllows(ceiling, {
      action: "contents.write", repo: "acme/api", branch: "main", path: "src/a.ts",
    }).allowed).toBe(false);
  });

  it("denies a write with no branch context at all", () => {
    expect(cedarAllows(ceiling, {
      action: "contents.write", repo: "acme/api", path: "src/a.ts",
    }).allowed).toBe(false);
  });

  it("denies an operation the ceiling never mentions", () => {
    expect(cedarAllows(ceiling, { action: "pull_request.merge", repo: "acme/api" }).allowed).toBe(false);
    expect(cedarAllows(ceiling, { action: "secrets.read", repo: "acme/api" }).allowed).toBe(false);
  });

  it("denies a repository outside the org", () => {
    expect(cedarAllows(ceiling, { action: "repo.read", repo: "evil/api" }).allowed).toBe(false);
  });

  it("denies rather than throwing when the action is not in the schema", () => {
    expect(cedarAllows(ceiling, { action: "not.an.action", repo: "acme/api" }).allowed).toBe(false);
  });

  it("allows a PR to main and denies one to another base", () => {
    expect(cedarAllows(ceiling, {
      action: "pull_request.create", repo: "acme/api", branch: "agent/42", base: "main",
    }).allowed).toBe(true);
    expect(cedarAllows(ceiling, {
      action: "pull_request.create", repo: "acme/api", branch: "agent/42", base: "release/1.0",
    }).allowed).toBe(false);
  });
});

// The organization's destination allowlist (R9, and the handoff's "nothing
// proves destinations sits inside a ceiling"). It is a required input: a
// ceiling that forgot the file would otherwise silently permit every
// destination, which is the opposite of deny-by-default.
describe("the ceiling's destination allowlist", () => {
  it("carries the list the sidecar names", () => {
    expect(ceiling.destinations).toContain("github.com/acme");
    expect(ceiling.destinations).toContain("api.github.com");
  });

  it("reads an empty source as permitting nothing", () => {
    expect(load(src, "").destinations).toEqual([]);
  });

  it("refuses a list it cannot enforce", () => {
    expect(() => load(src, "*\n")).toThrow(/wildcard/i);
    expect(() => load(src, "https://github.com/acme\n")).toThrow(/scheme/i);
  });
});
