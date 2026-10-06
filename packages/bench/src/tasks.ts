import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The benchmark corpus (Decision D8).
 *
 * D8 requires two corpora built in order: task records, and the ground-truth
 * traces produced by running each task **unconstrained** with the recorder on.
 * Over- and under-grant are meaningless without the second, which is why Task
 * 17 depends on this and not the other way round.
 *
 * **One repository hosts every task.** That falls out of a property the system
 * already has: no mandate may permit a write to a default branch, so a run
 * cannot mutate `main`. Each task therefore owns a disjoint set of files, seeds
 * them onto `main` once, and resets by closing its pull request and deleting
 * its branch. The alternative — one repository per task — needs the GitHub App
 * installed on fifty repositories and buys nothing, because the isolation comes
 * from the disjoint paths rather than from the repository boundary.
 *
 * The loader enforces that disjointness, since two tasks sharing a file would
 * interfere in a way no test downstream would attribute correctly.
 */

/**
 * Safe as a path segment, as a GitHub branch suffix and as a trace filename.
 * Lowercase so two records cannot differ only in case on a case-insensitive
 * filesystem.
 */
const TaskId = z.string().regex(
  /^[a-z0-9]+(-[a-z0-9]+)*$/,
  "a task id is lowercase words joined by single hyphens",
);

/** A repository-relative path. Nothing that could escape the repository root. */
const RepoPath = z.string()
  .min(1)
  .refine((p) => !p.startsWith("/"), "a seed path is repository-relative")
  .refine((p) => !p.split("/").includes(".."), "a seed path may not traverse")
  .refine((p) => !p.includes("\0"), "a seed path may not contain NUL")
  .refine((p) => !p.includes("\\"), "a seed path uses forward slashes");

export const CATEGORIES = [
  "single-file-fix", "multi-file-fix", "dependency-bump", "triage",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * The mix D8 fixes: 30 straightforward single-file fixes as the completion-rate
 * baseline, 10 multi-file fixes that need a test added, 5 dependency bumps that
 * write outside `src/**`, and 5 triage-only tasks that read and comment.
 *
 * Exported so a report can print the corpus's shortfall against it as a number.
 * A corpus smaller than 50 is defensible; one whose size is a footnote nobody
 * reads is not.
 */
export const TARGET_COMPOSITION: Readonly<Record<Category, number>> = {
  "single-file-fix": 30,
  "multi-file-fix": 10,
  "dependency-bump": 5,
  triage: 5,
};

/**
 * How completion is decided.
 *
 * Not a bare command string: a triage task writes nothing, so there is no test
 * to run and the evidence is the comment it left. Collapsing both into a string
 * would make the harness guess.
 */
const AcceptanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("test"), command: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("comment") }).strict(),
]);

/**
 * Where the task came from.
 *
 * A discriminated union so a derived task cannot omit its attribution and a
 * synthetic one cannot imply any. The PRD's completion-rate claim rests on the
 * corpus being drawn from real repositories; a synthetic bug is easier than a
 * real one, so a report over synthetic tasks must say so rather than inherit
 * the credibility of one that is not.
 */
const ProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("synthetic"),
    note: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("derived"),
    repo: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "a full commit sha"),
    license: z.string().min(1),
    issueUrl: z.string().min(1),
    note: z.string().min(1),
  }).strict(),
]);

export const BenchTaskSchema = z.object({
  id: TaskId,
  category: z.enum(CATEGORIES),
  issue: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
  }).strict(),
  /** Paths seeded onto the bench repository's default branch. */
  seed: z.array(RepoPath).min(1),
  /**
   * Paths a correct fix is expected to touch. The replay evaluator uses them to
   * tell a mandate that under-granted from a task the agent simply failed.
   */
  expectedPaths: z.array(RepoPath),
  acceptance: AcceptanceSchema,
  provenance: ProvenanceSchema,
}).strict().refine(
  (t) => t.category === "triage" || t.expectedPaths.length > 0,
  { message: "a task that writes must name the paths a fix is expected to touch", path: ["expectedPaths"] },
);

export type BenchTask = z.infer<typeof BenchTaskSchema>;

const IndexSchema = z.object({
  /** `owner/name`. Every task is seeded here. */
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "owner/name"),
  tasks: z.array(TaskId).min(1),
}).strict();

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

/** A task with its seed files read, which is everything the seeder needs. */
export interface LoadedTask extends BenchTask {
  readonly files: Readonly<Record<string, string>>;
}

export interface Corpus {
  readonly repo: string;
  readonly tasks: readonly LoadedTask[];
  readonly composition: Readonly<Record<Category, number>>;
  /** How many of each category the corpus still lacks against D8's target. */
  readonly shortfall: Readonly<Record<Category, number>>;
}

export function compositionOf(tasks: readonly BenchTask[]): Readonly<Record<Category, number>> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const t of tasks) out[t.category] += 1;
  return out;
}

const issues = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

const readJson = (path: string, what: string): unknown => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new CorpusError(`could not read ${what} at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CorpusError(`${what} at ${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * Reads and validates the corpus.
 *
 * Every failure is a refusal rather than a skipped record. A benchmark that
 * quietly drops a malformed task reports a completion rate over whatever
 * happened to load, which is the one number the whole exercise exists to
 * produce.
 */
export function loadCorpus(dir: string): Corpus {
  const indexParse = IndexSchema.safeParse(readJson(join(dir, "index.json"), "the corpus index"));
  if (!indexParse.success) {
    throw new CorpusError(`the corpus index is not usable — ${issues(indexParse.error)}`);
  }
  const index = indexParse.data;

  const seen = new Set<string>();
  const owners = new Map<string, string>();
  const tasks: LoadedTask[] = [];

  for (const id of index.tasks) {
    if (seen.has(id)) throw new CorpusError(`duplicate task id ${JSON.stringify(id)} in the index`);
    seen.add(id);

    const parsed = BenchTaskSchema.safeParse(readJson(join(dir, `${id}.json`), `task ${id}`));
    if (!parsed.success) {
      throw new CorpusError(`task ${id} is not usable — ${issues(parsed.error)}`);
    }
    const task = parsed.data;
    if (task.id !== id) {
      throw new CorpusError(
        `task file ${id}.json declares id ${JSON.stringify(task.id)}; the filename and the `
        + `id must agree, because the id names the trace and the branch`,
      );
    }

    const files: Record<string, string> = {};
    for (const path of task.seed) {
      // Disjointness is what lets one repository host the whole corpus.
      const owner = owners.get(path);
      if (owner !== undefined) {
        throw new CorpusError(
          `tasks ${owner} and ${id} both seed ${path}; tasks must own disjoint files or they `
          + `interfere, and a run's result would be attributed to the wrong task`,
        );
      }
      owners.set(path, id);
      try {
        files[path] = readFileSync(join(dir, "seed", id, path), "utf8");
      } catch (e) {
        throw new CorpusError(
          `task ${id} names seed file ${path}, but it is missing from the corpus `
          + `(${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }

    tasks.push({ ...task, files });
  }

  const composition = compositionOf(tasks);
  const shortfall = Object.fromEntries(
    CATEGORIES.map((c) => [c, Math.max(0, TARGET_COMPOSITION[c] - composition[c])]),
  ) as Record<Category, number>;

  return { repo: index.repo, tasks, composition, shortfall };
}
