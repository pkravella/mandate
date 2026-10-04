import { getOperation } from "@mandate-dev/catalog";
import type { Grant, Mandate } from "@mandate-dev/schema";
import { globMatches, globSetContains } from "./glob/contains.js";
import { GlobParseError } from "./glob/parse.js";

export type LintSeverity = "error" | "warn";

export interface LintFinding {
  readonly rule: string;
  readonly severity: LintSeverity;
  readonly grantIndex?: number;
  readonly message: string;
}

export const LINT_RULES = [
  "no-wildcard-resource",
  "no-default-branch-write",
  "require-branch-constraint",
  "no-workflow-access",
  "no-secret-access",
  "require-sensitive-deny-paths",
  "no-forbidden-risk-op",
  "require-max-on-side-effects",
  "no-wildcard-destination",
  "enforcement-overclaim",
] as const;

const DEFAULT_BRANCHES = ["main", "master", "develop", "release", "release/1.0"];

// The minimum a code-write grant must exclude.
//
// Note the dotenv pattern is the character-wise form, not the segment-aware
// basename form. A Cedar ceiling expresses path patterns character-wise, so
// its dotenv deny means "any path containing .env". Requiring the narrower
// basename form here would let a mandate pass the lint and then fail
// containment, which is a worse experience than failing the lint.
//
// (Written as line comments deliberately: the segment-aware pattern contains
// the sequence that terminates a block comment.)
const SENSITIVE_PATHS = [".github/workflows/**", "**.env**"];

/**
 * Operations that create outward-facing side effects and therefore need a
 * bound. Every member must list "max" in its catalog `constrainable` set,
 * otherwise this lint demands a field the schema refuses and the grant becomes
 * unsatisfiable. An invariant test pins that.
 */
export const SIDE_EFFECTING: ReadonlySet<string> = new Set([
  "pull_request.create", "pull_request.comment", "pull_request.update",
  "pull_request.review", "pull_request.merge", "pull_request.close",
  "issue.create", "issue.comment", "issue.update", "issue.close",
  "issue.label", "issue.assign",
  "actions.write", "releases.write", "repo.create", "repo.fork", "gist.write",
]);

/** Membership that degrades to "no match" on an undecidable pattern. */
function matchesSafely(globs: readonly string[], value: string): boolean {
  try {
    return globMatches(globs, value);
  } catch (e) {
    if (e instanceof GlobParseError) return false;
    throw e;
  }
}

/** Containment that degrades to "not contained" on an undecidable pattern. */
function containsSafely(outer: readonly string[], inner: readonly string[]): boolean {
  try {
    return globSetContains(outer, inner).ok;
  } catch (e) {
    if (e instanceof GlobParseError) return false;
    throw e;
  }
}

/**
 * R4's lints. These run after containment and catch mandates that are
 * technically inside a loose ceiling but obviously wrong.
 *
 * Nothing here throws. A lint is never allowed to be the thing that crashes
 * validation: an undecidable pattern is already rejected by containment, and a
 * lint pass over one degrades to a finding.
 */
export function runLints(m: Mandate): readonly LintFinding[] {
  const out: LintFinding[] = [];
  const add = (rule: string, severity: LintSeverity, message: string, grantIndex?: number): void => {
    out.push(grantIndex === undefined ? { rule, severity, message } : { rule, severity, message, grantIndex });
  };

  if (m.destinations.allow.some((d) => d === "*" || d === "**")) {
    add("no-wildcard-destination", "error",
      "destinations.allow must name concrete hosts; a wildcard permits exfiltration anywhere");
  }

  for (const [i, g] of m.grants.entries()) {
    // getOperation, not requireOperation: an unknown action has already been
    // rejected by validate(), and a lint that throws would replace a clear
    // "unknown operation" rejection with a crash.
    const op = getOperation(g.action);
    if (op === undefined) continue;

    if (g.resources.some((r) => r === "*" || r === "**")) {
      add("no-wildcard-resource", "error", `grant ${g.action} targets every repository`, i);
    }

    if (op.risk === "forbidden") {
      add("no-forbidden-risk-op", "error",
        `${g.action} is classed forbidden in the catalog and needs an explicit ceiling exception`, i);
    }
    if (g.action === "workflows.write" || g.action === "actions.write") {
      add("no-workflow-access", "error", `${g.action} lets the agent change what CI runs`, i);
    }
    if (g.action.startsWith("secrets.")) {
      add("no-secret-access", "error", `${g.action} exposes credentials beyond the mandate`, i);
    }

    // A grant that writes files is held to the branch and path rules.
    const writesFiles = op.permissionLevel === "write" && op.resourceType === "path";
    if (writesFiles) {
      if (g.branches === undefined) {
        add("require-branch-constraint", "error",
          `${g.action} must name the branches it may write`, i);
      } else {
        const reachable = DEFAULT_BRANCHES.filter((b) => matchesSafely(g.branches!, b));
        if (reachable.length > 0) {
          add("no-default-branch-write", "error",
            `${g.action} can reach ${reachable.join(", ")} via ${JSON.stringify(g.branches)}`, i);
        }
      }

      const denies = g.denyPaths ?? [];
      const uncovered = denies.length === 0
        ? SENSITIVE_PATHS
        : SENSITIVE_PATHS.filter((s) => !containsSafely(denies, [s]));
      if (uncovered.length > 0) {
        add("require-sensitive-deny-paths", "error",
          `${g.action} does not exclude ${uncovered.join(", ")}`, i);
      }
    }

    if (SIDE_EFFECTING.has(g.action) && g.max === undefined) {
      add("require-max-on-side-effects", "error",
        `${g.action} creates outward-facing side effects and needs a max`, i);
    }

    if (g.enforcedBy === "token" &&
        (g.branches !== undefined || g.paths !== undefined || g.denyPaths !== undefined)) {
      add("enforcement-overclaim", "error",
        `grant ${g.action} claims token enforcement, but a GitHub App token cannot limit by ` +
        `branch or path; use enforcedBy: "proxy"`, i);
    }
  }

  return out;
}

export function hasLintErrors(findings: readonly LintFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
