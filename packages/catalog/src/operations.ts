/**
 * The GitHub operation catalog: the vocabulary every other Mandate package
 * speaks. Pure data with no I/O and no dependencies, so it can be published as
 * part of the shared contract format.
 *
 * Each operation ties together four namespaces that must not drift apart:
 * Mandate's own action atom, the GitHub REST route, the tool name exposed by
 * github/github-mcp-server, and the GitHub App permission a token needs.
 */

export type RiskClass = "read" | "write" | "elevated" | "forbidden";
export type UserLevel = "none" | "pull" | "triage" | "push" | "maintain" | "admin";
export type ResourceType =
  | "repo" | "branch" | "path" | "issue" | "pull_request" | "workflow" | "secret";
export type GhPermission =
  | "contents" | "issues" | "pull_requests" | "actions" | "workflows"
  | "metadata" | "secrets" | "administration" | "checks";
export type ConstraintKind =
  | "resources" | "branches" | "paths" | "base" | "max" | "destinations";

export type OperationId = string & { readonly __brand?: "OperationId" };

export interface Operation {
  readonly id: OperationId;
  readonly summary: string;
  /** GitHub REST route, for docs and for the Cedar and OPA exports. */
  readonly restRoute: string;
  /** Tool names exposed by github/github-mcp-server that reach this operation. */
  readonly mcpTools: readonly string[];
  readonly resourceType: ResourceType;
  readonly permission: GhPermission;
  /**
   * Whether the GitHub App token needs read or write on `permission`. This is
   * independent of `risk`: secrets.read is forbidden-risk but only needs read,
   * and requesting write for it would over-grant.
   */
  readonly permissionLevel: "read" | "write";
  readonly minUserLevel: UserLevel;
  readonly risk: RiskClass;
  /** Operations this one cannot work without. Never forbidden-risk. */
  readonly prerequisites: readonly OperationId[];
  readonly constrainable: readonly ConstraintKind[];
}

export class UnknownOperationError extends Error {
  constructor(public readonly id: string) {
    super(`unknown operation: ${id}`);
    this.name = "UnknownOperationError";
  }
}

export const USER_LEVEL_ORDER: readonly UserLevel[] = [
  "none", "pull", "triage", "push", "maintain", "admin",
];

export function atLeast(actual: UserLevel, required: UserLevel): boolean {
  return USER_LEVEL_ORDER.indexOf(actual) >= USER_LEVEL_ORDER.indexOf(required);
}

const op = (o: Operation): Operation => o;

