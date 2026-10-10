import { describe, expect, it } from "vitest";
import type { ProxyRules, ToolRule } from "@mandate-dev/compiler";
import { extractArgs, makeArgumentEnforcer } from "./enforce.js";

const writeRule: ToolRule = {
  tool: "create_or_update_file", action: "contents.write", resources: ["acme/api"],
  branches: ["agent/42-*"], paths: ["**"],
  denyPaths: [".github/workflows/**", "**.env**"],
};
const prRule: ToolRule = {
  tool: "create_pull_request", action: "pull_request.create", resources: ["acme/api"],
  branches: ["agent/42-*"], base: "main", max: 1,
};
const rules: ProxyRules = {
  mandateId: "fix-issue-42",
  mandateHash: "b".repeat(64), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  allowedTools: [writeRule.tool, prRule.tool], rules: [writeRule, prRule],
  destinations: ["github.com/acme/api"],
};

describe("extractArgs", () => {
  it("reads owner/repo, branch and path from a contents write", () => {
    const e = extractArgs("create_or_update_file", {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
    });
    expect(e).toMatchObject({ repo: "acme/api", branch: "agent/42-fix" });
    expect(e.paths).toEqual(["src/a.ts"]);
  });

  it("reads every path from a batch push_files call", () => {
    const e = extractArgs("push_files", {
      owner: "acme", repo: "api", branch: "agent/42-fix",
      files: [{ path: "src/a.ts" }, { path: ".github/workflows/ci.yml" }],
    });
    expect(e.paths).toEqual(["src/a.ts", ".github/workflows/ci.yml"]);
  });

  it("reads head and base from a PR create", () => {
    const e = extractArgs("create_pull_request", {
      owner: "acme", repo: "api", head: "agent/42-fix", base: "main", title: "x",
    });
    expect(e.branch).toBe("agent/42-fix");
    expect(e.base).toBe("main");
  });

  // R9a names "destination-bearing fields (URLs, remotes, webhook targets, fork
  // owners)", not every string. A URL inside file content or an issue body is
  // not a destination: writing `curl evil.com` into a file sends nothing
  // anywhere, and the bytes still go to GitHub.
  it("reads destinations from destination-bearing fields", () => {
    const e = extractArgs("webhook_create", {
      owner: "acme", repo: "api", url: "https://evil.example.com/collect",
    });
    expect(e.destinations).toEqual(["evil.example.com/collect"]);
  });

  it("does not treat a URL in free text as a destination", () => {
    const e = extractArgs("issue_write", {
      owner: "acme", repo: "api",
      body: "see https://evil.example.com/collect and http://github.com/acme/api/pull/1",
    });
    expect(e.destinations).toEqual([]);
  });

  // Two mechanisms keep content out, and this is the case where the field list
  // is the one doing the work: the URL regex is anchored, so an embedded URL is
  // never extracted anyway, but a body that *starts* with one would be.
  it("ignores a free-text field even when its value begins with a URL", () => {
    const e = extractArgs("issue_write", {
      owner: "acme", repo: "api",
      body: "https://evil.example.com/collect is where to send it",
    });
    expect(e.destinations).toEqual([]);
  });

  it("reads a destination field whose value is exactly a URL", () => {
    const e = extractArgs("webhook_create", {
      owner: "acme", repo: "api", webhook_url: "https://evil.example.com/collect",
    });
    expect(e.destinations).toEqual(["evil.example.com/collect"]);
  });

  it("keeps the path of a destination URL, not just its host", () => {
    const e = extractArgs("repo_fork", { owner: "acme", repo: "api", clone_url: "https://github.com/evil/api.git" });
    expect(e.destinations).toEqual(["github.com/evil/api"]);
  });
});

