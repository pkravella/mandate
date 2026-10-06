import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BenchTaskSchema, CorpusError, TARGET_COMPOSITION, compositionOf, loadCorpus,
} from "./tasks.js";

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "retry-swallows-last-error",
  category: "single-file-fix",
  issue: { title: "retry() swallows the last error", body: "It returns undefined instead." },
  seed: ["src/retry.js", "test/retry.test.js"],
  expectedPaths: ["src/retry.js", "test/retry.test.js"],
  acceptance: { kind: "test", command: "node --test test/retry.test.js" },
  provenance: { kind: "synthetic", note: "hand-authored for the Mandate benchmark" },
  ...over,
});

describe("BenchTaskSchema", () => {
  it("accepts a well-formed record", () => {
    expect(BenchTaskSchema.parse(task()).id).toBe("retry-swallows-last-error");
  });

  it("requires an id that is safe as a path segment and a branch name", () => {
    for (const bad of ["Retry Swallows", "../escape", "a/b", "", "UPPER"]) {
      expect(() => BenchTaskSchema.parse(task({ id: bad })), bad).toThrow();
    }
  });

  it("rejects an unknown category, so the composition cannot drift silently", () => {
    expect(() => BenchTaskSchema.parse(task({ category: "refactor" }))).toThrow();
  });

  it("rejects an unknown field", () => {
    expect(() => BenchTaskSchema.parse(task({ difficulty: "hard" }))).toThrow();
  });

  it("requires issue text, because the writer's only input is the task", () => {
    expect(() => BenchTaskSchema.parse(task({ issue: { title: "t", body: "" } }))).toThrow();
  });

  // A seed path is written to a real repository. A traversal or an absolute
  // path would escape the repository root.
  it("rejects a seed path that is not repository-relative", () => {
    for (const bad of [["/etc/passwd"], ["../x"], ["a/../../b"], [""], ["a\u0000b"]]) {
      expect(() => BenchTaskSchema.parse(task({ seed: bad })), JSON.stringify(bad)).toThrow();
    }
  });

  it("rejects an empty seed", () => {
    expect(() => BenchTaskSchema.parse(task({ seed: [] }))).toThrow();
  });

  // Provenance is a discriminated union so a derived task cannot omit its
  // attribution and a synthetic one cannot pretend to have any. The report has
  // to be able to say what the corpus is made of.
  it("requires attribution on a derived task", () => {
    const derived = {
      kind: "derived", repo: "acme/api", commit: "a".repeat(40),
      license: "MIT", issueUrl: "https://github.com/acme/api/issues/42",
      note: "the real issue text, lightly trimmed",
    };
    // Each field individually, not all at once: omitting everything fails on
    // whichever check comes first, so a single field quietly becoming optional
    // would not be caught.
    for (const field of ["repo", "commit", "license", "issueUrl", "note"]) {
      const partial = { ...derived };
      delete (partial as Record<string, unknown>)[field];
      expect(() => BenchTaskSchema.parse(task({ provenance: partial })), field).toThrow();
    }
    expect(() => BenchTaskSchema.parse(task({
      provenance: { kind: "derived", repo: "acme/api" },
    }))).toThrow();
    expect(BenchTaskSchema.parse(task({
      provenance: {
        kind: "derived", repo: "acme/api", commit: "a".repeat(40),
        license: "MIT", issueUrl: "https://github.com/acme/api/issues/42",
        note: "the real issue text, lightly trimmed",
      },
    })).provenance.kind).toBe("derived");
  });

  it("rejects a commit that is not a full sha", () => {
    expect(() => BenchTaskSchema.parse(task({
      provenance: {
        kind: "derived", repo: "acme/api", commit: "abc1234",
        license: "MIT", issueUrl: "https://github.com/acme/api/issues/42", note: "n",
      },
    }))).toThrow();
  });

  it("accepts a triage task whose acceptance is a comment rather than a test", () => {
    const t = BenchTaskSchema.parse(task({
      category: "triage", acceptance: { kind: "comment" }, expectedPaths: [],
    }));
    expect(t.acceptance.kind).toBe("comment");
  });

  // A write task that expects no paths cannot be scored for under-granting.
  it("requires expectedPaths on anything that is not triage", () => {
    expect(() => BenchTaskSchema.parse(task({ expectedPaths: [] }))).toThrow();
  });
});

