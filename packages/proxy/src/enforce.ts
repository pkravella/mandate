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
  /**
   * Values in destination-bearing fields that could not be read as a
   * destination. Absent when there are none. Any entry denies the call: a field
   * that names where data goes, holding something Mandate cannot place, is
   * doubt, and an unparseable value used to be dropped and the call allowed.
   */
  readonly unreadableDestinations?: readonly UnreadableDestination[];
  /**
   * `issue_write`'s `method`, which says whether the call is a create or an
   * update -- the one shared tool whose arguments name the operation. Absent
   * for every other tool. See attribution.ts.
   */
  readonly method?: string;
}

export interface UnreadableDestination {
  /** The nearest key the value sat under. */
  readonly field: string;
  readonly value: string;
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

/**
 * Fields whose value is a GitHub account rather than a URL.
 *
 * `organization` is the one name on the list that github-mcp-server v1.14.0
 * actually uses (read from its source): `fork_repository` takes it as the
 * organization to fork into. Read as a URL it was nothing, so a fork anywhere
 * passed R9a and left no destination in the trace.
 */
const OWNER_FIELDS: ReadonlySet<string> = new Set(["organization", "fork_owner"]);

/** A GitHub login: alphanumerics and inner hyphens, at most 39 characters. */
const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

/** `scheme://`, any scheme. Case-insensitive, as schemes are. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * git's scp-like syntax, `[user@]host:path`: no `://`, and a colon before any
 * slash. The host must contain a dot, which is what keeps `mailto:x@y` and a
 * Windows drive letter from reading as a host.
 */
const SCP_RE = /^(?:[^@/:\s]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+):([^\s]*)$/i;

/**
 * What a host may look like once extracted: labels, and an optional port.
 * WHATWG leaves a non-special scheme's host opaque -- `ssh://EVIL.Example.com`
 * is not lowercased and `evil%2Eexample.com` is not decoded, both probed -- so
 * anything else is refused rather than compared.
 */
const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?$/;

const str = (v: unknown): string | undefined =>
  (typeof v === "string" && v.length > 0 ? v : undefined);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A trailing `.git` is dropped: `acme/api.git` is how git names the repository
 * `acme/api`, and keeping it put every clone URL of an allowed repository
 * outside `github.com/acme/api` on the segment boundary -- a false pause on
 * the commonest spelling of the one destination the mandate names.
 */
const prefixOf = (host: string, path: string): string | undefined => {
  const h = host.toLowerCase();
  if (!HOST_RE.test(h)) return undefined;
  return `${h}${path.replace(/\/+$/, "").replace(/\.git$/i, "")}`;
};

/**
 * `host/path`, lowercased host, for prefix comparison against the allow list.
 * `undefined` means the value could not be placed, which the caller treats as
 * a refusal, never as an absence.
 *
 * A `scheme://` value goes through WHATWG `URL` rather than a regex, because
 * the regex disagreed with every HTTP client in ways that allowed calls: it
 * read `https://github.com@evil.example.com/` as github.com, left
 * `/acme/api/../../evil` unresolved against a prefix check, and did not match
 * `HTTPS://` at all. `.host` keeps a non-default port, so a port still fails
 * closed against an allow entry that names none.
 */
const toPrefix = (value: string, field: string): string | undefined => {
  const v = value.trim();

  if (OWNER_FIELDS.has(field)) {
    return OWNER_RE.test(v) ? `github.com/${v.toLowerCase()}` : undefined;
  }

  if (SCHEME_RE.test(v)) {
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      return undefined;
    }
    if (url.host.length === 0) return undefined;
    return prefixOf(url.host, url.pathname);
  }

  const scp = SCP_RE.exec(v);
  if (scp !== null) {
    const path = (scp[2] ?? "").replace(/^\/+/, "");
    // A remote path is a filesystem path on the far side and nothing resolves
    // its dot segments for us, so one is doubt rather than something to fold.
    if (path.split("/").some((s) => s === "." || s === "..")) return undefined;
    return prefixOf(scp[1] ?? "", path.length > 0 ? `/${path}` : "");
  }

  return undefined;
};

interface Collected {
  readonly destinations: Set<string>;
  readonly unreadable: UnreadableDestination[];
}

/**
 * Walks the arguments for destination-bearing fields. `field` is the nearest
 * key above the value, and `keyed` whether any key above it was on the list --
 * so a URL nested inside a `remote` object is still read, and read by its own
 * key's rules.
 */
function collectDestinations(
  value: unknown, into: Collected, keyed: boolean, field: string,
): void {
  if (Array.isArray(value)) {
    for (const v of value) collectDestinations(v, into, keyed, field);
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      collectDestinations(v, into, keyed || DESTINATION_FIELDS.has(k), k);
    }
    return;
  }
  if (!keyed) return;
  // Absent, not unreadable: clients send null or "" for an optional field.
  if (value === null || value === undefined || value === "") return;

  const prefix = typeof value === "string" ? toPrefix(value, field) : undefined;
  if (prefix !== undefined) into.destinations.add(prefix);
  else into.unreadable.push({ field, value: String(value) });
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

export function extractArgs(tool: string, args: Record<string, unknown>): ArgExtract {
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

  const collected: Collected = { destinations: new Set(), unreadable: [] };
  collectDestinations(args, collected, false, "");

  const base = str(args["base"]);
  return {
    ...(repo !== undefined ? { repo } : {}),
    ...(branch !== undefined ? { branch } : {}),
    paths,
    ...(base !== undefined ? { base } : {}),
    destinations: [...collected.destinations],
    ...(collected.unreadable.length > 0 ? { unreadableDestinations: collected.unreadable } : {}),
    // Kept as a string whatever it was, so a non-string reaches attribution as
    // something that is neither create nor update, and is refused.
    ...(tool === "issue_write" && args["method"] !== undefined && args["method"] !== null
      ? { method: String(args["method"]) } : {}),
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
    for (const u of e.unreadableDestinations ?? []) {
      return deny(
        "destinations.allow",
        `${u.field} holds ${JSON.stringify(u.value)}, which cannot be read as a destination, `
        + `so it cannot be shown to be inside the mandate's allowed destinations `
        + `(${rules.destinations.join(", ")})`,
      );
    }
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
