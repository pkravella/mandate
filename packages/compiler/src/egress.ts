import { unwrap, type ValidatedMandate } from "@mandate-dev/schema";

/**
 * R9b: the sandbox's egress allowlist, compiled from the mandate's
 * `destinations.allow`.
 *
 * Decision D3 calls this "the control that actually holds", because an MCP
 * proxy only ever sees MCP traffic: an agent with a shell, a `git push` to a
 * remote it configures itself, or a `curl` does not transit the proxy at all.
 * R9a bounds the destinations that appear in tool *arguments*; this bounds the
 * network.
 */
export interface EgressPolicy {
  /** Reachable exactly. Subdomains of these are **not** reachable. */
  readonly allowedHosts: readonly string[];
  /**
   * Reachable along with every subdomain, because the mandate named a bare
   * host. This mirrors the proxy's `destinationAllowed`, where a bare host
   * entry covers its subdomains and a host-with-path entry does not — the two
   * layers have to agree about one destination list.
   */
  readonly subdomainHosts: readonly string[];
  /**
   * The `dstdomain` entries, in the order the config lists them: a leading dot
   * for a subdomain host, the bare name for an exact one.
   */
  readonly aclEntries: readonly string[];
  /**
   * Hosts the operator opened for the agent itself -- its model's API -- kept
   * apart from the mandate's so nothing reports them as the task's
   * destinations. Exact, never subdomain-extended.
   */
  readonly agentHosts: readonly string[];
  readonly squidConf: string;
}

export interface EgressOptions {
  /**
   * Whether the agent may reach GitHub directly. On by default. A sandboxed
   * agent turns it off: `mandate serve` and the GitHub MCP server run on the
   * host, so the agent needs no GitHub egress of its own. Off leaves out the
   * infrastructure hosts AND any destination on github.com or
   * githubusercontent.com -- found reviewing Phase 5, the first version left a
   * mandate's `github.com/acme/api` open, and squid sees only the CONNECT
   * host, so a credential that reached the container could push anywhere on
   * github.com past every branch and path limit.
   */
  readonly githubInfrastructure?: boolean;
  /**
   * Hosts the agent itself needs, such as its model's API. Operator
   * configuration, never the mandate's: the writer is a model, and a model
   * deciding where the agent may connect is the thing Mandate exists to stop.
   */
  readonly agentHosts?: readonly string[];
}

/**
 * Hosts the GitHub API and git transport need whatever the mandate says.
 *
 * These are exact, never subdomain-extended. They are where repository
 * contents are actually served, so widening them to `.github.com` would hand
 * the agent every GitHub subdomain — `gist.github.com` among them — as an
 * egress channel the mandate never named.
 */
const INFRASTRUCTURE_HOSTS: readonly string[] = [
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];

/** GitHub's own domains, which a sandboxed agent reaches only through serve. */
const GITHUB_DOMAINS: readonly string[] = ["github.com", "githubusercontent.com"];

/**
 * Hosts that are addresses, not names: dotted or bare decimal, hex, and
 * anything with a colon (IPv6, bracketed or not). A hostname has none of these.
 */
const IP_LITERAL_PATTERNS: readonly string[] = ["^[0-9.]+$", "^0[xX]", ":", "^\\["];

/** The only port the generated config permits a tunnel to. */
const TUNNEL_PORT = 443;

/** A hostname: dot-separated labels of letters, digits and inner hyphens. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export class EgressCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressCompileError";
  }
}

/** Whether `host` is `domain` or sits under it. Label-aligned, so `notexample.com` is not under `example.com`. */
const isUnder = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * The host of one destination, and whether the mandate named it bare.
 *
 * Nothing here is lenient. A destination the egress layer cannot enforce
 * exactly is a refusal, not a best effort: a host listed as allowed that is in
 * fact unreachable, or reachable more widely than the mandate says, is worse
 * than a failed compile because the docs would claim the sandbox holds.
 */
function parseDestination(raw: string): { host: string; bare: boolean } {
  const d = raw.trim();
  if (d.includes("*")) {
    throw new EgressCompileError(
      `destination ${JSON.stringify(raw)} contains a wildcard; egress must name concrete `
      + `hosts, because a wildcard permits exfiltration anywhere`,
    );
  }
  if (d.includes("://")) {
    throw new EgressCompileError(
      `destination ${JSON.stringify(raw)} carries a scheme; a destination is a `
      + `host with an optional path, not a URL`,
    );
  }

  const slash = d.indexOf("/");
  const authority = (slash === -1 ? d : d.slice(0, slash)).toLowerCase();
  const bare = slash === -1 || d.slice(slash + 1).length === 0;

  const colon = authority.lastIndexOf(":");
  let host = authority;
  if (colon !== -1) {
    const port = authority.slice(colon + 1);
    host = authority.slice(0, colon);
    if (!/^\d+$/.test(port)) {
      throw new EgressCompileError(
        `destination ${JSON.stringify(raw)} has an unreadable port ${JSON.stringify(port)}`,
      );
    }
    if (Number(port) !== TUNNEL_PORT) {
      throw new EgressCompileError(
        `destination ${JSON.stringify(raw)} names port ${port}, but the egress policy `
        + `permits a tunnel to ${TUNNEL_PORT} only; ${host} would be listed as allowed `
        + `and still be unreachable`,
      );
    }
  }

  if (!HOSTNAME_RE.test(host)) {
    throw new EgressCompileError(
      `destination ${JSON.stringify(raw)} has no usable host (read as ${JSON.stringify(host)})`,
    );
  }
  return { host, bare };
}

