import { describe, expect, it } from "vitest";
import type { GitHubResponse, MintDeps } from "@mandate-dev/compiler";
import { seedCorpus, seedTask, taskMarker } from "./seed.js";
import type { Corpus, LoadedTask } from "./tasks.js";

const task = (over: Partial<LoadedTask> = {}): LoadedTask => ({
  id: "retry-swallows-last-error",
  category: "single-file-fix",
  issue: { title: "retry() swallows the last error", body: "It returns undefined." },
  seed: ["src/retry.js"],
  expectedPaths: ["src/retry.js"],
  acceptance: { kind: "test", command: "node --test test/retry.test.js" },
  provenance: { kind: "synthetic", note: "n" },
  files: { "src/retry.js": "export const a = 1;\n" },
  ...over,
});

interface Call { route: string; params: Record<string, unknown> }

/** A stand-in for the contents and issues routes, recording what reached it. */
function fakeGitHub(opts: {
  files?: Record<string, string>;
  issues?: { number: number; body: string }[];
} = {}): { deps: MintDeps; calls: Call[]; files: Record<string, string>; issues: { number: number; body: string }[] } {
  const files: Record<string, string> = { ...opts.files };
  const issues = [...(opts.issues ?? [])];
  const calls: Call[] = [];
  let nextIssue = 100;

  const asInstallation = async (
    route: string, _token: string, params?: Readonly<Record<string, unknown>>,
  ): Promise<GitHubResponse> => {
    const p = { ...(params ?? {}) } as Record<string, unknown>;
    calls.push({ route, params: p });

    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      const path = String(p["path"]);
      const content = files[path];
      return content === undefined
        ? { status: 404, data: { message: "Not Found" } }
        : {
          status: 200,
          data: { sha: `sha-${path}`, content: Buffer.from(content, "utf8").toString("base64") },
        };
    }
    if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
      files[String(p["path"])] = Buffer.from(String(p["content"]), "base64").toString("utf8");
      return { status: 200, data: { commit: { sha: "c" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/issues") {
      return { status: 200, data: issues };
    }
    if (route === "POST /repos/{owner}/{repo}/issues") {
      const n = nextIssue++;
      issues.push({ number: n, body: String(p["body"]) });
      return { status: 201, data: { number: n } };
    }
    throw new Error(`unexpected route ${route}`);
  };

  return {
    deps: { asApp: async () => { throw new Error("unused"); }, asInstallation } as unknown as MintDeps,
    calls, files, issues,
  };
}

describe("seedTask", () => {
  it("writes the task's files and opens its issue", async () => {
    const gh = fakeGitHub();
    const r = await seedTask(gh.deps, "tok", "acme/bench", task());
    expect(r.filesWritten).toEqual(["src/retry.js"]);
    expect(r.issueCreated).toBe(true);
    expect(r.issueNumber).toBe(100);
    expect(gh.files["src/retry.js"]).toBe("export const a = 1;\n");
  });

  it("carries the task marker into the issue body, so a re-seed can find it", async () => {
    const gh = fakeGitHub();
    await seedTask(gh.deps, "tok", "acme/bench", task());
    expect(gh.issues[0]?.body).toContain(taskMarker("retry-swallows-last-error"));
    expect(gh.issues[0]?.body).toContain("It returns undefined.");
  });

  // The issue number is what the task text points the agent at, so a second
  // seeding run must not create a second issue.
  it("reuses an existing issue rather than opening another", async () => {
    const gh = fakeGitHub({
      issues: [{ number: 7, body: `old text\n\n${taskMarker("retry-swallows-last-error")}` }],
    });
    const r = await seedTask(gh.deps, "tok", "acme/bench", task());
    expect(r.issueCreated).toBe(false);
    expect(r.issueNumber).toBe(7);
    expect(gh.issues).toHaveLength(1);
  });

  // Matched on the marker, not the title: a reworded title would otherwise
  // duplicate the issue.
  it("finds the issue even when its title no longer matches", async () => {
    const gh = fakeGitHub({
      issues: [{ number: 9, body: `anything\n\n${taskMarker("retry-swallows-last-error")}` }],
    });
    expect((await seedTask(gh.deps, "tok", "acme/bench", task())).issueNumber).toBe(9);
  });

  it("does not match another task's marker", async () => {
    const gh = fakeGitHub({ issues: [{ number: 9, body: taskMarker("some-other-task") }] });
    expect((await seedTask(gh.deps, "tok", "acme/bench", task())).issueCreated).toBe(true);
  });

  it("leaves a file whose content already matches untouched", async () => {
    const gh = fakeGitHub({ files: { "src/retry.js": "export const a = 1;\n" } });
    const r = await seedTask(gh.deps, "tok", "acme/bench", task());
    expect(r.filesUnchanged).toEqual(["src/retry.js"]);
    expect(r.filesWritten).toEqual([]);
    expect(gh.calls.some((c) => c.route.startsWith("PUT"))).toBe(false);
  });

  // An update needs the blob sha, and omitting it is a 409 against a file that
  // already exists.
  it("passes the existing sha when overwriting a file", async () => {
    const gh = fakeGitHub({ files: { "src/retry.js": "stale\n" } });
    await seedTask(gh.deps, "tok", "acme/bench", task());
    const put = gh.calls.find((c) => c.route.startsWith("PUT"));
    expect(put?.params["sha"]).toBe("sha-src/retry.js");
  });

  it("sends no sha when creating a file", async () => {
    const gh = fakeGitHub();
    await seedTask(gh.deps, "tok", "acme/bench", task());
    const put = gh.calls.find((c) => c.route.startsWith("PUT"));
    expect(put?.params).not.toHaveProperty("sha");
  });

  // Only the PUT is refused. Refusing everything would make this pass on the
  // issues call's error instead, which is a different code path.
  it("fails loudly when a write is refused", async () => {
    const deps = {
      asApp: async () => { throw new Error("unused"); },
      asInstallation: async (route: string): Promise<GitHubResponse> => {
        if (route.startsWith("PUT")) {
          return { status: 403, data: { message: "Resource not accessible by integration" } };
        }
        if (route === "GET /repos/{owner}/{repo}/issues") return { status: 200, data: [] };
        if (route.startsWith("POST")) return { status: 201, data: { number: 1 } };
        return { status: 404, data: {} };
      },
    } as unknown as MintDeps;
    await expect(seedTask(deps, "tok", "acme/bench", task()))
      .rejects.toThrow(/PUT contents.*403.*not accessible/s);
  });

  it("fails loudly when the issue list cannot be read", async () => {
    const deps = {
      asApp: async () => { throw new Error("unused"); },
      asInstallation: async (route: string): Promise<GitHubResponse> => {
        if (route === "GET /repos/{owner}/{repo}/issues") {
          return { status: 500, data: { message: "upstream" } };
        }
        if (route.startsWith("PUT")) return { status: 200, data: {} };
        return { status: 404, data: {} };
      },
    } as unknown as MintDeps;
    await expect(seedTask(deps, "tok", "acme/bench", task()))
      .rejects.toThrow(/GET issues failed/);
  });
});

describe("seedCorpus", () => {
  const corpus = (tasks: readonly LoadedTask[]): Corpus => ({
    repo: "acme/bench",
    tasks,
    composition: { "single-file-fix": tasks.length, "multi-file-fix": 0, "dependency-bump": 0, triage: 0 },
    shortfall: { "single-file-fix": 0, "multi-file-fix": 0, "dependency-bump": 0, triage: 0 },
  });

  it("seeds every task and returns one result each", async () => {
    const gh = fakeGitHub();
    const results = await seedCorpus(gh.deps, "tok", corpus([
      task(),
      task({ id: "second", seed: ["src/second.js"], files: { "src/second.js": "x\n" } }),
    ]));
    expect(results.map((r) => r.taskId)).toEqual(["retry-swallows-last-error", "second"]);
    expect(results.map((r) => r.issueNumber)).toEqual([100, 101]);
  });

  // Concurrent contents writes to one branch race on the blob sha and GitHub
  // rejects the loser with a 409.
  it("writes sequentially", async () => {
    const order: string[] = [];
    const deps = {
      asApp: async () => { throw new Error("unused"); },
      asInstallation: async (route: string, _t: string, p?: Readonly<Record<string, unknown>>) => {
        if (route.startsWith("PUT")) {
          order.push(`start:${String(p?.["path"])}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end:${String(p?.["path"])}`);
          return { status: 200, data: {} } as GitHubResponse;
        }
        if (route === "GET /repos/{owner}/{repo}/issues") return { status: 200, data: [] } as GitHubResponse;
        if (route.startsWith("POST")) return { status: 201, data: { number: 1 } } as GitHubResponse;
        return { status: 404, data: {} } as GitHubResponse;
      },
    } as unknown as MintDeps;

    await seedCorpus(deps, "tok", corpus([
      task({ id: "a", seed: ["src/a.js"], files: { "src/a.js": "a\n" } }),
      task({ id: "b", seed: ["src/b.js"], files: { "src/b.js": "b\n" } }),
    ]));
    expect(order).toEqual(["start:src/a.js", "end:src/a.js", "start:src/b.js", "end:src/b.js"]);
  });
});
