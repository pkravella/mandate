import { describe, expect, it } from "vitest";
import { MandateSchema, markValidated, type ValidatedMandate } from "@mandate-dev/schema";
import { compileEgress } from "./egress.js";

const m = (allow: string[]): ValidatedMandate => markValidated(MandateSchema.parse({
  mandate: "m", task: "t", requestedBy: "user:a", expiresInMinutes: 60, ceiling: "c@v1",
  grants: [{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
  destinations: { allow },
}), {
  ceilingId: "c@v1", userLevel: "push",
  checkedAt: "2026-10-03T00:00:00.000Z", grantProofs: [],
});

describe("compileEgress hosts", () => {
  it("allows the mandate's host plus the hosts the GitHub API itself needs", () => {
    const p = compileEgress(m(["github.com/acme/api"]));
    expect(p.allowedHosts).toContain("github.com");
    expect(p.allowedHosts).toContain("api.github.com");
  });

  it("does not allow a host the mandate never named", () => {
    expect(compileEgress(m(["github.com/acme/api"])).allowedHosts)
      .not.toContain("evil.example.com");
  });

  it("strips the path, because egress is decided per host", () => {
    const p = compileEgress(m(["github.com/acme/api"]));
    expect(p.allowedHosts).not.toContain("github.com/acme/api");
    expect(p.aclEntries.every((e) => !e.includes("/"))).toBe(true);
  });

  it("deduplicates two destinations on one host", () => {
    const p = compileEgress(m(["github.com/acme/api", "github.com/acme/web"]));
    expect(p.allowedHosts.filter((h) => h === "github.com")).toHaveLength(1);
  });

  it("lowercases the host", () => {
    expect(compileEgress(m(["GitHub.COM/Acme/API"])).allowedHosts).toContain("github.com");
  });
});

// R9a's destinationAllowed extends to subdomains only when the mandate entry is
// a bare host. Egress has to agree: compiling `github.com/acme/api` into a
// `.github.com` ACL would let the agent reach gist.github.com, which the
// mandate never named and the proxy would refuse.
describe("compileEgress subdomain semantics match the proxy's", () => {
  it("keeps a host-with-path destination exact, so subdomains stay out", () => {
    const p = compileEgress(m(["github.com/acme/api"]));
    expect(p.subdomainHosts).toEqual([]);
    expect(p.aclEntries).toContain("github.com");
    expect(p.aclEntries).not.toContain(".github.com");
  });

  it("extends a bare-host destination to its subdomains, as the proxy does", () => {
    const p = compileEgress(m(["example.com"]));
    expect(p.subdomainHosts).toContain("example.com");
    expect(p.aclEntries).toContain(".example.com");
  });
});

// Probed against squid 5.7: a dstdomain ACL carrying both a domain and a
// subdomain of it is rejected, and fatally so when the broader entry comes
// second. The infrastructure hosts are all under github.com, so any mandate
// naming a bare github.com would otherwise emit a config squid refuses to load.
describe("compileEgress collapses the overlaps squid refuses", () => {
  it("drops an exact host already covered by a subdomain entry", () => {
    const p = compileEgress(m(["github.com"]));
    expect(p.aclEntries).toContain(".github.com");
    expect(p.aclEntries).not.toContain("api.github.com");
    expect(p.aclEntries).not.toContain("codeload.github.com");
    // Not under github.com, so it survives.
    expect(p.aclEntries).toContain("objects.githubusercontent.com");
  });

  it("drops an exact host equal to a subdomain entry's own domain", () => {
    const p = compileEgress(m(["github.com", "github.com/acme/api"]));
    expect(p.aclEntries).toContain(".github.com");
    expect(p.aclEntries).not.toContain("github.com");
  });

  it("drops a narrower subdomain entry covered by a broader one", () => {
    const p = compileEgress(m(["example.com", "api.example.com"]));
    expect(p.aclEntries).toContain(".example.com");
    expect(p.aclEntries).not.toContain(".api.example.com");
  });

  it("does not treat a host that merely ends in the same text as a subdomain", () => {
    const p = compileEgress(m(["example.com", "notexample.com"]));
    expect(p.aclEntries).toContain(".example.com");
    expect(p.aclEntries).toContain(".notexample.com");
  });

  it("emits the broader entries first, so a residual overlap warns instead of being fatal", () => {
    const p = compileEgress(m(["example.com"]));
    const firstExact = p.aclEntries.findIndex((e) => !e.startsWith("."));
    const lastDotted = p.aclEntries.map((e) => e.startsWith(".")).lastIndexOf(true);
    expect(lastDotted).toBeLessThan(firstExact);
  });
});

describe("compileEgress refuses what it cannot enforce", () => {
  it("refuses a bare wildcard", () => {
    expect(() => compileEgress(m(["*"]))).toThrow(/wildcard/i);
  });

  // The no-wildcard-destination lint only catches an entry that is exactly `*`
  // or `**`, so these reach the compiler through a validated mandate untouched.
  it("refuses a wildcard inside a host", () => {
    expect(() => compileEgress(m(["*.evil.example.com"]))).toThrow(/wildcard/i);
  });

  it("refuses a wildcard in the path", () => {
    expect(() => compileEgress(m(["github.com/*"]))).toThrow(/wildcard/i);
  });

  it("refuses a destination with no host", () => {
    expect(() => compileEgress(m(["/acme/api"]))).toThrow(/host/i);
  });

  // The config permits CONNECT to 443 only, so a host named on another port
  // would be listed as allowed and still be unreachable.
  it("refuses a port the egress config cannot permit", () => {
    expect(() => compileEgress(m(["github.com:8080/acme"]))).toThrow(/8080/);
  });

  it("accepts an explicit 443, which is the port it permits", () => {
    expect(compileEgress(m(["github.com:443/acme/api"])).allowedHosts).toContain("github.com");
  });

  it("refuses a host that is not a hostname", () => {
    expect(() => compileEgress(m(["not a host/x"]))).toThrow(/host/i);
    expect(() => compileEgress(m(["github..com/x"]))).toThrow(/host/i);
    expect(() => compileEgress(m(["-github.com/x"]))).toThrow(/host/i);
  });

  it("refuses a scheme, because a destination is a host and not a URL", () => {
    expect(() => compileEgress(m(["https://github.com/acme/api"]))).toThrow(/host/i);
  });
});

describe("the generated squid config", () => {
  const conf = compileEgress(m(["github.com/acme/api"])).squidConf;

  it("denies everything that is not allowed", () => {
    expect(conf).toContain("http_access deny all");
  });

  it("allows only CONNECT to 443, which is the control D3 describes", () => {
    expect(conf).toContain("http_access allow CONNECT mandate_allowed SSL_ports");
    expect(conf).toContain("http_access deny CONNECT !SSL_ports");
    // A bare allow on the ACL would permit any method and any port to an
    // allowed host, which makes the CONNECT restriction above it decorative.
    expect(conf).not.toMatch(/^http_access allow mandate_allowed$/m);
  });

  it("names the mandate's host in the ACL", () => {
    expect(conf).toMatch(/^acl mandate_allowed dstdomain .*\bgithub\.com\b/m);
  });

  it("listens on loopback only, so the proxy is not reachable from outside", () => {
    expect(conf).toContain("http_port 127.0.0.1:3128");
  });

  // squid drops privileges to `proxy` and cannot open root's /dev/stdout.
  it("logs somewhere the unprivileged squid user can actually write", () => {
    // The directive, not the whole text: the config explains in a comment why
    // /dev/stdout is not used, and that comment is worth keeping.
    const directives = conf.split("\n").filter((l) => !l.startsWith("#"));
    expect(directives.filter((l) => l.includes("/dev/"))).toEqual([]);
    expect(conf).toContain("access_log stdio:/var/log/squid/access.log");
  });

  it("does not cache, so repository data does not persist in the sandbox", () => {
    expect(conf).toContain("cache deny all");
  });

  it("names the mandate it was generated for", () => {
    expect(conf).toContain("m");
  });
});
