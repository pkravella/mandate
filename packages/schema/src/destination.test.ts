import { describe, expect, it } from "vitest";
import { destinationWithin, destinationsWithin, parseDestinationList } from "./destination.js";

describe("destinationWithin", () => {
  it("accepts an identical entry", () => {
    expect(destinationWithin("github.com/acme", ["github.com/acme"])).toBe(true);
  });

  it("accepts a destination deeper than the entry", () => {
    expect(destinationWithin("github.com/acme/api", ["github.com/acme"])).toBe(true);
  });

  it("rejects a destination shallower than the entry", () => {
    expect(destinationWithin("github.com/acme", ["github.com/acme/api"])).toBe(false);
  });

  // The boundary check: a prefix that is not segment-aligned is a different
  // path, and `github.com/acme/api-private` is not inside `github.com/acme/api`.
  it("rejects a prefix that is not aligned to a segment", () => {
    expect(destinationWithin("github.com/acme-evil", ["github.com/acme"])).toBe(false);
    expect(destinationWithin("github.com/acme/api-private", ["github.com/acme/api"])).toBe(false);
  });

  it("rejects a host the list never names", () => {
    expect(destinationWithin("evil.example.com/acme", ["github.com/acme"])).toBe(false);
  });

  it("extends a bare-host entry to its subdomains, at any depth", () => {
    expect(destinationWithin("api.github.com", ["github.com"])).toBe(true);
    expect(destinationWithin("a.b.github.com", ["github.com"])).toBe(true);
    expect(destinationWithin("github.com/acme", ["github.com"])).toBe(true);
  });

  it("does not extend a host-with-path entry to subdomains", () => {
    expect(destinationWithin("gist.github.com", ["github.com/acme"])).toBe(false);
  });

  it("does not treat a host merely ending in the same text as a subdomain", () => {
    expect(destinationWithin("notgithub.com", ["github.com"])).toBe(false);
  });

  it("rejects a bare host against a subdomain entry", () => {
    expect(destinationWithin("github.com", ["api.github.com"])).toBe(false);
  });

  it("ignores case in the host", () => {
    expect(destinationWithin("GitHub.COM/acme", ["github.com/acme"])).toBe(true);
  });

  it("ignores a trailing slash", () => {
    expect(destinationWithin("github.com/acme/", ["github.com/acme"])).toBe(true);
    expect(destinationWithin("github.com/acme", ["github.com/acme/"])).toBe(true);
  });

  it("accepts a destination inside any one of several entries", () => {
    const allow = ["api.github.com", "github.com/acme"];
    expect(destinationWithin("github.com/acme/api", allow)).toBe(true);
    expect(destinationWithin("api.github.com/x", allow)).toBe(true);
    expect(destinationWithin("github.com/other", allow)).toBe(false);
  });

  it("permits nothing against an empty list", () => {
    expect(destinationWithin("github.com/acme", [])).toBe(false);
  });

  it("treats an empty destination as permitted by nothing", () => {
    expect(destinationWithin("", ["github.com"])).toBe(false);
    expect(destinationWithin("   ", ["github.com"])).toBe(false);
  });

  // An empty entry must permit nothing. Without the guard it behaves as the
  // prefix "", so any destination beginning with a slash satisfies it — and
  // the mandate's own list reaches this predicate from the schema, which only
  // requires a non-empty string.
  it("treats an empty entry as permitting nothing", () => {
    expect(destinationWithin("/x", [""])).toBe(false);
    expect(destinationWithin("github.com", [""])).toBe(false);
  });
});

// The whole point of sharing one predicate: the ceiling check and the proxy's
// runtime check must never disagree about one destination list. Containment of
// a pattern reduces to membership of its own string, because a destination
// denotes itself plus everything under it, and both sides read it that way.
describe("destinationsWithin", () => {
  it("accepts a mandate list inside the ceiling's", () => {
    const r = destinationsWithin(["github.com/acme/api"], ["github.com/acme"]);
    expect(r.ok).toBe(true);
  });

  it("rejects a mandate entry the ceiling does not cover, and names it", () => {
    const r = destinationsWithin(
      ["github.com/acme/api", "evil.example.com"], ["github.com/acme"],
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a rejection");
    expect(r.counterexample).toBe("evil.example.com");
  });

  // A bare host in the mandate is wider than a host-with-path ceiling, because
  // it permits every path and every subdomain under that host.
  it("rejects a bare host against a ceiling that names a path", () => {
    const r = destinationsWithin(["github.com"], ["github.com/acme"]);
    expect(r.ok).toBe(false);
  });

  it("accepts an empty mandate list, which permits nothing", () => {
    expect(destinationsWithin([], ["github.com/acme"]).ok).toBe(true);
  });

  it("rejects any mandate entry against an empty ceiling list", () => {
    const r = destinationsWithin(["github.com/acme"], []);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a rejection");
    expect(r.counterexample).toBe("github.com/acme");
  });
});

describe("parseDestinationList", () => {
  it("reads one entry per line", () => {
    expect(parseDestinationList("github.com/acme\napi.github.com\n"))
      .toEqual(["github.com/acme", "api.github.com"]);
  });

  it("ignores comments, blank lines and surrounding space", () => {
    const src = "# the org ceiling\n\n  github.com/acme  \n\n# and the API\napi.github.com\n";
    expect(parseDestinationList(src)).toEqual(["github.com/acme", "api.github.com"]);
  });

  it("lowercases and strips a trailing slash", () => {
    expect(parseDestinationList("GitHub.com/Acme/\n")).toEqual(["github.com/acme"]);
  });

  it("deduplicates", () => {
    expect(parseDestinationList("github.com/acme\ngithub.com/acme\n"))
      .toEqual(["github.com/acme"]);
  });

  it("reads an empty source as permitting nothing, rather than as everything", () => {
    expect(parseDestinationList("")).toEqual([]);
    expect(parseDestinationList("# only a comment\n")).toEqual([]);
  });

  it("refuses a wildcard, which would permit exfiltration anywhere", () => {
    expect(() => parseDestinationList("*\n")).toThrow(/wildcard/i);
    expect(() => parseDestinationList("*.evil.example.com\n")).toThrow(/wildcard/i);
    expect(() => parseDestinationList("github.com/*\n")).toThrow(/wildcard/i);
  });

  it("refuses a scheme, because an entry is a host with an optional path", () => {
    expect(() => parseDestinationList("https://github.com/acme\n")).toThrow(/scheme/i);
  });

  it("refuses an entry whose host is not a hostname", () => {
    expect(() => parseDestinationList("not a host/x\n")).toThrow(/host/i);
    expect(() => parseDestinationList("/acme/api\n")).toThrow(/host/i);
    expect(() => parseDestinationList("github..com\n")).toThrow(/host/i);
  });

  it("names the line of a bad entry", () => {
    expect(() => parseDestinationList("github.com/acme\n*\n")).toThrow(/line 2/);
  });
});
