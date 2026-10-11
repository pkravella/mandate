import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The DCO workflow's script, run for real against a scratch repository.
 *
 * `dco` is a required check, so its script decides what can merge. It is
 * extracted from the workflow file rather than copied, so the test runs the
 * text GitHub runs.
 *
 * Dependabot cannot sign off, so its pull requests failed `dco` every time. It
 * is exempt -- but only for its own commits on its own pull requests. Keying on
 * the pull request's author alone would also exempt a human pushing onto a
 * Dependabot branch, and keying on a commit's author email alone would exempt
 * anyone who set that email, which any git user can.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

interface Step { readonly name?: string; readonly run?: string; readonly env?: Record<string, string> }
const workflow = parse(readFileSync(root(".github/workflows/dco.yml"), "utf8")) as {
  jobs: { dco: { steps: Step[] } };
};
const step = workflow.jobs.dco.steps.find((s) => s.run !== undefined);
const script = step?.run ?? "";

const DEPENDABOT = "49699333+dependabot[bot]@users.noreply.github.com";
const HUMAN = "alice@example.com";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository with one base commit, and the given commits on top of it. */
const repoWith = (commits: readonly { email: string; signOff: boolean }[]) => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-dco-"));
  git(dir, "init", "-q");
  const commit = (email: string, message: string): void => {
    writeFileSync(join(dir, "f"), `${Math.random()}`);
    git(dir, "add", "f");
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: email,
      },
    });
  };
  commit(HUMAN, `base\n\nSigned-off-by: a <${HUMAN}>`);
  const base = git(dir, "rev-parse", "HEAD");
  for (const c of commits) {
    commit(c.email, c.signOff ? `change\n\nSigned-off-by: a <${c.email}>` : "change");
  }
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
};

const runDco = (prAuthor: string, commits: readonly { email: string; signOff: boolean }[]): number => {
  const { dir, base, head } = repoWith(commits);
  const r = spawnSync("bash", ["-c", script], {
    cwd: dir,
    env: { ...process.env, BASE: base, HEAD: head, PR_AUTHOR: prAuthor },
    encoding: "utf8",
  });
  return r.status ?? -1;
};

describe("dco.yml", () => {
  it("passes a signed-off commit and fails an unsigned one", () => {
    expect(runDco("alice", [{ email: HUMAN, signOff: true }])).toBe(0);
    expect(runDco("alice", [{ email: HUMAN, signOff: false }])).not.toBe(0);
  });

  it("passes Dependabot's own unsigned commit on Dependabot's pull request", () => {
    expect(runDco("dependabot[bot]", [{ email: DEPENDABOT, signOff: false }])).toBe(0);
  });

  it("still fails a human's unsigned commit pushed onto Dependabot's pull request", () => {
    expect(runDco("dependabot[bot]", [
      { email: DEPENDABOT, signOff: false }, { email: HUMAN, signOff: false },
    ])).not.toBe(0);
  });

  it("does not exempt a commit claiming Dependabot's email on someone else's pull request", () => {
    expect(runDco("alice", [{ email: DEPENDABOT, signOff: false }])).not.toBe(0);
  });

  it("takes the pull request's author from the event, through the environment", () => {
    expect(step?.env?.PR_AUTHOR).toBe("${{ github.event.pull_request.user.login }}");
    expect(script).not.toContain("${{");
  });
});
