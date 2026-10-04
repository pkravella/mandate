import { describe, expect, it } from "vitest";
import type { Grant } from "@mandate-dev/schema";
import { applyPrune, prunePrompt } from "./prune.js";

const g = (action: string, extra: Partial<Grant> = {}): Grant =>
  ({ action, enforcedBy: "proxy", resources: ["acme/api"], ...extra });

describe("applyPrune", () => {
  it("keeps only the actions the prune pass named", () => {
    const out = applyPrune([g("repo.read"), g("issue.read"), g("actions.write")], ["repo.read", "issue.read"]);
    expect(out.map((x) => x.action)).toEqual(["repo.read", "issue.read"]);
  });

  it("re-adds a prerequisite the prune pass tried to drop", () => {
    // Dropping repo.read while keeping contents.write would break the task.
    const out = applyPrune([g("repo.read"), g("branch.create"), g("contents.write")], ["contents.write"]);
    expect(out.map((x) => x.action)).toContain("repo.read");
    expect(out.map((x) => x.action)).toContain("branch.create");
  });

  it("never re-adds anything that was not in the covered set", () => {
    const out = applyPrune([g("repo.read")], ["repo.read", "pull_request.merge"]);
    expect(out.map((x) => x.action)).toEqual(["repo.read"]);
  });

  it("returns an empty list when nothing is kept, rather than inventing grants", () => {
    expect(applyPrune([g("repo.read")], [])).toEqual([]);
  });

  it("ignores an action the prune pass invented that is not in the catalog", () => {
    expect(applyPrune([g("repo.read")], ["repo.read", "repo.yolo"]).map((x) => x.action))
      .toEqual(["repo.read"]);
  });

  // Pruning a dependent can let a re-added prerequisite be narrower than the
  // covered set made it: once the only silent dependent is gone, the facet the
  // remaining ones share can be applied.
  it("narrows a re-added prerequisite once the silent dependent is pruned", () => {
    const covered = [
      g("repo.read"),
      g("branch.create"),
      g("contents.write", { branches: ["agent/42-fix"] }),
      g("contents.delete"),
    ];
    const out = applyPrune(covered, ["contents.write"]);
    expect(out.find((x) => x.action === "branch.create")?.branches).toEqual(["agent/42-fix"]);
  });

  // Narrowing only. A facet the covered grant already carries is never swapped
  // for one derived from the kept dependents, because the two are not ordered.
  it("never replaces a facet the covered grant already carries", () => {
    const covered = [
      g("repo.read"),
      g("branch.create", { branches: ["agent/*"] }),
      g("contents.write", { branches: ["agent/42-fix"] }),
    ];
    const out = applyPrune(covered, ["contents.write"]);
    expect(out.find((x) => x.action === "branch.create")?.branches).toEqual(["agent/*"]);
  });

  it("leaves an explicitly kept grant exactly as it was", () => {
    const write = g("contents.write", { branches: ["agent/42-fix"] });
    const out = applyPrune([g("repo.read"), g("branch.create"), write], ["contents.write", "branch.create"]);
    expect(out.find((x) => x.action === "branch.create")?.branches).toBeUndefined();
  });
});

describe("prunePrompt", () => {
  const p = prunePrompt("Fix issue #42 and open a PR", [
    g("contents.write", { branches: ["agent/42-fix"] }),
    g("actions.write"),
  ]);

  it("names the task and every covered grant", () => {
    expect(p).toContain("Fix issue #42 and open a PR");
    expect(p).toContain("contents.write");
    expect(p).toContain("actions.write");
    expect(p).toContain("agent/42-fix");
  });

  it("tells the model prerequisites are re-added for it", () => {
    expect(p).toMatch(/prerequisite/i);
  });
});
