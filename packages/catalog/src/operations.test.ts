import { describe, expect, it } from "vitest";
import {
  OPERATIONS, getOperation, requireOperation, operationsForMcpTool,
  highRiskOps, atLeast, UnknownOperationError,
  TOOLSET_REQUIRED, unreachableOperations,
} from "./operations.js";

describe("catalog", () => {
  it("covers at least the 40 operations the PRD calls for", () => {
    expect(OPERATIONS.length).toBeGreaterThanOrEqual(40);
  });

  it("has unique operation ids", () => {
    const ids = OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves the mandate example's grants", () => {
    for (const id of ["repo.read", "branch.create", "contents.write", "pull_request.create"]) {
      expect(getOperation(id), id).toBeDefined();
    }
  });

  it("classifies merge, secret reads and workflow writes as elevated or forbidden", () => {
    for (const id of ["pull_request.merge", "secrets.read", "actions.write", "repo.delete"]) {
      expect(requireOperation(id).risk, id).toMatch(/elevated|forbidden/);
    }
  });

  it("maps real GitHub MCP tool names back to operations", () => {
    expect(operationsForMcpTool("merge_pull_request").map((o) => o.id)).toContain("pull_request.merge");
    expect(operationsForMcpTool("create_or_update_file").map((o) => o.id)).toContain("contents.write");
    expect(operationsForMcpTool("create_branch").map((o) => o.id)).toContain("branch.create");
  });

  // Risk class and GitHub App permission level are independent axes. Risk is
  // about consequence; permission level is about whether the call mutates.
  // Conflating them would force a high-risk read such as secrets.read to
  // request write access it does not need -- the exact over-granting Mandate
  // exists to prevent.
  it("gives every write-risk operation a write permission level", () => {
    for (const op of OPERATIONS.filter((o) => o.risk === "write")) {
      expect(op.permissionLevel, op.id).toBe("write");
    }
  });

  it("gives every read-risk operation a read permission level", () => {
    for (const op of OPERATIONS.filter((o) => o.risk === "read")) {
      expect(op.permissionLevel, op.id).toBe("read");
    }
  });

  it("allows a high-risk operation to still be a read", () => {
    const secretsRead = requireOperation("secrets.read");
    expect(secretsRead.risk).toBe("forbidden");
    expect(secretsRead.permissionLevel).toBe("read");
  });

  it("requires at least push for anything that writes code", () => {
    expect(requireOperation("contents.write").minUserLevel).toBe("push");
    expect(requireOperation("repo.read").minUserLevel).toBe("pull");
  });

  // A floor, not a ceiling: an operation may legitimately require more than
  // push. branch.protect needs admin, and asserting that push is always
  // sufficient would force it to be under-protected.
  it("never lets a write to code or refs be reachable below push", () => {
    for (const op of OPERATIONS) {
      if (op.permissionLevel !== "write") continue;
      if (op.resourceType !== "path" && op.resourceType !== "branch") continue;
      expect(atLeast("triage", op.minUserLevel), op.id).toBe(false);
      expect(atLeast("pull", op.minUserLevel), op.id).toBe(false);
    }
  });

  it("orders user levels so push satisfies pull but not admin", () => {
    expect(atLeast("push", "pull")).toBe(true);
    expect(atLeast("push", "push")).toBe(true);
    expect(atLeast("push", "admin")).toBe(false);
    expect(atLeast("none", "pull")).toBe(false);
  });

  it("lists every prerequisite as a real operation", () => {
    for (const op of OPERATIONS) {
      for (const p of op.prerequisites) {
        expect(getOperation(p), `${op.id} -> ${p}`).toBeDefined();
      }
    }
  });

  it("has no prerequisite cycles", () => {
    const seen = new Map<string, "visiting" | "done">();
    const walk = (id: string, path: string[]): void => {
      const state = seen.get(id);
      if (state === "done") return;
      if (state === "visiting") throw new Error(`cycle: ${[...path, id].join(" -> ")}`);
      seen.set(id, "visiting");
      for (const p of requireOperation(id).prerequisites) walk(p, [...path, id]);
      seen.set(id, "done");
    };
    expect(() => { for (const op of OPERATIONS) walk(op.id, []); }).not.toThrow();
  });

  it("never lists a forbidden-risk operation as a prerequisite", () => {
    // A prerequisite is acquired as a side effect of granting something else.
    // Anything dangerous must be requested explicitly and reviewed.
    for (const op of OPERATIONS) {
      for (const p of op.prerequisites) {
        expect(requireOperation(p).risk, `${op.id} -> ${p}`).not.toBe("forbidden");
      }
    }
  });

  it("throws a typed error for unknown ids", () => {
    expect(() => requireOperation("nope.nope")).toThrow(UnknownOperationError);
  });

  it("surfaces the high-risk set for the derived notGrantedNotable display", () => {
    expect(highRiskOps().map((o) => o.id)).toContain("pull_request.merge");
    expect(highRiskOps().map((o) => o.id)).not.toContain("repo.read");
  });
});

// The two names below were wrong until a live `tools/list` against
// ghcr.io/github/github-mcp-server:latest caught them. `get_repository` does
// not exist at all, and the review tool is `pull_request_review_write`.
describe("mcpTools against the real server", () => {
  it("does not name a tool the server has never had", () => {
    const all = OPERATIONS.flatMap((o) => [...o.mcpTools]);
    expect(all).not.toContain("get_repository");
    expect(all).not.toContain("create_pull_request_review");
  });

  it("reaches pull request review through the tool that exists", () => {
    expect(requireOperation("pull_request.review").mcpTools).toEqual(["pull_request_review_write"]);
  });

  it("leaves repo.read with three real tools", () => {
    expect(requireOperation("repo.read").mcpTools)
      .toEqual(["get_file_contents", "list_branches", "search_code"]);
  });
});

describe("unreachableOperations", () => {
  // The silent failure this exists to surface: the proxy filters tools/list to
  // what upstream offers, so a grant whose tools are not exposed means the
  // agent never sees the tool and the task fails with no explanation.
  it("names a granted operation the running server cannot reach", () => {
    const exposedByDefault = ["get_file_contents", "list_branches", "search_code", "create_branch"];
    expect(unreachableOperations(["repo.read", "actions.read"], exposedByDefault))
      .toEqual(["actions.read"]);
  });

  it("says nothing when every grant has a tool on the server", () => {
    expect(unreachableOperations(["repo.read"], ["get_file_contents"])).toEqual([]);
  });

  // branch.delete has no MCP tool by design; the token is its only control and
  // enforcementReport already reports that. It is not an upstream problem.
  it("does not blame the server for an operation that has no tool at all", () => {
    expect(unreachableOperations(["branch.delete"], [])).toEqual([]);
  });

  it("ignores an unknown action rather than throwing", () => {
    expect(unreachableOperations(["repo.yolo"], [])).toEqual([]);
  });

  it("names the toolset each gated operation needs", () => {
    expect(TOOLSET_REQUIRED["actions.read"]).toBe("actions");
    for (const id of Object.keys(TOOLSET_REQUIRED)) {
      expect(getOperation(id), `${id} is not a catalog operation`).toBeDefined();
    }
  });
});
