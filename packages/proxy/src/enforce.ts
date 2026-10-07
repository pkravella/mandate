import { destinationWithin } from "@mandate-dev/schema";
import { globMatches, GlobParseError } from "@mandate-dev/validator";
import type { ProxyRules, ToolRule } from "@mandate-dev/compiler";
import type { Decision } from "./proxy.js";

export interface ArgExtract {
  readonly repo?: string;
  readonly branch?: string;
  readonly paths: readonly string[];
  readonly base?: string;
  /** `host/path` prefixes, from destination-bearing fields only. */
  readonly destinations: readonly string[];
}

/**
 * Fields that name somewhere data can go.
 *
 * R9a says "every tool call argument is scanned for destination-bearing fields
 * (URLs, remotes, webhook targets, fork owners)", and the field list is the
 * operative part. Scanning *every* string instead — including `content` and
 * `body` — is both over-broad and not protective: a URL inside a file is not a
 * destination, because writing `curl evil.example.com` into a source file sends
 * nothing anywhere and the bytes still travel to GitHub. It would, however,
 * deny any commit touching a `package.json`, a licence header or a doc with a
 * link in it, against a target of under 5% false pauses.
 *
 * A URL that is written into the repository and later *executed* is a real
 * risk, and it is the sandbox's (R9b) and taint tracking's (R14) to carry.
 * `docs/enforced-where.md` says so.
 */
const DESTINATION_FIELDS: ReadonlySet<string> = new Set([
  "url", "clone_url", "git_url", "ssh_url", "html_url",
  "remote", "remote_url", "repository_url", "upstream", "upstream_url",
  "webhook_url", "callback_url", "target_url", "endpoint", "destination",
  "hook_url", "payload_url", "fork_owner", "organization",
]);

const URL_RE = /^https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)(\/[^\s?#]*)?/;

const str = (v: unknown): string | undefined =>
  (typeof v === "string" && v.length > 0 ? v : undefined);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `host/path`, lowercased host, for prefix comparison against the allow list. */
const toPrefix = (value: string): string | undefined => {
  const m = URL_RE.exec(value.trim());
  const host = m?.[1];
  if (host === undefined) return undefined;
  return `${host.toLowerCase()}${(m?.[2] ?? "").replace(/\/+$/, "")}`;
};

function collectDestinations(value: unknown, into: Set<string>, keyed: boolean): void {
  if (typeof value === "string") {
    if (!keyed) return;
    const prefix = toPrefix(value);
    if (prefix !== undefined) into.add(prefix);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectDestinations(v, into, keyed);
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      collectDestinations(v, into, keyed || DESTINATION_FIELDS.has(k));
    }
  }
}

/**
 * The repository a GitHub search is scoped to.
 *
 * The search tools take a `query` rather than owner/repo, so without this the
 * repository check could never be satisfied and `search_code` was permanently
 * unusable despite being granted. A query with no `repo:` qualifier searches
 * all of GitHub, which no mandate grants, so it stays undefined and is denied.
 */
const searchRepo = (args: Record<string, unknown>): string | undefined => {
  const query = str(args["query"]) ?? str(args["q"]);
  if (query === undefined) return undefined;
  const m = /(?:^|\s)repo:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?=\s|$)/.exec(query);
  return m?.[1];
};

export function extractArgs(_tool: string, args: Record<string, unknown>): ArgExtract {
  const owner = str(args["owner"]);
  const repoName = str(args["repo"]);
  const repo = owner !== undefined && repoName !== undefined
    ? `${owner}/${repoName}`
    : searchRepo(args);

  // `head` on a PR create is the source branch; `branch`/`ref` elsewhere.
  const branch = str(args["branch"]) ?? str(args["head"]) ?? str(args["ref"])
    ?? str(args["from_branch"]);

  const paths: string[] = [];
  const single = str(args["path"]);
  if (single !== undefined) paths.push(repoPath(single));
  const files = args["files"];
  if (Array.isArray(files)) {
    for (const f of files) {
      const p = isRecord(f) ? str(f["path"]) : str(f);
      if (p !== undefined) paths.push(repoPath(p));
    }
  }

  const destinations = new Set<string>();
  collectDestinations(args, destinations, false);

  const base = str(args["base"]);
  return {
    ...(repo !== undefined ? { repo } : {}),
    ...(branch !== undefined ? { branch } : {}),
    paths,
    ...(base !== undefined ? { base } : {}),
    destinations: [...destinations],
  };
}

/**
 * Rejects a path that could escape its prefix.
 *
 * A leading slash is *not* an escape and used to be treated as one, which
 * denied `path: "/"` — how github-mcp-server lists the repository root, and the
 * live agent's first call. The contents API is repo-relative either way, so the
 * slash is normalised off by `repoPath` and the path patterns still decide.
 */
