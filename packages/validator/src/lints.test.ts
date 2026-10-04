import { describe, expect, it } from "vitest";
import { MandateSchema } from "@mandate-dev/schema";
import { runLints, hasLintErrors, LINT_RULES, SIDE_EFFECTING } from "./lints.js";
import { requireOperation } from "@mandate-dev/catalog";

const mandate = (grants: unknown[], over: Record<string, unknown> = {}) =>
  MandateSchema.parse({
    mandate: "m", task: "t", requestedBy: "user:a", expiresInMinutes: 30,
    ceiling: "c@v1", grants, destinations: { allow: ["github.com/acme/api"] }, ...over,
  });

const rules = (grants: unknown[], over: Record<string, unknown> = {}) =>
  runLints(mandate(grants, over)).map((f) => f.rule);

const SAFE_DENY = [".github/workflows/**", "**.env**"];

describe("runLints", () => {
  it("flags a bare wildcard resource", () => {
    expect(rules([{ action: "repo.read", enforcedBy: "token", resources: ["*"] }]))
      .toContain("no-wildcard-resource");
    expect(rules([{ action: "repo.read", enforcedBy: "token", resources: ["**"] }]))
      .toContain("no-wildcard-resource");
  });

  it("allows a wildcard bounded by an owner", () => {
    expect(rules([{ action: "repo.read", enforcedBy: "token", resources: ["acme/*"] }]))
      .not.toContain("no-wildcard-resource");
  });

  it("flags a write that can reach a default branch", () => {
    for (const branches of [["main"], ["ma*"], ["**"], ["master"], ["release/*"]]) {
      expect(rules([{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
        branches, paths: ["**"], denyPaths: SAFE_DENY }]), JSON.stringify(branches))
        .toContain("no-default-branch-write");
    }
  });

  it("does not flag an agent branch pattern", () => {
    expect(rules([{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], paths: ["**"], denyPaths: SAFE_DENY }]))
      .not.toContain("no-default-branch-write");
  });

  it("flags a code write with no branch constraint", () => {
    expect(rules([{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      paths: ["**"], denyPaths: SAFE_DENY }])).toContain("require-branch-constraint");
  });

  it("flags workflow and secret access", () => {
    expect(rules([{ action: "workflows.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/*"], paths: ["**"], denyPaths: SAFE_DENY }]))
      .toContain("no-workflow-access");
    expect(rules([{ action: "secrets.read", enforcedBy: "token", resources: ["acme/api"] }]))
      .toContain("no-secret-access");
    expect(rules([{ action: "actions.write", enforcedBy: "proxy", resources: ["acme/api"], max: 1 }]))
      .toContain("no-workflow-access");
  });

  // The grant must deny AT LEAST the sensitive set. Containment, not a probe:
  // the question is whether the sensitive patterns are inside the deny list.
  it("flags a code write whose deny list does not cover workflows and dotenv", () => {
    expect(rules([{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/*"], paths: ["**"] }])).toContain("require-sensitive-deny-paths");
    expect(rules([{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/*"], paths: ["**"], denyPaths: [".github/workflows/**"] }]))
      .toContain("require-sensitive-deny-paths");
    expect(rules([{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/*"], paths: ["**"], denyPaths: SAFE_DENY }]))
      .not.toContain("require-sensitive-deny-paths");
  });

  it("accepts a deny list broader than the required minimum", () => {
    expect(rules([{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/*"], paths: ["**"], denyPaths: [".github/**", "**.env**", "**secret**"] }]))
      .not.toContain("require-sensitive-deny-paths");
  });

  it("flags a forbidden-risk operation regardless of the ceiling", () => {
    expect(rules([{ action: "pull_request.merge", enforcedBy: "token", resources: ["acme/api"], max: 1 }]))
      .toContain("no-forbidden-risk-op");
    expect(rules([{ action: "repo.delete", enforcedBy: "token", resources: ["acme/api"] }]))
      .toContain("no-forbidden-risk-op");
  });

  it("flags an unbounded side-effect count", () => {
    expect(rules([{ action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/*"], base: "main" }])).toContain("require-max-on-side-effects");
    expect(rules([{ action: "issue.comment", enforcedBy: "proxy", resources: ["acme/api"] }]))
      .toContain("require-max-on-side-effects");
  });

  it("flags a destinations list that permits anything", () => {
    expect(rules([{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
      { destinations: { allow: ["*"] } })).toContain("no-wildcard-destination");
    expect(rules([{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
      { destinations: { allow: ["github.com/acme/api", "**"] } })).toContain("no-wildcard-destination");
  });

  // GitHub App tokens cannot express branch or path scope, so a grant claiming
  // token enforcement while carrying those limits is describing a control that
  // does not exist.
  it("flags a grant claiming token enforcement for a branch or path limit", () => {
    expect(rules([{ action: "contents.write", enforcedBy: "token", resources: ["acme/api"],
      branches: ["agent/*"], paths: ["**"], denyPaths: SAFE_DENY }]))
      .toContain("enforcement-overclaim");
  });

  it("does not flag a token grant with no finer limits", () => {
    expect(rules([{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }]))
      .not.toContain("enforcement-overclaim");
  });

  it("is quiet on a well-formed mandate", () => {
    const findings = runLints(mandate([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      { action: "branch.create", enforcedBy: "proxy", resources: ["acme/api"], branches: ["agent/42-*"] },
      { action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
        branches: ["agent/42-*"], paths: ["src/**"], denyPaths: SAFE_DENY },
      { action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
        branches: ["agent/42-*"], base: "main", max: 1 },
    ]));
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(hasLintErrors(findings)).toBe(false);
  });

  it("reports the grant index on grant-scoped findings", () => {
    const findings = runLints(mandate([
      { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      { action: "secrets.read", enforcedBy: "token", resources: ["acme/api"] },
    ]));
    const secret = findings.find((f) => f.rule === "no-secret-access")!;
    expect(secret.grantIndex).toBe(1);
  });

  it("never throws on an unknown operation, since validate already rejected it", () => {
    const m = {
      ...mandate([{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }]),
      grants: [{ action: "repo.yolo", enforcedBy: "token" as const, resources: ["acme/api"] }],
    };
    expect(() => runLints(m as never)).not.toThrow();
    expect(runLints(m as never)).toEqual([]);
  });

  it("never throws on an undecidable pattern, since lints run after containment", () => {
    // A lint must not be the thing that crashes; validate() rejects the
    // undecidable pattern first, and a lint pass over it should degrade to a
    // finding rather than an exception.
    const m = {
      ...mandate([{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }]),
      grants: [{ action: "contents.write", enforcedBy: "proxy" as const, resources: ["acme/api"],
        branches: ["agent/[ab]*"], paths: ["**"] }],
    };
    expect(() => runLints(m as never)).not.toThrow();
  });

  // Without this, a lint can demand a field the schema refuses, making the
  // grant impossible to express at all. gist.write, repo.create and repo.fork
  // were all in that state.
  it("only demands a max from operations the catalog lets carry one", () => {
    const unsatisfiable = [...SIDE_EFFECTING].filter(
      (id) => !requireOperation(id).constrainable.includes("max"),
    );
    expect(unsatisfiable).toEqual([]);
  });

  it("exposes every rule name it can emit", () => {
    const emitted = new Set<string>();
    for (const grants of [
      [{ action: "repo.read", enforcedBy: "token", resources: ["*"] }],
      [{ action: "contents.write", enforcedBy: "token", resources: ["acme/api"], branches: ["main"], paths: ["**"] }],
      [{ action: "secrets.read", enforcedBy: "token", resources: ["acme/api"] }],
      [{ action: "workflows.write", enforcedBy: "proxy", resources: ["acme/api"], branches: ["agent/*"], paths: ["**"] }],
      [{ action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"], branches: ["agent/*"], base: "main" }],
      [{ action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"], paths: ["**"], denyPaths: SAFE_DENY }],
    ]) {
      for (const r of rules(grants)) emitted.add(r);
    }
    for (const r of rules([{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
      { destinations: { allow: ["*"] } })) emitted.add(r);
    expect([...emitted].sort()).toEqual([...LINT_RULES].sort());
  });
});
