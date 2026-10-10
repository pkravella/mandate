import { describe, expect, it } from "vitest";
import { MandateSchema, type Mandate } from "@mandate-dev/schema";
import {
  authorityCut, derivedNotGrantedNotable, renderPermissionDiff, renderRejections,
} from "./diff.js";

const m: Mandate = MandateSchema.parse({
  mandate: "fix-issue-42", task: "Fix issue #42 and open a PR",
  requestedBy: "user:alice", expiresInMinutes: 30, ceiling: "org-policy@v12",
  grants: [
    { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
    {
      action: "contents.write", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], paths: ["**"],
      denyPaths: [".github/workflows/**", "**.env**"],
    },
    {
      action: "pull_request.create", enforcedBy: "proxy", resources: ["acme/api"],
      branches: ["agent/42-*"], base: "main", max: 1,
    },
  ],
  destinations: { allow: ["github.com/acme/api"] },
});

describe("renderPermissionDiff", () => {
  const out = renderPermissionDiff(m, { color: false });

  // Task 5.5. `max: 1` on a pull request reads like "this task may open one".
  // It is one per session, and the diff is where a reviewer reads it.
  it("says a max is per session", () => {
    expect(out).toMatch(/at most\s+1 per session/);
  });

  it("leads with the task and the expiry", () => {
    expect(out).toContain("Fix issue #42 and open a PR");
    expect(out).toContain("30 minutes");
  });

  it("shows one line per grant with its constraints", () => {
    expect(out).toContain("contents.write");
    expect(out).toContain("agent/42-*");
    expect(out).toContain(".github/workflows/**");
  });

  it("marks what the token enforces versus what only the proxy enforces (D4)", () => {
    expect(out).toMatch(/token/);
    expect(out).toMatch(/proxy/);
    expect(out).toContain("GitHub tokens cannot limit by branch or path");
  });

  it("lists notable denied operations as derived, not authoritative", () => {
    expect(out).toContain("pull_request.merge");
    expect(out).toContain("derived");
  });

  it("states deny-by-default explicitly", () => {
    expect(out).toContain("Anything not listed is denied");
  });

  it("emits no ANSI escapes when colour is off", () => {
    expect(out).not.toMatch(/\u001b\[/);
  });
});

// Decision D4: "the authority-cut metric is reported twice -- once at the token
// layer, once at the proxy layer -- because a single number here would be
// marketing, not measurement." The plan reported one number.
describe("authorityCut", () => {
  it("reports the token layer and the proxy layer separately", () => {
    const cut = authorityCut(m, { repositories: 20 });
    expect(cut.token).toBeDefined();
    expect(cut.proxy).toBeDefined();
    expect(cut.token.cutPercent).not.toBe(cut.proxy.cutPercent);
  });

  // Decision D7 counts authority as |{(operation, repository)}|, not as
  // operations. The baseline is installed org-wide and the mandate is one repo,
  // which is where most of the cut actually comes from.
  it("counts (operation, repository) pairs, not operations", () => {
    const narrow = authorityCut(m, { repositories: 1 });
    const wide = authorityCut(m, { repositories: 20 });
    expect(wide.baseline).toBe(narrow.baseline * 20);
    expect(wide.proxy.reachable).toBe(narrow.proxy.reachable);
  });

  it("prints both numerator and denominator so the figure is arguable", () => {
    const cut = authorityCut(m, { repositories: 20 });
    expect(cut.proxy.reachable).toBeGreaterThan(0);
    expect(cut.baseline).toBeGreaterThan(cut.proxy.reachable);
    expect(cut.proxy.cutPercent)
      .toBe(Math.round(((cut.baseline - cut.proxy.reachable) / cut.baseline) * 100));
  });

  // The token cannot express an operation list, only permissions. Anything
  // sharing a granted permission at a sufficient level is reachable with it.
  it("counts every operation the token's permissions reach, not just the granted ones", () => {
    const cut = authorityCut(m, { repositories: 1 });
    expect(cut.token.reachable).toBeGreaterThan(cut.proxy.reachable);
  });

  it("says the token layer is the wider of the two", () => {
    const cut = authorityCut(m, { repositories: 20 });
    expect(cut.token.cutPercent).toBeLessThan(cut.proxy.cutPercent);
  });

  it("reports both layers in the rendered diff", () => {
    const out = renderPermissionDiff(m, { color: false, repositories: 20 });
    expect(out).toMatch(/AUTHORITY CUT/);
    expect(out.match(/\d+%/g)?.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain("token layer");
    expect(out).toContain("proxy layer");
  });

  it("says so rather than inventing a repository count when none is given", () => {
    const out = renderPermissionDiff(m, { color: false });
    expect(out).toContain("one repository");
  });
});

describe("derivedNotGrantedNotable", () => {
  it("includes high-risk operations the mandate does not grant", () => {
    expect(derivedNotGrantedNotable(m)).toContain("pull_request.merge");
    expect(derivedNotGrantedNotable(m)).toContain("secrets.read");
  });

  it("excludes anything the mandate does grant", () => {
    expect(derivedNotGrantedNotable(m)).not.toContain("contents.write");
  });
});

describe("renderRejections", () => {
  it("names the clause and the counterexample so the stop is explainable (R10)", () => {
    const out = renderRejections([{
      code: "not-contained", grantIndex: 1, clause: "allow-agent-branch-writes",
      counterexample: "main", message: "grant contents.write is wider than ceiling clause",
    }], m);
    expect(out).toContain("allow-agent-branch-writes");
    expect(out).toContain("main");
    expect(out).toContain("grant #1");
  });

  // The documented wart: a rejection caused by an *omitted* constraint reports
  // the empty string as its counterexample, because `**` matches "" and
  // `agent/**` does not. `if (r.counterexample)` is falsy on "", so the plan
  // dropped the line entirely -- the one case where the reader most needs it.
  it("renders an empty counterexample as any value, including none", () => {
    const out = renderRejections([{
      code: "not-contained", grantIndex: 1, clause: "allow-branch-create",
      counterexample: "", message: "grant branch.create is wider than the ceiling",
    }], m);
    expect(out).toContain("any value, including none");
    expect(out).not.toMatch(/counterexample:\s*$/m);
  });

  it("names the action alongside the index, so the number is unambiguous", () => {
    const out = renderRejections([{
      code: "not-contained", grantIndex: 1, message: "x",
    }], m);
    expect(out).toContain("contents.write");
  });

  it("works without a mandate to look the action up in", () => {
    expect(renderRejections([{ code: "lint", message: "no-secret-access: nope" }]))
      .toContain("no-secret-access");
  });

  it("says plainly that nothing was minted", () => {
    expect(renderRejections([{ code: "lint", message: "x" }])).toContain("Nothing was minted");
  });
});