export const OPERATIONS: readonly Operation[] = [
  // ---- repository and metadata -------------------------------------------
  op({ id: "repo.read", summary: "Read repository metadata, code, issues and pull requests",
    restRoute: "GET /repos/{owner}/{repo}",
    mcpTools: ["get_file_contents", "list_branches", "search_code", "get_repository"],
    resourceType: "repo", permission: "contents", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "repo.list", summary: "List repositories visible to the installation",
    restRoute: "GET /installation/repositories", mcpTools: ["search_repositories"],
    resourceType: "repo", permission: "metadata", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "repo.create", summary: "Create a repository",
    restRoute: "POST /orgs/{org}/repos", mcpTools: ["create_repository"],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "elevated", prerequisites: [], constrainable: ["resources", "max"] }),
  op({ id: "repo.delete", summary: "Delete a repository",
    restRoute: "DELETE /repos/{owner}/{repo}", mcpTools: [],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "repo.fork", summary: "Fork a repository",
    restRoute: "POST /repos/{owner}/{repo}/forks", mcpTools: ["fork_repository"],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "push",
    risk: "elevated", prerequisites: ["repo.read"], constrainable: ["resources", "destinations", "max"] }),

  // ---- contents -----------------------------------------------------------
  op({ id: "contents.read", summary: "Read file contents at a ref",
    restRoute: "GET /repos/{owner}/{repo}/contents/{path}", mcpTools: ["get_file_contents"],
    resourceType: "path", permission: "contents", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources", "paths", "branches"] }),
  op({ id: "contents.write", summary: "Create or update file contents on a branch",
    restRoute: "PUT /repos/{owner}/{repo}/contents/{path}",
    mcpTools: ["create_or_update_file", "push_files"],
    resourceType: "path", permission: "contents", permissionLevel: "write", minUserLevel: "push",
    risk: "write", prerequisites: ["repo.read", "branch.create"],
    constrainable: ["resources", "paths", "branches"] }),
  op({ id: "contents.delete", summary: "Delete a file on a branch",
    restRoute: "DELETE /repos/{owner}/{repo}/contents/{path}", mcpTools: ["delete_file"],
    resourceType: "path", permission: "contents", permissionLevel: "write", minUserLevel: "push",
    risk: "write", prerequisites: ["repo.read", "branch.create"],
    constrainable: ["resources", "paths", "branches"] }),
  op({ id: "commit.read", summary: "Read commits and diffs",
    restRoute: "GET /repos/{owner}/{repo}/commits", mcpTools: ["list_commits", "get_commit"],
    resourceType: "repo", permission: "contents", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),

  // ---- branches and refs --------------------------------------------------
  op({ id: "branch.read", summary: "List or read branches",
    restRoute: "GET /repos/{owner}/{repo}/branches", mcpTools: ["list_branches"],
    resourceType: "branch", permission: "contents", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources", "branches"] }),
  op({ id: "branch.create", summary: "Create a branch",
    restRoute: "POST /repos/{owner}/{repo}/git/refs", mcpTools: ["create_branch"],
    resourceType: "branch", permission: "contents", permissionLevel: "write", minUserLevel: "push",
    risk: "write", prerequisites: ["repo.read"], constrainable: ["resources", "branches"] }),
  op({ id: "branch.delete", summary: "Delete a branch",
    restRoute: "DELETE /repos/{owner}/{repo}/git/refs/{ref}", mcpTools: [],
    resourceType: "branch", permission: "contents", permissionLevel: "write", minUserLevel: "push",
    risk: "elevated", prerequisites: ["branch.read"], constrainable: ["resources", "branches"] }),
  op({ id: "branch.protect", summary: "Change branch protection",
    restRoute: "PUT /repos/{owner}/{repo}/branches/{branch}/protection", mcpTools: [],
    resourceType: "branch", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources", "branches"] }),

  // ---- pull requests ------------------------------------------------------
  op({ id: "pull_request.read", summary: "Read pull requests, diffs and reviews",
    restRoute: "GET /repos/{owner}/{repo}/pulls/{number}",
    mcpTools: ["pull_request_read", "list_pull_requests"],
    resourceType: "pull_request", permission: "pull_requests", permissionLevel: "read",
    minUserLevel: "pull", risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),
  op({ id: "pull_request.create", summary: "Open a pull request",
    restRoute: "POST /repos/{owner}/{repo}/pulls", mcpTools: ["create_pull_request"],
    resourceType: "pull_request", permission: "pull_requests", permissionLevel: "write",
    minUserLevel: "push", risk: "write", prerequisites: ["branch.create", "contents.write"],
    constrainable: ["resources", "branches", "base", "max"] }),
  op({ id: "pull_request.update", summary: "Edit a pull request title, body or state",
    restRoute: "PATCH /repos/{owner}/{repo}/pulls/{number}", mcpTools: ["update_pull_request"],
    resourceType: "pull_request", permission: "pull_requests", permissionLevel: "write",
    minUserLevel: "push", risk: "write", prerequisites: ["pull_request.read"],
    constrainable: ["resources", "max"] }),
  op({ id: "pull_request.comment", summary: "Comment on a pull request",
    restRoute: "POST /repos/{owner}/{repo}/issues/{number}/comments", mcpTools: ["add_issue_comment"],
    resourceType: "pull_request", permission: "pull_requests", permissionLevel: "write",
    minUserLevel: "triage", risk: "write", prerequisites: ["pull_request.read"],
    constrainable: ["resources", "max"] }),
  op({ id: "pull_request.review", summary: "Submit a pull request review",
    restRoute: "POST /repos/{owner}/{repo}/pulls/{number}/reviews",
    mcpTools: ["create_pull_request_review"],
    resourceType: "pull_request", permission: "pull_requests", permissionLevel: "write",
    minUserLevel: "triage", risk: "elevated", prerequisites: ["pull_request.read"],
    constrainable: ["resources", "max"] }),
  op({ id: "pull_request.merge", summary: "Merge a pull request",
    restRoute: "PUT /repos/{owner}/{repo}/pulls/{number}/merge", mcpTools: ["merge_pull_request"],
    resourceType: "pull_request", permission: "pull_requests", permissionLevel: "write",
    minUserLevel: "push", risk: "forbidden", prerequisites: ["pull_request.read"],
    constrainable: ["resources", "base", "max"] }),
  op({ id: "pull_request.close", summary: "Close a pull request without merging",
    restRoute: "PATCH /repos/{owner}/{repo}/pulls/{number}", mcpTools: ["update_pull_request"],
    resourceType: "pull_request", permission: "pull_requests", permissionLevel: "write",
    minUserLevel: "push", risk: "elevated", prerequisites: ["pull_request.read"],
    constrainable: ["resources", "max"] }),

  // ---- issues -------------------------------------------------------------
  op({ id: "issue.read", summary: "Read issues and their comments",
    restRoute: "GET /repos/{owner}/{repo}/issues/{number}",
    mcpTools: ["issue_read", "list_issues", "search_issues"],
    resourceType: "issue", permission: "issues", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),
  op({ id: "issue.create", summary: "Open an issue",
    restRoute: "POST /repos/{owner}/{repo}/issues", mcpTools: ["issue_write"],
    resourceType: "issue", permission: "issues", permissionLevel: "write", minUserLevel: "triage",
    risk: "write", prerequisites: ["repo.read"], constrainable: ["resources", "max"] }),
  op({ id: "issue.update", summary: "Edit an issue",
    restRoute: "PATCH /repos/{owner}/{repo}/issues/{number}", mcpTools: ["issue_write"],
    resourceType: "issue", permission: "issues", permissionLevel: "write", minUserLevel: "triage",
    risk: "write", prerequisites: ["issue.read"], constrainable: ["resources", "max"] }),
  op({ id: "issue.comment", summary: "Comment on an issue",
    restRoute: "POST /repos/{owner}/{repo}/issues/{number}/comments", mcpTools: ["add_issue_comment"],
    resourceType: "issue", permission: "issues", permissionLevel: "write", minUserLevel: "triage",
    risk: "write", prerequisites: ["issue.read"], constrainable: ["resources", "max"] }),
  op({ id: "issue.close", summary: "Close an issue",
    restRoute: "PATCH /repos/{owner}/{repo}/issues/{number}", mcpTools: ["issue_write"],
    resourceType: "issue", permission: "issues", permissionLevel: "write", minUserLevel: "triage",
    risk: "write", prerequisites: ["issue.read"], constrainable: ["resources", "max"] }),
  op({ id: "issue.label", summary: "Add or remove issue labels",
    restRoute: "POST /repos/{owner}/{repo}/issues/{number}/labels", mcpTools: ["issue_write"],
    resourceType: "issue", permission: "issues", permissionLevel: "write", minUserLevel: "triage",
    risk: "write", prerequisites: ["issue.read"], constrainable: ["resources", "max"] }),
  op({ id: "issue.assign", summary: "Assign an issue",
    restRoute: "POST /repos/{owner}/{repo}/issues/{number}/assignees", mcpTools: ["issue_write"],
    resourceType: "issue", permission: "issues", permissionLevel: "write", minUserLevel: "triage",
    risk: "write", prerequisites: ["issue.read"], constrainable: ["resources", "max"] }),

  // ---- checks and actions -------------------------------------------------
  op({ id: "checks.read", summary: "Read check runs and statuses",
    restRoute: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", mcpTools: ["get_commit"],
    resourceType: "repo", permission: "checks", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),
  op({ id: "actions.read", summary: "Read workflow definitions and run metadata",
    restRoute: "GET /repos/{owner}/{repo}/actions/runs", mcpTools: ["actions_get", "actions_list"],
    resourceType: "workflow", permission: "actions", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),
  op({ id: "actions.logs.read", summary: "Read job logs",
    restRoute: "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", mcpTools: ["get_job_logs"],
    resourceType: "workflow", permission: "actions", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["actions.read"], constrainable: ["resources"] }),
  op({ id: "actions.write", summary: "Trigger, re-run or cancel workflow runs",
    restRoute: "POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches",
    mcpTools: ["actions_run_trigger"],
    resourceType: "workflow", permission: "actions", permissionLevel: "write", minUserLevel: "push",
    risk: "elevated", prerequisites: ["actions.read"], constrainable: ["resources", "max"] }),
  op({ id: "workflows.write", summary: "Create or modify workflow files under .github/workflows",
    restRoute: "PUT /repos/{owner}/{repo}/contents/.github/workflows/{file}",
    mcpTools: ["create_or_update_file", "push_files"],
    resourceType: "workflow", permission: "workflows", permissionLevel: "write", minUserLevel: "push",
    risk: "forbidden", prerequisites: ["contents.write"],
    constrainable: ["resources", "paths", "branches"] }),

  // ---- secrets, variables, environments -----------------------------------
  op({ id: "secrets.read", summary: "Read Actions secret names and values",
    restRoute: "GET /repos/{owner}/{repo}/actions/secrets", mcpTools: [],
    resourceType: "secret", permission: "secrets", permissionLevel: "read", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "secrets.write", summary: "Create or update Actions secrets",
    restRoute: "PUT /repos/{owner}/{repo}/actions/secrets/{name}", mcpTools: [],
    resourceType: "secret", permission: "secrets", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "variables.read", summary: "Read Actions variables",
    restRoute: "GET /repos/{owner}/{repo}/actions/variables", mcpTools: [],
    resourceType: "repo", permission: "actions", permissionLevel: "read", minUserLevel: "push",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),
  op({ id: "environments.write", summary: "Create or modify deployment environments",
    restRoute: "PUT /repos/{owner}/{repo}/environments/{name}", mcpTools: [],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources"] }),

  // ---- collaboration and administration -----------------------------------
  op({ id: "collaborators.read", summary: "Read collaborators and their permission levels",
    restRoute: "GET /repos/{owner}/{repo}/collaborators", mcpTools: [],
    resourceType: "repo", permission: "metadata", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),
  op({ id: "collaborators.write", summary: "Add or remove collaborators",
    restRoute: "PUT /repos/{owner}/{repo}/collaborators/{username}", mcpTools: [],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "webhooks.write", summary: "Create or modify repository webhooks",
    restRoute: "POST /repos/{owner}/{repo}/hooks", mcpTools: [],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources", "destinations"] }),
  op({ id: "rulesets.write", summary: "Create or modify repository rulesets",
    restRoute: "POST /repos/{owner}/{repo}/rulesets", mcpTools: [],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "deploy_keys.write", summary: "Add or remove deploy keys",
    restRoute: "POST /repos/{owner}/{repo}/keys", mcpTools: [],
    resourceType: "repo", permission: "administration", permissionLevel: "write", minUserLevel: "admin",
    risk: "forbidden", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "releases.write", summary: "Create or modify releases and tags",
    restRoute: "POST /repos/{owner}/{repo}/releases", mcpTools: [],
    resourceType: "repo", permission: "contents", permissionLevel: "write", minUserLevel: "push",
    risk: "elevated", prerequisites: ["repo.read"], constrainable: ["resources", "max"] }),
  op({ id: "discussions.read", summary: "Read discussions",
    restRoute: "GET /repos/{owner}/{repo}/discussions", mcpTools: ["list_discussions"],
    resourceType: "repo", permission: "metadata", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: ["repo.read"], constrainable: ["resources"] }),
  op({ id: "notifications.read", summary: "Read notifications",
    restRoute: "GET /notifications", mcpTools: ["list_notifications"],
    resourceType: "repo", permission: "metadata", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: [], constrainable: [] }),
  op({ id: "search.code", summary: "Search code across accessible repositories",
    restRoute: "GET /search/code", mcpTools: ["search_code"],
    resourceType: "repo", permission: "contents", permissionLevel: "read", minUserLevel: "pull",
    risk: "read", prerequisites: [], constrainable: ["resources"] }),
  op({ id: "gist.write", summary: "Create or update a gist",
    restRoute: "POST /gists", mcpTools: ["create_gist"],
    resourceType: "repo", permission: "metadata", permissionLevel: "write", minUserLevel: "pull",
    risk: "forbidden", prerequisites: [], constrainable: ["destinations", "max"] }),
];

const BY_ID = new Map<string, Operation>(OPERATIONS.map((o) => [o.id, o]));

const BY_MCP_TOOL: ReadonlyMap<string, readonly Operation[]> = (() => {
  const m = new Map<string, Operation[]>();
  for (const o of OPERATIONS) {
    for (const t of o.mcpTools) {
      const bucket = m.get(t);
      if (bucket) bucket.push(o);
      else m.set(t, [o]);
    }
  }
  return m;
})();

export function getOperation(id: string): Operation | undefined {
  return BY_ID.get(id);
}

export function requireOperation(id: string): Operation {
  const found = BY_ID.get(id);
  if (!found) throw new UnknownOperationError(id);
  return found;
}

export function operationsForMcpTool(tool: string): readonly Operation[] {
  return BY_MCP_TOOL.get(tool) ?? [];
}

export function highRiskOps(): readonly Operation[] {
  return OPERATIONS.filter((o) => o.risk === "elevated" || o.risk === "forbidden");
}
