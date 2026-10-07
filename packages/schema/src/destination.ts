/**
 * Where repository data may go, and the one predicate that decides it.
 *
 * This lives in `schema` because three packages on both sides of the trust
 * boundary read the same destination list and must never disagree about it:
 * the **validator** proves a mandate's destinations sit inside the
 * organization's, the **proxy** refuses a tool call whose destination-bearing
 * field falls outside the mandate's (R9a), and the **compiler** turns the
 * mandate's list into the sandbox's egress allowlist (R9b). Three copies of
 * "is this destination inside that list" is three chances for the layers to
 * drift, and a drift here is either a false pause or an open channel.
 *
 * A destination is a `host` or a `host/path` prefix — never a URL. The
 * comparison is a prefix on a segment boundary, so `github.com/acme/api` does
 * not permit `github.com/acme/api-private`.
 */

/** A hostname: dot-separated labels of letters, digits and inner hyphens. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export class DestinationListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationListError";
  }
}

/** Lowercased, with any scheme and trailing slashes removed. */
export function normalizeDestination(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/**
 * Whether `destination` is inside `allow`.
 *
 * Containment of a *pattern* reduces to membership of its own string, which is
 * why one predicate serves both the ceiling proof and the runtime check: a
 * destination denotes itself plus everything beneath it, so if `allow` covers
 * the string it covers the whole set. The one asymmetry is a bare host, which
 * also denotes its subdomains — so a bare host is inside `allow` only if some
 * entry covers that host at its root.
 */
export function destinationWithin(destination: string, allow: readonly string[]): boolean {
  const d = normalizeDestination(destination);
  if (d.length === 0) return false;

  return allow.some((raw) => {
    const entry = normalizeDestination(raw);
    if (entry.length === 0) return false;
    if (d === entry) return true;
    if (d.startsWith(`${entry}/`)) return true;
    // A bare host entry also covers its subdomains, at any depth. An entry
    // naming a path does not: `github.com/acme` must not permit
    // `gist.github.com`, and the egress policy compiles the same distinction.
    //
    // The guard is redundant and kept deliberately. `host` is taken before the
    // first `/`, so it never contains one, while a path-bearing `entry` always
    // does — which makes both comparisons below unsatisfiable for such an entry
    // whether the guard is there or not. Verified by exhausting the shapes; a
    // mutation removing it survives, and that is recorded rather than worked
    // around. It stays because it states the rule at the point the rule applies,
    // and because it becomes load-bearing the moment `host` is extracted
    // differently.
    if (!entry.includes("/")) {
      const host = d.split("/")[0] ?? "";
      return host === entry || host.endsWith(`.${entry}`);
    }
    return false;
  });
}

export type DestinationContainment =
  | { readonly ok: true }
  | { readonly ok: false; readonly counterexample: string };

/**
 * Whether every destination in `inner` is inside `outer`.
 *
 * The counterexample is the offending `inner` entry itself: it is a
 * destination the inner list permits and the outer one does not, which is
 * exactly what a permission diff (R5) and a rejection need to print.
 */
export function destinationsWithin(
  inner: readonly string[],
  outer: readonly string[],
): DestinationContainment {
  for (const d of inner) {
    if (!destinationWithin(d, outer)) {
      return { ok: false, counterexample: normalizeDestination(d) };
    }
  }
  return { ok: true };
}

/**
 * Reads an organization's destination allowlist.
 *
 * One entry per line, `#` comments, blank lines ignored. A plain text list
 * rather than Cedar: Cedar decides `(principal, action, resource)` questions
 * and has no destination in its model, so expressing this as a policy would
 * mean inventing an entity for it. Keeping it beside the ceiling as its own
 * reviewable file says plainly what it is.
 *
 * An empty source yields an empty list, and an empty list permits **nothing**.
 * That is the deny-by-default reading, and it is the reason the list is a
 * required input rather than an optional one: a ceiling that forgot the file
 * would otherwise silently permit every destination.
 */
export function parseDestinationList(source: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const [index, line] of source.split("\n").entries()) {
    const at = `line ${index + 1}`;
    const text = line.trim();
    if (text.length === 0 || text.startsWith("#")) continue;

    if (text.includes("*")) {
      throw new DestinationListError(
        `${at}: ${JSON.stringify(text)} contains a wildcard; a destination ceiling must name `
        + `concrete hosts, because a wildcard permits exfiltration anywhere`,
      );
    }
    if (text.includes("://")) {
      throw new DestinationListError(
        `${at}: ${JSON.stringify(text)} carries a scheme; an entry is a host with an `
        + `optional path, not a URL`,
      );
    }

    const entry = normalizeDestination(text);
    const host = entry.split("/")[0] ?? "";
    if (!HOSTNAME_RE.test(host)) {
      throw new DestinationListError(
        `${at}: ${JSON.stringify(text)} has no usable host (read as ${JSON.stringify(host)})`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }

  return out;
}