describe("compositionOf", () => {
  it("counts by category", () => {
    const got = compositionOf([
      BenchTaskSchema.parse(task()),
      BenchTaskSchema.parse(task({ id: "b" })),
      BenchTaskSchema.parse(task({
        id: "c", category: "triage", acceptance: { kind: "comment" }, expectedPaths: [],
      })),
    ]);
    expect(got["single-file-fix"]).toBe(2);
    expect(got["triage"]).toBe(1);
    expect(got["dependency-bump"]).toBe(0);
  });

  // D8 fixes the mix at 30/10/5/5. A corpus smaller than that is honest only if
  // the gap is a number the report can print, not a footnote someone forgot.
  it("states the target the corpus is measured against", () => {
    expect(TARGET_COMPOSITION).toEqual({
      "single-file-fix": 30, "multi-file-fix": 10, "dependency-bump": 5, "triage": 5,
    });
    expect(Object.values(TARGET_COMPOSITION).reduce((a, b) => a + b, 0)).toBe(50);
  });
});

describe("loadCorpus", () => {
  /**
   * Writes a corpus to a temp dir. Each record's seed files are written as the
   * record declares them, so a task's paths are whatever its own record says —
   * `omitSeedFiles` is how the missing-file case is built deliberately.
   */
  const corpus = (
    tasks: Record<string, unknown>[],
    opts: { omitSeedFiles?: boolean } = {},
  ): string => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-bench-"));
    writeFileSync(join(dir, "index.json"), JSON.stringify({
      repo: "pkravella/mandate-sandbox",
      tasks: tasks.map((t) => t["id"]),
    }));
    for (const t of tasks) {
      writeFileSync(join(dir, `${String(t["id"])}.json`), JSON.stringify(t));
      if (opts.omitSeedFiles === true) continue;
      for (const f of t["seed"] as string[]) {
        const p = join(dir, "seed", String(t["id"]), f);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "// seeded\n");
      }
    }
    return dir;
  };

  /** A record whose seed paths are its own, so tasks stay disjoint by default. */
  const own = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
    task({
      id,
      seed: [`src/${id}.js`, `test/${id}.test.js`],
      expectedPaths: [`src/${id}.js`, `test/${id}.test.js`],
      acceptance: { kind: "test", command: `node --test test/${id}.test.js` },
      ...over,
    });

  it("loads every task the index names", () => {
    const c = loadCorpus(corpus([own("first"), own("second")]));
    expect(c.tasks.map((t) => t.id)).toEqual(["first", "second"]);
    expect(c.repo).toBe("pkravella/mandate-sandbox");
  });

  it("reads each seed file's contents, so the seeder needs nothing else", () => {
    const c = loadCorpus(corpus([task()]));
    expect(c.tasks[0]?.files["src/retry.js"]).toBe("// seeded\n");
  });

  it("reports the composition and the gap to the target", () => {
    const c = loadCorpus(corpus([task()]));
    expect(c.composition["single-file-fix"]).toBe(1);
    expect(c.shortfall["single-file-fix"]).toBe(29);
    expect(c.shortfall["triage"]).toBe(5);
  });

  it("refuses a record whose id does not match its filename", () => {
    const dir = corpus([task()]);
    writeFileSync(join(dir, "retry-swallows-last-error.json"),
      JSON.stringify(task({ id: "something-else" })));
    expect(() => loadCorpus(dir)).toThrow(CorpusError);
  });

  it("refuses an index naming a task that does not exist", () => {
    const dir = corpus([task()]);
    writeFileSync(join(dir, "index.json"), JSON.stringify({
      repo: "pkravella/mandate-sandbox",
      tasks: ["retry-swallows-last-error", "missing-task"],
    }));
    expect(() => loadCorpus(dir)).toThrow(/missing-task/);
  });

  it("refuses a duplicate id", () => {
    const dir = corpus([task()]);
    writeFileSync(join(dir, "index.json"), JSON.stringify({
      repo: "pkravella/mandate-sandbox",
      tasks: ["retry-swallows-last-error", "retry-swallows-last-error"],
    }));
    expect(() => loadCorpus(dir)).toThrow(/duplicate/i);
  });

  // Two tasks sharing a file would interfere: the corpus relies on each task
  // owning disjoint paths so one repository can host all of them.
  it("refuses two tasks that seed the same path", () => {
    // Deliberately overlapping: one repository hosts the whole corpus, so the
    // isolation comes from disjoint paths and nothing else enforces it.
    const dir = corpus([own("first"), own("second", { seed: ["src/first.js"] })]);
    expect(() => loadCorpus(dir)).toThrow(/src\/first\.js/);
  });

  it("refuses a seed file the record names but the corpus does not contain", () => {
    expect(() => loadCorpus(corpus([task()], { omitSeedFiles: true })))
      .toThrow(/src\/retry\.js/);
  });

  it("refuses an index that is not a corpus index", () => {
    const dir = corpus([task()]);
    writeFileSync(join(dir, "index.json"), JSON.stringify({ tasks: [] }));
    expect(() => loadCorpus(dir)).toThrow(CorpusError);
  });
});