/** One concrete hostname, exactly: no wildcard, scheme, path, port or leading dot. */
function parseAgentHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!HOSTNAME_RE.test(host)) {
    throw new EgressCompileError(
      `agent egress host ${JSON.stringify(raw)} is not one concrete hostname; the operator `
      + "opens exact hosts for the agent, with no wildcard, scheme, path or port",
    );
  }
  return host;
}

export function compileEgress(m: ValidatedMandate, opts: EgressOptions = {}): EgressPolicy {
  const mandate = unwrap(m);

  const subdomain = new Set<string>();
  const exact = new Set<string>(opts.githubInfrastructure === false ? [] : INFRASTRUCTURE_HOSTS);
  const agentHosts = [...new Set((opts.agentHosts ?? []).map(parseAgentHost))].sort();
  for (const h of agentHosts) exact.add(h);

  for (const raw of mandate.destinations.allow) {
    const { host, bare } = parseDestination(raw);
    // In the sandbox the agent reaches GitHub only through serve. A GitHub host
    // left open here is where a credential that leaked into the container
    // would push -- squid sees only the CONNECT host, so an open github.com
    // admits every repository -- past every branch and path limit.
    if (opts.githubInfrastructure === false && GITHUB_DOMAINS.some((d) => isUnder(host, d))) continue;
    if (bare) subdomain.add(host);
    else exact.add(host);
  }

  // Probed against squid 5.7: a `dstdomain` ACL carrying both a domain and a
  // subdomain of it is refused — fatally when the broader entry comes second,
  // with a warning when it comes first. Since the infrastructure hosts all sit
  // under github.com, a mandate naming a bare github.com would otherwise emit a
  // config squid will not load at all. Collapsing is the robust fix; relying on
  // ordering alone is not, because the fatality depends on it.
  const subdomainHosts = [...subdomain]
    .filter((h) => ![...subdomain].some((other) => other !== h && isUnder(h, other)))
    .sort();
  const allowedHosts = [...exact]
    .filter((h) => !subdomainHosts.some((s) => isUnder(h, s)))
    .sort();

  // Broader entries first, so if a collapse is ever missed the result is
  // squid's warning rather than its FATAL.
  const aclEntries = [...subdomainHosts.map((h) => `.${h}`), ...allowedHosts];

  const agentNote = agentHosts.length === 0
    ? ""
    : `# Includes agent egress, set by the operator: ${agentHosts.join(" ")}\n`;
  const squidConf = `# Generated by Mandate for ${mandate.mandate}. Deny by default.
${agentNote}#
# Bound to loopback: the agent reaches it, nothing outside the sandbox does.
http_port 127.0.0.1:3128

${aclEntries.length === 0
    ? `# Nothing is allowed: the agent has no egress at all.
http_access deny all`
    : `# -n: never a reverse lookup. Without it squid matches an IP-literal request
# by the address's PTR record, which whoever owns the address controls --
# probed: with .github.com allowed, CONNECT 140.82.114.4:443 was answered 200.
acl mandate_allowed dstdomain -n ${aclEntries.join(" ")}
# A destination given as an address names no host, so no host was allowed.
acl ip_literal dstdom_regex -n ${IP_LITERAL_PATTERNS.join(" ")}
acl CONNECT method CONNECT
acl SSL_ports port ${TUNNEL_PORT}

# A tunnel to an allowed host on ${TUNNEL_PORT}, and nothing else. Allowing the
# ACL alone would permit any method on any port to that host, which makes the
# CONNECT restriction decorative.
http_access deny ip_literal
http_access deny !mandate_allowed
http_access deny CONNECT !SSL_ports
http_access allow CONNECT mandate_allowed SSL_ports
http_access deny all`}

# No caching: repository data must not persist in the sandbox.
cache deny all

# squid drops privileges to \`proxy\`, which cannot open root's /dev/stdout.
# entrypoint.sh tails this file to the container's stdout instead.
access_log stdio:/var/log/squid/access.log
cache_log /var/log/squid/cache.log
pid_filename none
`;

  return { allowedHosts, subdomainHosts, aclEntries, agentHosts, squidConf };
}
