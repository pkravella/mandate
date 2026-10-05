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
  readonly squidConf: string;
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

export function compileEgress(m: ValidatedMandate): EgressPolicy {
  const mandate = unwrap(m);

  const subdomain = new Set<string>();
  const exact = new Set<string>(INFRASTRUCTURE_HOSTS);

  for (const raw of mandate.destinations.allow) {
    const { host, bare } = parseDestination(raw);
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

  if (aclEntries.length === 0) {
    throw new EgressCompileError(
      `mandate ${mandate.mandate} compiled to an empty egress allowlist`,
    );
  }

  const squidConf = `# Generated by Mandate for ${mandate.mandate}. Deny by default.
#
# Bound to loopback: the agent reaches it, nothing outside the sandbox does.
http_port 127.0.0.1:3128

acl mandate_allowed dstdomain ${aclEntries.join(" ")}
acl CONNECT method CONNECT
acl SSL_ports port ${TUNNEL_PORT}

# A tunnel to an allowed host on ${TUNNEL_PORT}, and nothing else. Allowing the
# ACL alone would permit any method on any port to that host, which makes the
# CONNECT restriction decorative.
http_access deny !mandate_allowed
http_access deny CONNECT !SSL_ports
http_access allow CONNECT mandate_allowed SSL_ports
http_access deny all

# No caching: repository data must not persist in the sandbox.
cache deny all

# squid drops privileges to \`proxy\`, which cannot open root's /dev/stdout.
# entrypoint.sh tails this file to the container's stdout instead.
access_log stdio:/var/log/squid/access.log
cache_log /var/log/squid/cache.log
pid_filename none
`;

  return { allowedHosts, subdomainHosts, aclEntries, squidConf };
}
