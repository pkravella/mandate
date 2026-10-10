import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareWorkspace, WorkspaceError } from "./workspace.js";

/**
 * The sandboxed agent works in a throwaway clone of HEAD, never the operator's
 * checkout (Task 5.1 b). A writable `.git` mounted from the host would let the
 * agent plant a hook or `core.fsmonitor` that runs on the host at the
 * operator's next git command; the working tree carries ignored and untracked
 * secrets like `.env`. A `file://` clone of HEAD carries neither: committed
 * content only, a fresh config, template hooks.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repository with one commit, and every hazard planted around it. */
function sourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mandate-ws-src-"));
  git(dir, "init", "-q", "-b", "agent/42-fix");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "committed\n");
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  git(dir, "add", "README.md", ".gitignore");
  git(dir, "commit", "-q", "-m", "init");
  // A remote carrying a credential, as `git clone https://x:TOKEN@...` leaves.
  git(dir, "remote", "add", "origin", "https://x-access-token:ghp_PLANTED@github.com/acme/api.git");
  // A hook that would run on the host.
  writeFileSync(join(dir, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho PLANTED-HOOK\n", { mode: 0o755 });
  // An ignored secret in the working tree.
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=ghp_PLANTED\n");
  return dir;
}

const into = (): string => mkdtempSync(join(tmpdir(), "mandate-ws-dst-"));

describe("prepareWorkspace", () => {
  it("clones HEAD's committed content", () => {
    const ws = prepareWorkspace(sourceRepo(), into());
    expect(readFileSync(join(ws.path, "README.md"), "utf8")).toBe("committed\n");
    expect(ws.head).toMatch(/^[0-9a-f]{40}$/);
    expect(ws.branch).toBe("agent/42-fix");
  });

  it("leaves out an ignored secret in the working tree", () => {
    const ws = prepareWorkspace(sourceRepo(), into());
    expect(existsSync(join(ws.path, ".env"))).toBe(false);
  });

  it("carries no remote, so no credential from the source's config", () => {
    const ws = prepareWorkspace(sourceRepo(), into());
    expect(git(ws.path, "remote").trim()).toBe("");
    expect(readFileSync(join(ws.path, ".git", "config"), "utf8")).not.toContain("PLANTED");
  });

  /** Hook files in a clone; none at all when no template was applied. */
  const hooksOf = (ws: string): string[] => {
    const dir = join(ws, ".git", "hooks");
    return existsSync(dir) ? readdirSync(dir).filter((h) => !h.endsWith(".sample")) : [];
  };

  it("carries none of the source's hooks", () => {
    expect(hooksOf(prepareWorkspace(sourceRepo(), into()).path)).toEqual([]);
  });

  // A clone copies hooks from `init.templateDir`, which the operator's global
  // config may set. Those would run inside the sandbox rather than on the host,
  // but they are still code nobody chose to give this agent.
  it("carries no hook from a global init.templateDir", () => {
    const tpl = mkdtempSync(join(tmpdir(), "mandate-ws-tpl-"));
    mkdirSync(join(tpl, "hooks"));
    writeFileSync(join(tpl, "hooks", "post-checkout"), "#!/bin/sh\necho TEMPLATE-HOOK\n", { mode: 0o755 });
    const globalConfig = join(tpl, "gitconfig");
    writeFileSync(globalConfig, `[init]\n\ttemplateDir = ${tpl}\n`);
    const src = sourceRepo();
    const before = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
    try {
      // The planted template is live: a plain clone picks the hook up.
      const plain = join(into(), "plain");
      git(tmpdir(), "clone", "--quiet", src, plain);
      expect(hooksOf(plain)).toEqual(["post-checkout"]);
      expect(hooksOf(prepareWorkspace(src, into()).path)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = before;
    }
  });

  it("works from a subdirectory of the repository", () => {
    const src = sourceRepo();
    mkdirSync(join(src, "pkg"));
    const ws = prepareWorkspace(join(src, "pkg"), into());
    expect(existsSync(join(ws.path, "README.md"))).toBe(true);
  });

  // Uncommitted work would silently not be in the clone. Refusing says so
  // rather than handing the agent a tree that is not the one the operator sees.
  it("refuses a modified tracked file, naming it", () => {
    const src = sourceRepo();
    writeFileSync(join(src, "README.md"), "edited\n");
    expect(() => prepareWorkspace(src, into())).toThrow(WorkspaceError);
    expect(() => prepareWorkspace(src, into())).toThrow(/README\.md/);
  });

  it("refuses an untracked file that is not ignored", () => {
    const src = sourceRepo();
    writeFileSync(join(src, "notes.txt"), "x\n");
    expect(() => prepareWorkspace(src, into())).toThrow(/notes\.txt/);
  });

  it("refuses a directory that is not a git repository", () => {
    expect(() => prepareWorkspace(mkdtempSync(join(tmpdir(), "mandate-ws-none-")), into()))
      .toThrow(/not a git repository/);
  });
});