// Task 5.4. Each shape below extracted to nothing, or to the wrong place,
// before WHATWG parsing replaced the anchored regex -- probed against the
// shipped dist, not reasoned about. "Wrong place" is the worse of the two: the
// call was allowed AND the trace recorded a destination the request never went
// to.
describe("extractArgs: destination shapes", () => {
  const dest = (value: unknown, field = "url"): ReturnType<typeof extractArgs> =>
    extractArgs("t", { owner: "acme", repo: "api", [field]: value });

  it("reads a scheme case-insensitively", () => {
    expect(dest("HTTPS://evil.example.com/x").destinations).toEqual(["evil.example.com/x"]);
  });

  // The regex took `github.com` as the host. Every HTTP client sends this
  // request to evil.example.com; userinfo is everything before the `@`.
  it("reads the host after userinfo, not the userinfo", () => {
    expect(dest("https://github.com@evil.example.com/x").destinations)
      .toEqual(["evil.example.com/x"]);
  });

  // A prefix check on the raw path let `github.com/acme/api/../../evil/x` pass
  // an allow entry of `github.com/acme/api`. Clients resolve dot segments, and
  // so does WHATWG, including the percent-encoded spelling.
  it("resolves dot segments before the prefix is compared", () => {
    expect(dest("https://github.com/acme/api/../../evil/x").destinations)
      .toEqual(["github.com/evil/x"]);
    expect(dest("https://github.com/acme/api/%2e%2e/%2E%2e/evil/x").destinations)
      .toEqual(["github.com/evil/x"]);
  });

  it("drops a default port and keeps any other, so a non-default port fails closed", () => {
    expect(dest("https://github.com:443/acme/api").destinations).toEqual(["github.com/acme/api"]);
    expect(dest("https://github.com:8443/acme/api").destinations)
      .toEqual(["github.com:8443/acme/api"]);
  });

  it("reads ssh:// and git:// URLs", () => {
    expect(dest("ssh://git@evil.example.com/x.git").destinations).toEqual(["evil.example.com/x"]);
    expect(dest("git://evil.example.com/x.git").destinations).toEqual(["evil.example.com/x"]);
  });

  it("reads an scp-style remote, with or without a user", () => {
    expect(dest("git@evil.example.com:acme/api.git", "remote").destinations)
      .toEqual(["evil.example.com/acme/api"]);
    expect(dest("evil.example.com:/acme/api.git", "remote").destinations)
      .toEqual(["evil.example.com/acme/api"]);
  });

  // github-mcp-server v1.14.0's fork_repository takes `organization`, an org
  // name: the only field on the list that any real tool has. It extracted to
  // nothing, so a fork into any organization passed R9a unrecorded.
  it("reads an owner-valued field as that owner on github.com", () => {
    expect(dest("Evil-Org", "organization").destinations).toEqual(["github.com/evil-org"]);
    expect(dest("evil-org", "fork_owner").destinations).toEqual(["github.com/evil-org"]);
  });

  it("does not record an unreadable value as a destination, and records it as unreadable", () => {
    for (const [field, value] of [
      ["url", "//evil.example.com/x"],
      ["url", "evil.example.com/x"],
      ["url", "see https://evil.example.com/x"],
      ["url", "mailto:a@evil.example.com"],
      ["url", "file:///etc/passwd"],
      ["remote", "git@evil.example.com:acme/../../x.git"],
      ["organization", "evil/org"],
      ["organization", "https://evil.example.com"],
      ["url", 42],
    ] as const) {
      const e = dest(value, field);
      expect(e.destinations, `${field}=${String(value)}`).toEqual([]);
      expect(e.unreadableDestinations, `${field}=${String(value)}`)
        .toEqual([{ field, value: String(value) }]);
    }
  });

  // WHATWG leaves a non-special scheme's host opaque: not lowercased, not
  // percent-decoded. Probed. So the host is lowercased here and anything that
  // is not plain labels is refused rather than compared.
  it("lowercases an opaque host, and refuses one that is not plain labels", () => {
    expect(dest("ssh://git@EVIL.Example.com/x").destinations).toEqual(["evil.example.com/x"]);
    expect(dest("ssh://evil%2Eexample.com/x").unreadableDestinations)
      .toEqual([{ field: "url", value: "ssh://evil%2Eexample.com/x" }]);
    expect(dest("ssh://[::1]/x").unreadableDestinations)
      .toEqual([{ field: "url", value: "ssh://[::1]/x" }]);
  });

  // Clients send null or "" for an optional field they are not using. Reading
  // either as an unreadable destination would refuse every such call.
  it("treats a null or empty destination field as absent, not unreadable", () => {
    for (const value of [null, ""]) {
      const e = dest(value);
      expect(e.destinations).toEqual([]);
      expect(e.unreadableDestinations).toBeUndefined();
    }
  });

  it("records nothing as unreadable when every destination field is readable", () => {
    expect(dest("https://github.com/acme/api").unreadableDestinations).toBeUndefined();
  });

  // The field list still decides what is scanned. Failing closed applies inside
  // destination fields only; prose stays prose.
  it("does not scan a free-text field for unreadable values either", () => {
    const e = extractArgs("t", { owner: "acme", repo: "api", body: "//evil.example.com" });
    expect(e.destinations).toEqual([]);
    expect(e.unreadableDestinations).toBeUndefined();
  });
});

