import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The sandboxed agent's working copy: a throwaway clone of HEAD.
 *
 * Not the operator's checkout, mounted. A writable `.git` from the host lets
 * the agent plant a hook or a `core.fsmonitor` command that the operator's own
 * git runs, on the host, at their next command -- out of the sandbox entirely.
 * And the working tree carries what is ignored and untracked, which is where a
 * `.env` lives. A depth-1 clone of HEAD over file:// carries HEAD's tree and no
 * other object -- not history, not other branches, not stashes -- a config of
 * its own, and no hooks.
 *
 * Not a clone with the minted token either: the token is coarser than the
 * mandate (threat-model §3.2), so inside the container `git push` with it
 * would skip every branch and path limit the proxy enforces.
 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface Workspace {
  /** The clone, on the host. Mounted read-only and copied in by the entrypoint. */
  readonly path: string;
  /** The commit it is at, which is the source's HEAD. */
  readonly head: string;
  /** The source's branch, or undefined on a detached HEAD. */
  readonly branch?: string;
}

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** How many dirty paths a refusal names before it summarises the rest. */
const NAMED = 5;

export function prepareWorkspace(source: string, into: string): Workspace {
  let root: string;
  try {
    root = git(source, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new WorkspaceError(`${source} is not a git repository; the sandbox clones HEAD from one`);
  }

  // Uncommitted work would silently not be in the clone. Ignored files are not
  // listed, and are exactly the ones meant to stay out.
  const dirty = git(root, ["status", "--porcelain"]).split("\n").filter((l) => l.length > 0);
  if (dirty.length > 0) {
    const named = dirty.slice(0, NAMED).map((l) => `  ${l}`).join("\n");
    const more = dirty.length > NAMED ? `\n  ... and ${dirty.length - NAMED} more` : "";
    throw new WorkspaceError(
      "the working tree has uncommitted changes, which the sandbox's clone of HEAD would not "
      + `contain. Commit or stash them first:\n${named}${more}`,
    );
  }

  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const branchRef = (() => {
    try { return git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); } catch { return ""; }
  })();

  const path = join(into, "workspace");
  const noTemplates = join(into, "no-templates");
  mkdirSync(noTemplates, { recursive: true });
  // An empty template directory, because the operator's global config can set
  // `init.templateDir`, and a clone copies hooks from it.
  //
  // Through the file:// transport, one commit deep, one branch, no tags. A
  // plain local clone takes git's fast path and copies the whole object store:
  // found reviewing Phase 5, a secret amended out of history or stashed was
  // readable in the agent's copy with `git cat-file`. Over the transport only
  // what HEAD reaches crosses, and at depth 1 that is HEAD's tree and nothing
  // older -- so the agent has no history, which is the cost.
  git(into, [
    "clone", "--quiet", "--no-local", "--depth", "1", "--single-branch", "--no-tags",
    `--template=${noTemplates}`, pathToFileURL(root).href, path,
  ]);
  // The clone's origin is the operator's checkout, by path. Nothing the agent
  // does should be able to fetch from or push to it.
  git(path, ["remote", "remove", "origin"]);

  const cloned = git(path, ["rev-parse", "HEAD"]).trim();
  if (cloned !== head) {
    throw new WorkspaceError(`the clone is at ${cloned}, not the source's HEAD ${head}`);
  }
  return { path, head, ...(branchRef.length > 0 ? { branch: branchRef } : {}) };
}
