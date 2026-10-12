import { getOperation } from "@mandate-dev/catalog";
import type { Grant, ValidatedMandate } from "@mandate-dev/schema";
import type { Backend } from "./rules.js";

/**
 * R12: a mandate as a GitHub Agentic Workflows (gh-aw) configuration -- the
 * frontmatter of a workflow whose agent runs read-only and writes only through
 * `safe-outputs`, which a separate job with its own token carries out.
 *
 * **One workflow per task template, not per task.** gh-aw compiles these
 * limits into the workflow's lock file when it is authored, and `allowed-files`
 * cannot be set at run time, so the output is committed once for a kind of
 * task. That is weaker than Mandate's per-task loop, and the export says so.
 *
 * **Never wider than the mandate.** Anything it cannot express exactly is
 * refused, never approximated outward; where gh-aw can only be narrower, the
 * export is narrower and says where. Every gh-aw default that writes something
 * on its own -- an issue when PR creation fails, run-status comments, failure
 * reports -- is switched off, because none of them is in the mandate.
 *
 * Probed against gh-aw v0.89.21 (its schema and its handlers), not its docs:
 *
 *   - `allowed-files` and `excluded-files` match with `*` stopping at `/` and
 *     `**` crossing it, anchored and case-sensitive: Mandate's glob language.
 *     The job that creates the PR enforces `allowed-files`.
 *   - `allowed-branches` is checked against the name the agent asked for; gh-aw
 *     then normalises it and, unless `preserve-branch-name`, appends a random
 *     suffix. A pattern can admit a name whose normal form falls outside it
 *     ("agent/42-!!" matches agent/42-* and is pushed as "agent/42"), so only
 *     literal names that normalisation leaves unchanged are exported, and the
 *     suffix is switched off. (A lone `*` also matches every branch, slashes
 *     included, in gh-aw's matcher.) It is checked only in
 *     gh-aw's safe-outputs MCP server, which holds because the agent's
 *     container mounts the output file read-only; that is gh-aw's boundary.
 *   - A stacked pull request's base is another branch from the same run and
 *     skips the base allow-list, so stacking is switched off.
 *   - A workflow with no write output gets a `create-issue` output added by
 *     the compiler, so a mandate that writes nothing cannot be exported.
 */
export const GH_AW_VERSION = "v0.89.21";

export interface GhAwRefusal {
  /** Index of the grant, when one grant is the cause. */
  readonly grant?: number;
  readonly action?: string;
  readonly reason: string;
}

export type GhAwResult =
  | {
    readonly ok: true;
    /** The repository the workflow must be committed to: the mandate's only one. */
    readonly repo: string;
    /** The workflow's frontmatter, as an object to serialise as YAML. */
    readonly frontmatter: Readonly<Record<string, unknown>>;
    /** Where the workflow is narrower than the mandate. */
    readonly narrowings: readonly string[];
    /** What the workflow carries that the mandate does not grant: the operator's choices. */
    readonly beyondMandate: readonly string[];
  }
  | { readonly ok: false; readonly refusals: readonly GhAwRefusal[] };

/** Reads the export maps to the agent's read-only GitHub tools, with no argument limits. */
const READS: ReadonlySet<string> = new Set([
  "repo.read", "contents.read", "commit.read", "branch.read", "pull_request.read", "issue.read",
  "checks.read", "actions.read",
]);
/** Written only through one create-pull-request. */
const PR_UNIT: ReadonlySet<string> = new Set(["branch.create", "contents.write", "pull_request.create"]);
const COMMENTS: ReadonlySet<string> = new Set(["issue.comment", "pull_request.comment"]);

/** The catalog's permission names as a workflow's `permissions:` keys. */
const PERMISSION_KEY: Readonly<Record<string, string>> = {
  contents: "contents", issues: "issues", pull_requests: "pull-requests", checks: "checks",
  actions: "actions",
};

const isLiteral = (glob: string): boolean => !glob.includes("*");

/** The workflow's own token, whose `permissions:` bind; a PAT secret's do not. */
const WORKFLOW_TOKEN = "${{ secrets.GITHUB_TOKEN }}";

/**
 * Whether gh-aw's `normalizeBranchName` leaves a name unchanged: it replaces
 * runs of anything but `A-Za-z0-9-_/.` with "-", collapses repeated "-", trims
 * "-" from both ends and truncates at 128. A name already meeting all four is
 * its own normal form, and any other is changed.
 */
const isGhAwNormal = (name: string): boolean =>
  /^[A-Za-z0-9_/.-]+$/.test(name) && !name.includes("--") && !name.startsWith("-")
  && !name.endsWith("-") && name.length <= 128;