describe("makeArgumentEnforcer: destination shapes", () => {
  const forkRule: ToolRule = { tool: "fork_repository", action: "repo.fork", resources: ["acme/api"] };
  const enforceWith = (destinations: readonly string[]) =>
    makeArgumentEnforcer({ ...rules, allowedTools: [forkRule.tool], rules: [forkRule], destinations });

  it("denies a value it cannot read, naming the field and the value", () => {
    const d = enforceWith(["github.com/acme/api"])(forkRule, {
      owner: "acme", repo: "api", url: "//evil.example.com/x",
    });
    expect(d.kind).toBe("deny");
    if (d.kind !== "deny") return;
    expect(d.clause).toBe("destinations.allow");
    expect(d.reason).toContain("url");
    expect(d.reason).toContain("//evil.example.com/x");
  });

  it("denies a fork into an organization the mandate does not name", () => {
    const d = enforceWith(["github.com/acme/api"])(forkRule, {
      owner: "acme", repo: "api", organization: "evil-org",
    });
    expect(d).toMatchObject({ kind: "deny", clause: "destinations.allow" });
  });

  it("allows a fork into an organization the mandate names", () => {
    expect(enforceWith(["github.com/acme-forks"])(forkRule, {
      owner: "acme", repo: "api", organization: "acme-forks",
    })).toMatchObject({ kind: "allow" });
  });

  it("allows the https clone URL of the allowed repository", () => {
    expect(enforceWith(["github.com/acme/api"])(forkRule, {
      owner: "acme", repo: "api", clone_url: "https://github.com/acme/api.git",
    })).toMatchObject({ kind: "allow" });
  });

  // `.git` is dropped only as the whole final suffix; a name that merely
  // starts like the allowed one is still a different repository.
  it("does not let the .git strip reach a sibling repository", () => {
    const d = enforceWith(["github.com/acme/api"])(forkRule, {
      owner: "acme", repo: "api", clone_url: "https://github.com/acme/api-private.git",
    });
    expect(d).toMatchObject({ kind: "deny", clause: "destinations.allow" });
  });

  // The false-pause direction: an scp remote naming the allowed repository is
  // the same place, and must not be refused for its spelling.
  it("allows an scp remote inside the allowed prefix", () => {
    expect(enforceWith(["github.com/acme/api"])(forkRule, {
      owner: "acme", repo: "api", remote: "git@github.com:acme/api.git",
    })).toMatchObject({ kind: "allow" });
  });
});