function pathIsSuspicious(p: string): boolean {
  return p.split("/").includes("..") || p.includes("\0");
}

/**
 * Rejects a ref that could escape the branch pattern that admits it.
 *
 * Paths had this check and refs did not, and the asymmetry was reachable: the
 * ceiling authors `context.branch like "agent/*"` in Cedar, whose `*` spans
 * `/`, so `likeToGlob` faithfully translates it to `agent/**`. A mandate
 * granting `branches: ["agent/**"]` is therefore schema-legal AND inside the
 * ceiling — and under it `agent/../main`, `agent/x/../../main` and `agent/..`
 * all matched the pattern and were forwarded. The plan's own case
 * (`agent/42-../main`) was denied only because `agent/42-*` cannot cross a
 * separator: by accident of the pattern, not by a check.
 *
 * `..` is rejected anywhere rather than only as a whole segment, which is what
 * `git check-ref-format` does: a ref name may not contain `..` at all. So this
 * cannot deny a branch that git would have accepted.
 *
 * github-mcp-server v1.14.0 does guard paths this way ("path must not contain
 * '..' due to auth vulnerability issue", measured 2026-10-07) and does not
 * guard refs. Relying on an upstream for a control Mandate claims to enforce
 * is how the reason goes missing from the audit log even when the call fails.
 */
function refIsSuspicious(ref: string): boolean {
  return ref.includes("..") || ref.includes("\0");
}

/**
 * The most paths one call may name.
 *
 * Every path costs a containment decision, and a decision builds an automaton.
 * Measured before this cap: a `files` array of 10000 individually-legal paths
 * took 5.6 s inside a single call against a grant with both `paths` and
 * `denyPaths`. Nothing was over-granted — the attack is cost, the same shape as
 * the validator's pattern flood — and nothing bounded the array.
 *
 * 256 is far above any real agent commit and the denial names the cap, so a
 * genuine bulk change is retried in batches rather than silently truncated.
 * Truncating would be the unsafe failure: the paths past the cap would reach
 * the upstream unchecked.
 */
const MAX_PATHS_PER_CALL = 256;

/** A repository-relative path, with any leading slashes removed. */
const repoPath = (p: string): string => p.replace(/^\/+/, "");

/**
 * R7's argument half and R9a. Returns a `Decision` per rule; the proxy calls
 * this once for every rule on the tool and allows if any of them accepts.
 *
 * Nothing in here throws. An undecidable value is a denial that names its
 * clause, because an exception escaping a request handler gives the agent a
 * protocol error instead of a reason, and R10 requires a reason.
 */
/**
 * The same decision, taken over already-extracted facets.
 *
 * Exists because the replay evaluator (R11) has to reach the *identical*
 * decision the proxy would have reached, and a recorded action node already
 * **is** an `ArgExtract` — it was produced by `extractArgs` when the call was
 * made. Rebuilding synthetic arguments from a node and re-extracting them is
 * lossy in at least two ways that were measured: a destination re-expanded into
 * a field name the extractor does not recognise is never checked, and a
 * recorded root path of `""` rebuilds into no path at all, so a replay would
 * check one fewer facet than the run did.
 *
 * So the proxy and the replay share this, and `makeArgumentEnforcer` is the
 * thin wrapper that extracts first. One decision function, no drift.
 */
