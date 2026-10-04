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
  mandateId: "fix-issue-42", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
    expect(e.destinations).toEqual(["github.com/evil/api.git"]);
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

  it("checks a suspicious path even when the rule constrains neither paths nor denyPaths", () => {
    const bare: ToolRule = {
      tool: "create_or_update_file", action: "contents.write", resources: ["acme/api"],
    };
    expect(makeArgumentEnforcer(rules)(bare, {
      owner: "acme", repo: "api", path: "/etc/passwd",
    }).kind).toBe("deny");
  });
});