describe("makeArgumentEnforcer", () => {
  const enforce = makeArgumentEnforcer(rules);

  it("allows a write inside the branch and outside the deny paths", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts", content: "x",
    })).toMatchObject({ kind: "allow" });
  });

  it("denies a write to another repository", () => {
    const d = enforce(writeRule, {
      owner: "evil", repo: "api", branch: "agent/42-fix", path: "a.ts",
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toContain("evil/api");
  });

  it("denies a write to a branch outside the pattern, naming the pattern", () => {
    const d = enforce(writeRule, {
      owner: "acme", repo: "api", branch: "main", path: "src/a.ts",
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.clause).toContain("contents.write");
      expect(d.reason).toContain("agent/42-*");
      expect(d.reason).toContain("main");
    }
  });

  it("denies a write to a workflow file", () => {
    const d = enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: ".github/workflows/ci.yml",
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toContain(".github/workflows/**");
  });

  it("denies a dotenv write", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "packages/x/.env.local",
    }).kind).toBe("deny");
  });

  it("denies a batch write where only one file is out of scope", () => {
    const d = enforce({ ...writeRule, tool: "push_files" }, {
      owner: "acme", repo: "api", branch: "agent/42-fix",
      files: [{ path: "src/a.ts" }, { path: ".github/workflows/ci.yml" }],
    });
    expect(d.kind).toBe("deny");
  });

  it("denies a path that escapes via ..", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix",
      path: "src/../.github/workflows/ci.yml",
    }).kind).toBe("deny");
  });

  // A filename containing a glob metacharacter is ordinary: `pages/[id].tsx` is
  // how Next.js names a dynamic route. It must be matched literally, and must
  // not throw out of the enforcement path.
  it("allows a legitimate filename containing glob metacharacters", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/pages/[id].tsx",
    })).toMatchObject({ kind: "allow" });
  });

  it("still denies such a filename when a deny path covers it", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix",
      path: ".github/workflows/[env].yml",
    }).kind).toBe("deny");
  });

  // A value that cannot be decided must deny, and must deny with a clause --
  // not escape as an exception from inside a request handler.
  it("denies rather than throwing when a value cannot be decided", () => {
    const weird = "\u0000nul";
    const d = enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: weird,
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.clause).toContain("contents.write");
  });

  it("denies a PR whose base is not the granted base", () => {
    const d = enforce(prRule, {
      owner: "acme", repo: "api", head: "agent/42-fix", base: "release/1.0", title: "x",
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toContain("main");
  });

  it("enforces max across calls", () => {
    const e = makeArgumentEnforcer(rules);
    const args = { owner: "acme", repo: "api", head: "agent/42-fix", base: "main", title: "x" };
    expect(e(prRule, args).kind).toBe("allow");
    const second = e(prRule, args);
    expect(second.kind).toBe("deny");
    if (second.kind === "deny") expect(second.reason).toContain("at most 1");
  });

  it("does not spend the max quota on a call it denied for another reason", () => {
    const e = makeArgumentEnforcer(rules);
    expect(e(prRule, {
      owner: "acme", repo: "api", head: "agent/42-fix", base: "release/1.0", title: "x",
    }).kind).toBe("deny");
    expect(e(prRule, {
      owner: "acme", repo: "api", head: "agent/42-fix", base: "main", title: "x",
    }).kind).toBe("allow");
  });

  it("denies a call carrying a destination the mandate does not allow (R9a)", () => {
    const d = enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
      url: "https://evil.example.com/exfil",
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.clause).toBe("destinations.allow");
      expect(d.reason).toContain("evil.example.com");
    }
  });

  it("allows a destination field inside the allowed prefix", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
      url: "https://github.com/acme/api/issues/42",
    }).kind).toBe("allow");
  });

  // The destination is a prefix, not a host. A mandate allowing
  // github.com/acme/api must not permit pushing to github.com/evil/api.
  it("denies another repository on an allowed host", () => {
    const d = enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
      url: "https://github.com/evil/api.git",
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.clause).toBe("destinations.allow");
  });

  it("does not let a prefix match straddle a path segment", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
      url: "https://github.com/acme/api-private/x",
    }).kind).toBe("deny");
  });

  it("does not let a lookalike host pass", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
      url: "https://github.com.evil.example/acme/api",
    }).kind).toBe("deny");
  });

  it("ignores file content when deciding destinations", () => {
    expect(enforce(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts",
      content: "// see https://evil.example.com/docs for why",
    }).kind).toBe("allow");
  });

  it("denies when a required argument is missing rather than assuming a default", () => {
    expect(enforce(writeRule, { owner: "acme", repo: "api", path: "src/a.ts" }).kind)
      .toBe("deny");
  });

  // A rule with no path limit does not limit paths, and a leading slash is
  // repo-relative, so `/etc/passwd` is just a path that does not exist. What
  // must still be refused whatever the rule says is a traversal.
  it("checks for traversal even when the rule constrains neither paths nor denyPaths", () => {
    const bare: ToolRule = {
      tool: "create_or_update_file", action: "contents.write", resources: ["acme/api"],
    };
    const e = makeArgumentEnforcer(rules);
    expect(e(bare, { owner: "acme", repo: "api", path: "../../etc/passwd" }).kind).toBe("deny");
    expect(e(bare, { owner: "acme", repo: "api", path: "/etc/passwd" }).kind).toBe("allow");
  });

  // Found by the live run. `path: "/"` is how github-mcp-server lists the
  // repository root, and treating a leading slash as an escape attempt denied
  // the agent's first call. A leading slash is not a traversal: the contents
  // API is repo-relative either way, so it is normalised off and the path
  // patterns still decide.
  it("allows listing the repository root", () => {
    const readRule: ToolRule = {
      tool: "get_file_contents", action: "repo.read", resources: ["acme/api"],
    };
    expect(makeArgumentEnforcer(rules)(readRule, {
      owner: "acme", repo: "api", path: "/",
    })).toMatchObject({ kind: "allow" });
  });

  it("normalises a leading slash rather than denying it", () => {
    const readRule: ToolRule = {
      tool: "get_file_contents", action: "contents.read", resources: ["acme/api"],
      paths: ["src/**"],
    };
    const e = makeArgumentEnforcer(rules);
    expect(e(readRule, { owner: "acme", repo: "api", path: "/src/a.ts" }).kind).toBe("allow");
    expect(e(readRule, { owner: "acme", repo: "api", path: "/docs/a.md" }).kind).toBe("deny");
  });

  it("still denies a traversal", () => {
    expect(makeArgumentEnforcer(rules)(writeRule, {
      owner: "acme", repo: "api", branch: "agent/42-fix", path: "/src/../.github/workflows/x.yml",
    }).kind).toBe("deny");
  });

  // Also found by the live run. search_code takes a `query`, not owner/repo, so
  // the repository check could never be satisfied and a granted tool was
  // permanently unusable.
  it("reads the repository from a search query's repo: qualifier", () => {
    const searchRule: ToolRule = {
      tool: "search_code", action: "search.code", resources: ["acme/api"],
    };
    expect(makeArgumentEnforcer(rules)(searchRule, {
      query: "retry repo:acme/api",
    })).toMatchObject({ kind: "allow" });
  });

  it("denies a search of another repository", () => {
    const searchRule: ToolRule = {
      tool: "search_code", action: "search.code", resources: ["acme/api"],
    };
    expect(makeArgumentEnforcer(rules)(searchRule, {
      query: "secrets repo:evil/api",
    }).kind).toBe("deny");
  });

  // A search with no repo qualifier runs across all of GitHub, which is not
  // something any mandate grants.
  it("denies a search that names no repository", () => {
    const searchRule: ToolRule = {
      tool: "search_code", action: "search.code", resources: ["acme/api"],
    };
    expect(makeArgumentEnforcer(rules)(searchRule, { query: "AWS_SECRET_ACCESS_KEY" }).kind)
      .toBe("deny");
  });
});
