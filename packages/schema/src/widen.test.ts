import { describe, expect, it } from "vitest";
import {
  WidenInputSchema, WidenRequestSchema, widenRefusal, widenRequestOf,
} from "./widen.js";

const request = {
  mandateId: "fix-issue-42",
  action: "contents.write",
  addGrant: { action: "contents.write", paths: ["tests/**"] },
  justification: "the fix needs a test",
};

describe("widenRefusal", () => {
  // The refusal list is the contract, and it has to be readable by whoever
  // *applies* a widen as well as by whoever offers one. Offering is not the
  // only way a request reaches the validator — a file on disk is.
  it("refuses the clauses a widen is the wrong answer for", () => {
    expect(widenRefusal("contents.write.denyPaths")).toMatch(/floor|deny/i);
    expect(widenRefusal("mandate.expiry")).toMatch(/expired/i);
    expect(widenRefusal("mandate.grants")).toMatch(/not granted/i);
    expect(widenRefusal("mandate.internal")).toMatch(/bug/i);
    expect(widenRefusal("destinations.allow")).toMatch(/where data may go/i);
  });

  it("offers no refusal for a clause a widen can answer", () => {
    expect(widenRefusal("contents.write.paths")).toBeUndefined();
    expect(widenRefusal("contents.write.branches")).toBeUndefined();
    expect(widenRefusal("pull_request.create.max")).toBeUndefined();
  });
});

describe("WidenRequestSchema", () => {
  it("accepts a request the proxy would emit", () => {
    expect(WidenRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a request with no justification", () => {
    expect(() => WidenRequestSchema.parse({ ...request, justification: "" })).toThrow();
  });

  it("rejects an unknown field, so a hand-edited request cannot smuggle one", () => {
    expect(() => WidenRequestSchema.parse({ ...request, expiresInMinutes: 600 })).toThrow();
  });

  it("rejects an addGrant field that is not a grant facet", () => {
    expect(() => WidenRequestSchema.parse({
      ...request, addGrant: { action: "contents.write", enforcedBy: "sandbox", bogus: 1 },
    })).toThrow();
  });

  // A widen is a delta on facets. Expiry is not a facet, and a request cannot
  // express one: the structural fact is worth pinning, because a check can be
  // removed and a type cannot.
  // The guarantee is "cannot express", not "expressed and ignored": a field
  // that parses and is silently dropped is one a reviewer could believe took
  // effect.
  it("has no way to express a deny-list change", () => {
    expect(() => WidenRequestSchema.parse({
      ...request,
      addGrant: { action: "contents.write", denyPaths: [] },
    })).toThrow();
    expect(() => WidenRequestSchema.parse({
      ...request,
      addGrant: { action: "contents.write", denyPaths: ["src/**"] },
    })).toThrow();
  });

  it("has no way to claim a different enforcement layer", () => {
    expect(() => WidenRequestSchema.parse({
      ...request,
      addGrant: { action: "contents.write", paths: ["x/**"], enforcedBy: "token" },
    })).toThrow();
  });

  it("has no way to express an expiry change", () => {
    const parsed = WidenRequestSchema.parse(request);
    expect(Object.keys(parsed.addGrant)).not.toContain("expiresInMinutes");
    expect(parsed).not.toHaveProperty("expiresInMinutes");
  });
});

describe("widenRequestOf", () => {
  it("reads a bare widen request", () => {
    const r = widenRequestOf(WidenInputSchema.parse(request));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a request");
    expect(r.request.action).toBe("contents.write");
  });

  // What the proxy actually writes is a PauseRecord. Making runWiden read that
  // is what closes R10's loop: nothing in between has to transcribe it.
  it("reads the request out of a pause record", () => {
    const r = widenRequestOf(WidenInputSchema.parse({
      at: "2026-10-06T00:00:00.000Z",
      mandateId: "fix-issue-42",
      tool: "create_or_update_file",
      clause: "contents.write.paths",
      reason: "path tests/a.ts is outside the granted paths src/**",
      observed: { path: "tests/a.ts" },
      widenRequest: request,
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a request");
    expect(r.request.addGrant.paths).toEqual(["tests/**"]);
  });

  // A pause the proxy declined to offer a widen for must stay declined when
  // the file reaches the CLI. Otherwise the refusal list only governs the
  // suggestion and not the act.
  it("refuses a pause record whose clause is on the refusal list", () => {
    const r = widenRequestOf(WidenInputSchema.parse({
      at: "2026-10-06T00:00:00.000Z",
      mandateId: "fix-issue-42",
      tool: "merge_pull_request",
      clause: "mandate.grants",
      reason: "merge_pull_request is not granted",
      observed: {},
    }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal).toMatch(/not granted/i);
  });

  // A *widenable* clause with nothing attached. The refusal-list case above
  // returns before this branch is reached, so without this the branch is
  // untested and an empty pause would be treated as actionable.
  it("refuses a widenable pause that carries no request, because there is nothing to review", () => {
    const r = widenRequestOf(WidenInputSchema.parse({
      at: "2026-10-06T00:00:00.000Z",
      mandateId: "fix-issue-42",
      tool: "create_or_update_file",
      clause: "contents.write.paths",
      reason: "path tests/a.ts is outside the granted paths src/**",
      observed: {},
    }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal).toMatch(/nothing to review/i);
  });

  it("refuses a deny-path pause even if a request was attached by hand", () => {
    const r = widenRequestOf(WidenInputSchema.parse({
      at: "2026-10-06T00:00:00.000Z",
      mandateId: "fix-issue-42",
      tool: "create_or_update_file",
      clause: "contents.write.denyPaths",
      reason: "path .github/workflows/ci.yml is excluded",
      observed: { path: ".github/workflows/ci.yml" },
      widenRequest: {
        ...request,
        addGrant: { action: "contents.write", paths: [".github/workflows/**"] },
      },
    }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal).toMatch(/floor|deny/i);
  });
});
