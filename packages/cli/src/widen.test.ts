import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MandateSchema, type Mandate, type ProposedMandate, type WidenRequest,
} from "@mandate-dev/schema";
import { loadCeiling, validate } from "@mandate-dev/validator";
import { applyWiden, runWiden, type WidenArgs } from "./commands/widen.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
const read = (name: string): string => readFileSync(fixturePath(name), "utf8");

const ceiling = loadCeiling(
  "org-policy@v12",
  read("ceilings/org-policy-v12.cedar"),
  read("ceilings/schema.cedarschema"),
  read("ceilings/org-policy-v12.destinations"),
);

const current: Mandate = MandateSchema.parse({
  mandate: "fix-issue-42", task: "t", requestedBy: "user:alice", expiresInMinutes: 60,
  ceiling: "org-policy@v12",
  grants: [
    { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    {
      action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], paths: ["src/**"],
      denyPaths: [".github/workflows/**", "**.env**"],
    },
  ],
  destinations: { allow: ["github.com/acme/api"] },
});

const req = (over: Partial<WidenRequest> = {}): WidenRequest => ({
  mandateId: "fix-issue-42",
  action: "contents.write",
  addGrant: { action: "contents.write", paths: ["tests/**"] },
  justification: "the fix needs a test",
  ...over,
});