/** GitHub's own hosts, which a gh-aw agent reaches through its GitHub tools, not the network. */
const isGitHubDestination = (d: string): boolean =>
  d === "github.com" || d.startsWith("github.com/") || d === "api.github.com" || d.startsWith("api.github.com/");

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function compileGhAw(mandate: ValidatedMandate): GhAwResult {
  const refusals: GhAwRefusal[] = [];
  const narrowings: string[] = [];
  const grants = mandate.grants;
  const refuse = (reason: string, i?: number, g?: Grant): void => {
    refusals.push({ reason, ...(i === undefined ? {} : { grant: i }), ...(g === undefined ? {} : { action: g.action }) });
  };

  // One literal repository: a gh-aw workflow's token and tools act on the
  // repository the workflow lives in.
  const repos = new Set<string>();
  grants.forEach((g, i) => {
    for (const r of g.resources) {
      if (isLiteral(r)) repos.add(r);
      else refuse(`resource "${r}" is a pattern; a gh-aw workflow needs a literal owner/name`, i, g);
    }
  });
  if (repos.size > 1) {
    refuse(
      `the mandate spans ${repos.size} repositories (${[...repos].join(", ")}); a gh-aw workflow `
      + "acts on one repository, the one it lives in",
    );
  }
  const repo = [...repos][0] ?? "";

  for (const d of mandate.destinations.allow) {
    if (!isGitHubDestination(d)) {
      refuse(
        `destination "${d}" is outside GitHub; a gh-aw agent's network egress is the operator's `
        + "choice for the agent itself, not a destination for repository data, so it is not mapped",
      );
    }
  }

  const byAction = new Map<string, { g: Grant; i: number }>();
  grants.forEach((g, i) => {
    byAction.set(g.action, { g, i });
    if (READS.has(g.action)) {
      if (g.paths !== undefined || g.branches !== undefined) {
        refuse(
          `${g.action} is limited by path or branch; gh-aw allows a GitHub tool or not, and cannot `
          + "limit what it reads",
          i, g,
        );
      }
    } else if (!PR_UNIT.has(g.action) && !COMMENTS.has(g.action)) {
      refuse(
        `${g.action} has no gh-aw safe output this export maps (it maps reads, a pull request, and `
        + "comments)",
        i, g,
      );
    }
  });

  // gh-aw uses a PAT from GH_AW_GITHUB_TOKEN when the repository has that
  // secret, and a PAT ignores the workflow's permissions:. Pinned to the
  // workflow token, the permissions gh-aw computes are what bound the writes.
  const safeOutputs: Record<string, unknown> = {
    "github-token": WORKFLOW_TOKEN,
    // Run-status comments on the triggering issue or PR, and failure reports
    // filed as issues: writes gh-aw makes by default, none in the mandate.
    // Threat detection stays on, but by default it files or updates an
    // "[aw] Detection Runs" issue and, on a warning, labels the triggering
    // issue or PR needs-review. Without continue-on-error a detection failure
    // blocks the safe outputs instead of labelling.
    "threat-detection": { "report-as-issue": false, "continue-on-error": false },
    "activation-comments": false,
    "report-failed-jobs": false,
    "report-failure-as-issue": false,
    "report-incomplete": { "create-issue": false },
    "missing-tool": { "create-issue": false },
    "missing-data": { "create-issue": false },
  };

  // ---- the pull request ----------------------------------------------------
  const pr = byAction.get("pull_request.create");
  const unit = [...PR_UNIT].map((a) => byAction.get(a)).filter((x) => x !== undefined);
  if (unit.length > 0 && pr === undefined) {
    refuse(
      "contents.write or branch.create without pull_request.create: gh-aw writes code only through "
      + "a pull request (or to an existing one's branch, which this export does not map)",
    );
  }
  // And the converse: create-pull-request commits whatever the agent changed
  // on a new branch, so without contents.write there is no allowed-files and
  // any file goes in, and without branch.create the branch was never granted.
  if (pr !== undefined) {
    for (const needed of ["contents.write", "branch.create"]) {
      if (!byAction.has(needed)) {
        refuse(
          `pull_request.create without ${needed}: gh-aw's create-pull-request commits the agent's `
          + "changes to a new branch, which needs both contents.write and branch.create",
          pr.i, pr.g,
        );
      }
    }
  }
  if (pr !== undefined) {
    const createPr: Record<string, unknown> = {};
    // branch.create cannot carry a max (the catalog does not constrain it), so
    // the pull request's count is the only one.
    if (pr.g.max === undefined) {
      refuse("pull_request.create has no max; gh-aw needs a count", pr.i, pr.g);
    } else {
      createPr["max"] = pr.g.max;
    }

    // The branch set: every grant that limits branches must limit them alike,
    // since one create-pull-request carries one list.
    const sets = unit.filter((u) => u.g.branches !== undefined).map((u) => u.g.branches as string[]);
    const [first] = sets;
    if (first !== undefined) {
      if (!sets.every((s) => sameSet(s, first))) {
        refuse(
          `branch.create, contents.write and pull_request.create limit branches differently `
          + `(${sets.map((s) => JSON.stringify(s)).join(" vs ")}); gh-aw holds one branch list`,
        );
      } else {
        for (const b of first) {
          if (!isLiteral(b)) {
            refuse(
              `branch pattern "${b}": gh-aw checks the name the agent gives and pushes it `
              + "normalised, so a name inside the pattern can be pushed as one outside it "
              + '("agent/42-!!" matches agent/42-* and is pushed as "agent/42"); name the branch',
            );
          } else if (!isGhAwNormal(b)) {
            refuse(
              `branch "${b}" is not one gh-aw keeps as given: it normalises branch names before `
              + "pushing, so the branch pushed would not be the one the mandate names",
            );
          }
        }
        createPr["allowed-branches"] = [...first];
      }
    }
    // Checked on the name the agent gave; without this, gh-aw pushes that name
    // plus a random suffix -- a branch the mandate did not name.
    createPr["preserve-branch-name"] = true;
    createPr["recreate-ref"] = false;

    if (pr.g.base !== undefined) {
      if (isLiteral(pr.g.base)) createPr["base-branch"] = pr.g.base;
      else refuse(`pull_request.create's base "${pr.g.base}" is a pattern; gh-aw takes one base branch`, pr.i, pr.g);
    }
    // No allowed-base-branches, so the agent cannot override the base; and no
    // stacking, whose base is another branch from the run and skips that check.
    createPr["stacked"] = false;

    const write = byAction.get("contents.write");
    if (write?.g.paths !== undefined) createPr["allowed-files"] = [...write.g.paths];
    if (write?.g.denyPaths !== undefined) {
      createPr["excluded-files"] = [...write.g.denyPaths];
      narrowings.push(
        "excluded-files: a change to a deny path is dropped from the patch and the pull request "
        + "opens without it; the mandate refuses the call instead",
      );
    }
    createPr["protected-files"] = "blocked";
    // Otherwise a CI-trigger PAT (GH_AW_CI_TRIGGER_TOKEN), if the repository
    // has one, pushes an empty commit to the branch after the PR opens.
    createPr["github-token-for-extra-empty-commit"] = "none";
    narrowings.push(
      "github-token-for-extra-empty-commit: none, so a pull request opened with the workflow token "
      + "does not start CI by itself",
    );
    narrowings.push(
      "protected-files: blocked refuses changes to package manifests, agent instruction files and "
      + ".github/ even where the mandate's paths allow them",
    );

    Object.assign(createPr, {
      "fallback-as-issue": false, // an issue holding the patch when the PR fails
      "auto-close-issue": false, // "Fixes #N", which closes an issue on merge
      "auto-merge": false,
      "close-older-pull-requests": false,
    });
    safeOutputs["create-pull-request"] = createPr;
  }

  // ---- comments --------------------------------------------------------------
  const comments = [...COMMENTS].map((a) => byAction.get(a)).filter((x) => x !== undefined);
  if (comments.length > 0) {
    let max = 0;
    for (const c of comments) {
      if (c.g.max === undefined) refuse(`${c.g.action} has no max; gh-aw needs a count`, c.i, c.g);
      else max += c.g.max;
    }
    // The proxy decides add_issue_comment by either grant, each with its own
    // count, so together they allow the sum.
    safeOutputs["add-comment"] = {
      max,
      target: "*",
      issues: byAction.has("issue.comment"),
      "pull-requests": byAction.has("pull_request.comment"),
      discussions: false,
    };
  }

  if (pr === undefined && comments.length === 0 && unit.length === 0) {
    refuse(
      "the mandate writes nothing; gh-aw adds a create-issue output to any workflow without a "
      + "write output, which would grant what the mandate does not",
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };

  // ---- reads -----------------------------------------------------------------
  const tools: string[] = [];
  const permissions: Record<string, string> = {};
  for (const g of grants) {
    const op = getOperation(g.action);
    if (op === undefined) continue;
    const key = PERMISSION_KEY[op.permission];
    // Writes happen in gh-aw's own job, which asks for its own write
    // permissions; the agent's job reads only.
    if (!READS.has(g.action)) continue;
    for (const t of op.mcpTools) if (!tools.includes(t)) tools.push(t);
    if (key !== undefined) permissions[key] = "read";
  }

  return {
    ok: true,
    repo,
    narrowings,
    beyondMandate: [
      "network: defaults is gh-aw's infrastructure egress for the agent (with its engine's API "
      + "host, which gh-aw adds): the operator's choice, like --agent-egress, and not a destination "
      + "the mandate grants",
    ],
    frontmatter: {
      permissions,
      "timeout-minutes": mandate.expiresInMinutes,
      network: "defaults",
      // The same for the agent's GitHub tools, which would otherwise prefer
      // GH_AW_GITHUB_MCP_SERVER_TOKEN or GH_AW_GITHUB_TOKEN; the workflow token
      // carries only the read permissions above.
      tools: {
        github: { "read-only": true, "github-token": WORKFLOW_TOKEN, "allowed-repos": [repo], allowed: tools },
      },
      "safe-outputs": safeOutputs,
    },
  };
}

export const ghAwBackend: Backend<GhAwResult> = { name: "gh-aw-safe-outputs", compile: compileGhAw };
