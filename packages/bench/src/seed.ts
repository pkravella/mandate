import type { MintDeps } from "@mandate-dev/compiler";
import type { Corpus, LoadedTask } from "./tasks.js";

/**
 * Seeds the corpus into the bench repository: each task's files onto the
 * default branch, and one issue per task.
 *
 * Deliberately **not** part of the enforced loop. Seeding writes to the default
 * branch and opens issues, which no mandate permits and none should — the
 * agent's authority is the thing under measurement, so the fixture it runs
 * against has to be built by something outside it. This uses the installation
 * token directly and says so.
 *
 * Idempotent by design: a file whose content already matches is left alone, and
 * a task whose issue already exists is reused rather than duplicated. Re-running
 * the seeder must not create a second issue for a task, because the issue number
 * is what the task text points the agent at.
 */

export interface SeedResult {
  readonly taskId: string;
  readonly issueNumber: number;
  readonly filesWritten: readonly string[];
  readonly filesUnchanged: readonly string[];
  readonly issueCreated: boolean;
}

/** Marks an issue as belonging to a corpus task, so re-seeding can find it. */
export const taskMarker = (taskId: string): string =>
  `<!-- mandate-bench:${taskId} -->`;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

interface ExistingFile {
  readonly sha: string;
  readonly content: string;
}

async function getFile(
  deps: MintDeps, token: string, repo: string, path: string,
): Promise<ExistingFile | undefined> {
  const [owner = "", name = ""] = repo.split("/");
  const res = await deps.asInstallation(
    "GET /repos/{owner}/{repo}/contents/{path}", token, { owner, repo: name, path },
  );
  if (res.status === 404) return undefined;
  if (res.status >= 300) {
    throw new Error(`GET contents/${path} failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  const data = res.data as { sha?: unknown; content?: unknown };
  if (typeof data.sha !== "string") return undefined;
  const raw = typeof data.content === "string" ? data.content : "";
  return { sha: data.sha, content: Buffer.from(raw, "base64").toString("utf8") };
}

/**
 * Finds the issue already seeded for a task, by its marker.
 *
 * Matched on a marker in the body rather than on the title: a title is the
 * thing most likely to be edited by hand, and matching on it would create a
 * duplicate issue the moment someone reworded one.
 */
/**
 * Every issue in the repository, following pagination.
 *
 * One page of 100 is enough for six tasks and not for fifty — plus whatever
 * issues the agents themselves opened. A marker on page two would be missed,
 * the seeder would open a duplicate, and the task would point at whichever
 * issue it found first. The failure is silent, so it is paged rather than
 * capped.
 */
async function allIssues(
  deps: MintDeps, token: string, repo: string,
): Promise<readonly { number?: unknown; body?: unknown }[]> {
  const [owner = "", name = ""] = repo.split("/");
  const out: { number?: unknown; body?: unknown }[] = [];
  // A repository with more issues than this is not a benchmark fixture.
  for (let page = 1; page <= 20; page += 1) {
    const res = await deps.asInstallation(
      "GET /repos/{owner}/{repo}/issues", token,
      { owner, repo: name, state: "all", per_page: 100, page },
    );
    if (res.status >= 300) {
      throw new Error(`GET issues failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    const batch = Array.isArray(res.data) ? res.data : [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function findIssue(
  deps: MintDeps, token: string, repo: string, taskId: string,
): Promise<number | undefined> {
  const marker = taskMarker(taskId);
  for (const raw of await allIssues(deps, token, repo)) {
    const issue = raw as { number?: unknown; body?: unknown };
    if (typeof issue.body === "string" && issue.body.includes(marker)
      && typeof issue.number === "number") {
      return issue.number;
    }
  }
  return undefined;
}

/** The task each seeded issue belongs to, by its marker. */
export async function seededIssues(
  deps: MintDeps, token: string, repo: string,
): Promise<Readonly<Record<string, number>>> {
  const out: Record<string, number> = {};
  for (const raw of await allIssues(deps, token, repo)) {
    const issue = raw as { number?: unknown; body?: unknown };
    if (typeof issue.body !== "string" || typeof issue.number !== "number") continue;
    const m = /<!-- mandate-bench:([a-z0-9-]+) -->/.exec(issue.body);
    if (m?.[1] !== undefined) out[m[1]] = issue.number;
  }
  return out;
}

export async function seedTask(
  deps: MintDeps, token: string, repo: string, task: LoadedTask,
): Promise<SeedResult> {
  const [owner = "", name = ""] = repo.split("/");
  const written: string[] = [];
  const unchanged: string[] = [];

  for (const [path, content] of Object.entries(task.files)) {
    const existing = await getFile(deps, token, repo, path);
    if (existing !== undefined && existing.content === content) {
      unchanged.push(path);
      continue;
    }
    const res = await deps.asInstallation(
      "PUT /repos/{owner}/{repo}/contents/{path}", token,
      {
        owner, repo: name, path,
        message: `bench: seed ${task.id}`,
        content: b64(content),
        ...(existing !== undefined ? { sha: existing.sha } : {}),
      },
    );
    if (res.status >= 300) {
      throw new Error(`PUT contents/${path} failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    written.push(path);
  }

  const found = await findIssue(deps, token, repo, task.id);
  if (found !== undefined) {
    return {
      taskId: task.id, issueNumber: found,
      filesWritten: written, filesUnchanged: unchanged, issueCreated: false,
    };
  }

  const res = await deps.asInstallation(
    "POST /repos/{owner}/{repo}/issues", token,
    {
      owner, repo: name,
      title: task.issue.title,
      body: `${task.issue.body}\n\n${taskMarker(task.id)}`,
    },
  );
  if (res.status >= 300) {
    throw new Error(`POST issues failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  const created = (res.data as { number?: unknown }).number;
  if (typeof created !== "number") {
    throw new Error(`POST issues returned no issue number: ${JSON.stringify(res.data)}`);
  }
  return {
    taskId: task.id, issueNumber: created,
    filesWritten: written, filesUnchanged: unchanged, issueCreated: true,
  };
}

export async function seedCorpus(
  deps: MintDeps, token: string, corpus: Corpus,
): Promise<readonly SeedResult[]> {
  const out: SeedResult[] = [];
  // Sequential on purpose: concurrent contents writes to one branch race on the
  // blob sha and GitHub rejects the loser with a 409.
  for (const task of corpus.tasks) {
    out.push(await seedTask(deps, token, corpus.repo, task));
  }
  return out;
}