describe("applyWiden", () => {
  it("adds a path to the existing grant rather than creating a duplicate", () => {
    const next = applyWiden(current, req());
    expect(next.grants).toHaveLength(2);
    expect(next.grants.find((g) => g.action === "contents.write")?.paths)
      .toEqual(["src/**", "tests/**"]);
  });

  it("leaves the other grants untouched", () => {
    const next = applyWiden(current, req());
    expect(next.grants.find((g) => g.action === "repo.read"))
      .toEqual(current.grants.find((g) => g.action === "repo.read"));
  });

  it("unions rather than replaces, so the original patterns survive", () => {
    const next = applyWiden(current, req({
      addGrant: { action: "contents.write", branches: ["agent/42-extra"] },
    }));
    expect(next.grants.find((g) => g.action === "contents.write")?.branches)
      .toEqual(["agent/42-*", "agent/42-extra"]);
  });

  it("does not duplicate a pattern the grant already has", () => {
    const next = applyWiden(current, req({
      addGrant: { action: "contents.write", paths: ["src/**"] },
    }));
    expect(next.grants.find((g) => g.action === "contents.write")?.paths).toEqual(["src/**"]);
  });

  // widenRefusal's `grants` entry: "the operation is not granted at all;
  // granting it is a new mandate, not a widen". A one-click button that adds
  // merge_pull_request makes the grant list decorative, and the proxy already
  // declines to offer one — pauseRecord returns no request for mandate.grants.
  it("refuses to introduce an operation the mandate does not already grant", () => {
    expect(() => applyWiden(current, req({
      action: "pull_request.merge",
      addGrant: { action: "pull_request.merge", resources: ["acme/api"], max: 1 },
    }))).toThrow(/not granted/i);
  });

  it("refuses a widen aimed at a different mandate", () => {
    expect(() => applyWiden(current, req({ mandateId: "some-other-mandate" })))
      .toThrow(/different mandate/i);
  });

  it("refuses a delta whose action disagrees with the request's", () => {
    expect(() => applyWiden(current, req({
      action: "contents.write", addGrant: { action: "repo.read", paths: ["x/**"] },
    }))).toThrow(/disagree/i);
  });

  // A hand-written request can name a facet the catalog says the operation
  // cannot carry. The grant schema rejects it, and the refusal has to read as a
  // reason rather than as a validation dump — R10 asks for a reason.
  it("refuses a facet the operation cannot carry, in words", () => {
    const withRead: Mandate = MandateSchema.parse({
      ...current,
      grants: [{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
    });
    let caught: unknown;
    try {
      applyWiden(withRead, req({
        action: "repo.read",
        addGrant: { action: "repo.read", paths: ["src/**"] },
      }));
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("repo.read");
    expect(message).toMatch(/cannot be constrained by paths/);
    expect(message).not.toMatch(/ZodError|\[\s*\{/);
  });

  it("refuses an empty delta, which looks actionable and is not", () => {
    expect(() => applyWiden(current, req({ addGrant: {} }))).toThrow(/nothing/i);
    expect(() => applyWiden(current, req({ addGrant: { action: "contents.write" } })))
      .toThrow(/nothing/i);
  });

  it("never changes expiry", () => {
    expect(applyWiden(current, req()).expiresInMinutes).toBe(current.expiresInMinutes);
  });

  it("never changes the destination list", () => {
    expect(applyWiden(current, req()).destinations).toEqual(current.destinations);
  });

  it("never weakens a deny list", () => {
    const next = applyWiden(current, req());
    expect(next.grants.find((g) => g.action === "contents.write")?.denyPaths)
      .toEqual([".github/workflows/**", "**.env**"]);
  });

  it("raises a max rather than lowering it", () => {
    const withMax: Mandate = MandateSchema.parse({
      ...current,
      grants: [
        current.grants[0],
        {
          action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
          branches: ["agent/42-*"], base: "main", max: 2,
        },
      ],
    });
    const up = applyWiden(withMax, req({
      action: "pull_request.create",
      addGrant: { action: "pull_request.create", max: 3 },
    }));
    expect(up.grants.find((g) => g.action === "pull_request.create")?.max).toBe(3);
    const down = applyWiden(withMax, req({
      action: "pull_request.create",
      addGrant: { action: "pull_request.create", max: 1 },
    }));
    expect(down.grants.find((g) => g.action === "pull_request.create")?.max).toBe(2);
  });

  // The structural guarantee: applyWiden produces a proposal, and only
  // validate() can authorize it. A widen outside the ceiling is still refused.
  it("produces something the ceiling still rejects when the delta is too wide", () => {
    const widened = applyWiden(current, req({
      addGrant: { action: "contents.write", branches: ["main"] },
    }));
    const r = validate(widened as ProposedMandate, {
      ceiling, authority: { login: "alice", level: "push" },
    });
    expect(r.ok).toBe(false);
  });

  it("produces something the ceiling accepts when the delta fits", () => {
    const widened = applyWiden(current, req());
    const r = validate(widened as ProposedMandate, {
      ceiling, authority: { login: "alice", level: "push" },
    });
    expect(r.ok).toBe(true);
  });
});

describe("runWiden", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-widen-"));
  const mandateYaml = join(dir, "mandate.yaml");
  writeFileSync(mandateYaml, `mandate: fix-issue-42
task: t
requestedBy: user:alice
expiresInMinutes: 60
ceiling: org-policy@v12
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["acme/api"]
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    paths: ["src/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
destinations:
  allow: ["github.com/acme/api"]
`);

  const requestFile = (body: unknown): string => {
    const p = join(dir, `req-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  const args = (requestPath: string): WidenArgs => ({
    mandateFile: mandateYaml,
    requestFile: requestPath,
    ceiling: fixturePath("ceilings/org-policy-v12.cedar"),
    schema: fixturePath("ceilings/schema.cedarschema"),
    destinations: fixturePath("ceilings/org-policy-v12.destinations"),
    as: "alice",
    level: "push",
  });

  const run = (body: unknown): { code: number; out: string } => {
    const chunks: string[] = [];
    const code = runWiden(args(requestFile(body)), (s) => chunks.push(s));
    return { code, out: chunks.join("\n") };
  };

  it("accepts a widen that fits the ceiling and prints the new diff", () => {
    const r = run(req());
    expect(r.code).toBe(0);
    expect(r.out).toContain("tests/**");
    expect(r.out).toContain("the fix needs a test");
  });

  it("rejects a widen outside the ceiling and names the clause", () => {
    const r = run(req({ addGrant: { action: "contents.write", branches: ["main"] } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/reject/i);
    expect(r.out).toContain("contents.write");
  });

  it("reads the pause record the proxy emits, not just a bare request", () => {
    const r = run({
      at: "2026-10-06T00:00:00.000Z",
      mandateId: "fix-issue-42",
      tool: "create_or_update_file",
      clause: "contents.write.paths",
      reason: "path tests/a.ts is outside the granted paths src/**",
      observed: { path: "tests/a.ts" },
      widenRequest: req({ addGrant: { action: "contents.write", paths: ["tests/a.ts"] } }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("tests/a.ts");
  });

  it("honours the refusal list, so a deny-path pause is not widenable here either", () => {
    const r = run({
      at: "2026-10-06T00:00:00.000Z",
      mandateId: "fix-issue-42",
      tool: "create_or_update_file",
      clause: "contents.write.denyPaths",
      reason: "path .github/workflows/ci.yml is excluded",
      observed: { path: ".github/workflows/ci.yml" },
      widenRequest: req({
        addGrant: { action: "contents.write", paths: [".github/workflows/**"] },
      }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/floor|deny/i);
  });

  it("refuses a request file that is not a widen request", () => {
    const r = run({ please: "give me everything" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/could not read|not a/i);
  });

  it("refuses a request file smuggling a field the format does not define", () => {
    const r = run({ ...req(), expiresInMinutes: 600 });
    expect(r.code).toBe(2);
  });

  // validate, serve and run name the ceiling they checked against by file and
  // hash; widen re-validates and did not say which -- found reviewing Phase 5.
  it("names the ceiling it re-validated against", () => {
    const r = run(req());
    expect(r.out).toMatch(/Ceiling: org-policy-v12\.cedar, sha256:[0-9a-f]{64}/);
  });

  it("returns 2 when the mandate file cannot be read", () => {
    const chunks: string[] = [];
    const code = runWiden(
      { ...args(requestFile(req())), mandateFile: join(dir, "missing.yaml") },
      (s) => chunks.push(s),
    );
    expect(code).toBe(2);
  });
});
