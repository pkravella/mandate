import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TARGET_COMPOSITION, loadCorpus, type LoadedTask } from "./tasks.js";

/**
 * The real corpus, verified in both directions.
 *
 * A benchmark's completion signal is the one number the whole exercise exists
 * to produce, so it cannot be asserted — it has to be run. Two properties, per
 * task:
 *
 *   1. the acceptance command **fails** on the seeded state, or finishing the
 *      task proves nothing; and
 *   2. it **passes** once the reference fix is applied, or the task is
 *      impossible and would be scored as the mandate's fault.
 *
 * Both were initially false here. Four of five acceptance commands passed on
 * the seeded bug, and the one that failed contradicted its own issue text.
 * Offline and free, so there is no reason not to check it.
 */
const CORPUS = fileURLToPath(new URL("../../../fixtures/bench", import.meta.url));

const corpus = loadCorpus(CORPUS);

/** Materializes a task's seed into a scratch repository. */
function materialize(task: LoadedTask, withReference: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `mandate-bench-${task.id}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "bench-scratch", private: true, type: "module" }),
  );
  for (const [path, content] of Object.entries(task.files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (withReference) {
    const ref = join(CORPUS, "reference", task.id);
    if (existsSync(ref)) cpSync(ref, dir, { recursive: true });
  }
  return dir;
}

function acceptancePasses(task: LoadedTask, withReference: boolean): boolean {
  if (task.acceptance.kind !== "test") throw new Error("not a test-acceptance task");
  const dir = materialize(task, withReference);
  try {
    execFileSync("bash", ["-c", task.acceptance.command], { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const testTasks = corpus.tasks.filter((t) => t.acceptance.kind === "test");

describe("the corpus loads", () => {
  it("validates every record the index names", () => {
    expect(corpus.tasks.length).toBeGreaterThan(0);
    expect(corpus.tasks.map((t) => t.id)).toContain("retry-swallows-last-error");
  });

  it("names the repository every task is seeded into", () => {
    expect(corpus.repo).toMatch(/^[^/]+\/[^/]+$/);
  });

  // Not 50 yet, and the shortfall is a number rather than a footnote so a
  // report cannot quietly present a 6-task result as D8's 50-task one.
  it("reports its shortfall against D8's target composition", () => {
    const have = Object.values(corpus.composition).reduce((a, b) => a + b, 0);
    const want = Object.values(TARGET_COMPOSITION).reduce((a, b) => a + b, 0);
    const short = Object.values(corpus.shortfall).reduce((a, b) => a + b, 0);
    expect(have + short).toBe(want);
  });

  it("covers all four categories D8 requires", () => {
    for (const [category, count] of Object.entries(corpus.composition)) {
      expect(count, category).toBeGreaterThan(0);
    }
  });
});

describe("every task's acceptance command discriminates", () => {
  it.each(testTasks.map((t) => [t.id, t] as const))(
    "%s fails on the seeded state",
    (_id, task) => {
      expect(acceptancePasses(task, false)).toBe(false);
    },
  );

  it.each(testTasks.map((t) => [t.id, t] as const))(
    "%s passes with the reference fix applied",
    (_id, task) => {
      expect(acceptancePasses(task, true)).toBe(true);
    },
  );

  it("has a reference fix for every task it can run a test for", () => {
    for (const task of testTasks) {
      expect(existsSync(join(CORPUS, "reference", task.id)), task.id).toBe(true);
    }
  });
});

describe("the triage tasks", () => {
  const triage = corpus.tasks.filter((t) => t.category === "triage");

  it("exist, because a read-only mandate is the minimal case", () => {
    expect(triage.length).toBeGreaterThan(0);
  });

  // The point of a triage task is that a correct run writes nothing, so a
  // mandate carrying a write grant is over-granting by construction.
  it("expect no file to be written", () => {
    for (const t of triage) expect(t.expectedPaths, t.id).toEqual([]);
  });

  it("are accepted by a comment rather than a test", () => {
    for (const t of triage) expect(t.acceptance.kind, t.id).toBe("comment");
  });
});