export function makeFacetEnforcer(
  rules: ProxyRules,
): (rule: ToolRule, extract: ArgExtract) => Decision {
  // `max` is per-rule and per-process: the proxy runs for one mandate, and a
  // replay scores one trace.
  const counts = new Map<string, number>();

  return (rule, e) => {
    const tool = rule.tool;
    const deny = (clause: string, reason: string): Decision =>
      ({ kind: "deny", tool, clause, reason });

    /** Membership that reports undecidability instead of throwing. */
    const matches = (globs: readonly string[], value: string):
    { ok: true } | { ok: false; undecidable?: string } => {
      try {
        return globMatches(globs, value) ? { ok: true } : { ok: false };
      } catch (err) {
        if (err instanceof GlobParseError) return { ok: false, undecidable: err.message };
        throw err;
      }
    };

    const undecidable = (value: string, globs: readonly string[], why: string): string =>
      `${JSON.stringify(value)} cannot be decided against ${globs.join(", ")}: ${why}`;

    // --- repository ------------------------------------------------------
    const repoClause = `${rule.action}.resources`;
    if (e.repo === undefined) {
      return deny(
        repoClause,
        `${tool} did not name owner and repo, so it cannot be checked against `
        + `${rule.resources.join(", ")}`,
      );
    }
    const repoCheck = matches(rule.resources, e.repo);
    if (!repoCheck.ok) {
      return deny(repoClause, repoCheck.undecidable !== undefined
        ? undecidable(e.repo, rule.resources, repoCheck.undecidable)
        : `${e.repo} is outside the granted repositories ${rule.resources.join(", ")}`);
    }

    // --- branch ----------------------------------------------------------
    // Checked whatever the rule constrains, exactly as a path is: a traversing
    // ref is never one this proxy should forward, even on a grant with no
    // branch limit.
    if (e.branch !== undefined && refIsSuspicious(e.branch)) {
      return deny(
        `${rule.action}.branches`,
        `branch ${JSON.stringify(e.branch)} is not a plain ref name`,
      );
    }
    if (rule.branches !== undefined) {
      const clause = `${rule.action}.branches`;
      if (e.branch === undefined) {
        return deny(
          clause,
          `${tool} did not name a branch, and the grant limits writes to `
          + `${rule.branches.join(", ")}`,
        );
      }
      const check = matches(rule.branches, e.branch);
      if (!check.ok) {
        return deny(clause, check.undecidable !== undefined
          ? undecidable(e.branch, rule.branches, check.undecidable)
          : `branch ${e.branch} is outside the granted pattern ${rule.branches.join(", ")}`);
      }
    }

    // --- base ------------------------------------------------------------
    // A base is a ref too.
    if (e.base !== undefined && refIsSuspicious(e.base)) {
      return deny(
        `${rule.action}.base`,
        `base ${JSON.stringify(e.base)} is not a plain ref name`,
      );
    }
    if (rule.base !== undefined) {
      const clause = `${rule.action}.base`;
      if (e.base === undefined) {
        return deny(
          clause,
          `${tool} did not name a base branch; the grant allows only ${rule.base}`,
        );
      }
      const check = matches([rule.base], e.base);
      if (!check.ok) {
        return deny(clause, check.undecidable !== undefined
          ? undecidable(e.base, [rule.base], check.undecidable)
          : `base ${e.base} is not the granted base ${rule.base}`);
      }
    }

    // --- paths -----------------------------------------------------------
    // Bounded before the loop, not inside it: the cost is per path, so a cap
    // that only stopped after 256 decisions would have already paid for them.
    if (e.paths.length > MAX_PATHS_PER_CALL) {
      return deny(
        `${rule.action}.paths`,
        `${tool} names ${e.paths.length} paths and at most ${MAX_PATHS_PER_CALL} are checked per `
        + `call; split the change into smaller calls`,
      );
    }
    for (const p of e.paths) {
      // Checked whatever the rule constrains: a traversal is never a path this
      // proxy should forward, even on a grant with no path limit.
      if (pathIsSuspicious(p)) {
        return deny(
          `${rule.action}.paths`,
          `path ${JSON.stringify(p)} is not a plain repository-relative path`,
        );
      }
      if (rule.paths !== undefined) {
        const clause = `${rule.action}.paths`;
        const check = matches(rule.paths, p);
        if (!check.ok) {
          return deny(clause, check.undecidable !== undefined
            ? undecidable(p, rule.paths, check.undecidable)
            : `path ${p} is outside the granted paths ${rule.paths.join(", ")}`);
        }
      }
      if (rule.denyPaths !== undefined) {
        const clause = `${rule.action}.denyPaths`;
        const check = matches(rule.denyPaths, p);
        // Undecidable against a deny list denies: the whole point of the deny
        // list is the paths it has to keep out.
        if (check.ok) {
          return deny(clause, `path ${p} is excluded by ${rule.denyPaths.join(", ")}`);
        }
        if (check.undecidable !== undefined) {
          return deny(clause, undecidable(p, rule.denyPaths, check.undecidable));
        }
      }
    }

    // --- destinations (R9a) ----------------------------------------------
    for (const prefix of e.destinations) {
      if (!destinationWithin(prefix, rules.destinations)) {
        return deny(
          "destinations.allow",
          `${prefix} is not in the mandate's allowed destinations `
          + `(${rules.destinations.join(", ")})`,
        );
      }
    }

    // --- max -------------------------------------------------------------
    // Last, so a call denied for any other reason does not spend the quota.
    if (rule.max !== undefined) {
      const key = `${rule.action}:${tool}`;
      const used = counts.get(key) ?? 0;
      if (used >= rule.max) {
        return deny(
          `${rule.action}.max`,
          `the grant allows at most ${rule.max} ${tool} call(s) and ${used} have been made`,
        );
      }
      counts.set(key, used + 1);
    }

    return { kind: "allow", tool };
  };
}

/**
 * R7's argument half and R9a, over the raw tool arguments.
 *
 * Nothing in here throws. An undecidable value is a denial that names its
 * clause, because an exception escaping a request handler gives the agent a
 * protocol error instead of a reason, and R10 requires a reason.
 */
export function makeArgumentEnforcer(
  rules: ProxyRules,
): (rule: ToolRule, args: Record<string, unknown>) => Decision {
  const enforce = makeFacetEnforcer(rules);
  return (rule, args) => enforce(rule, extractArgs(rule.tool, args));
}
