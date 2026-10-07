import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Recorder } from "@mandate-dev/proxy";
import { loadGroundTruth } from "./harness.js";
import { branchFor, taskPrompt } from "./prompt.js";
import { loadCorpus } from "./tasks.js";
import { fileURLToPath } from "node:url";

const CORPUS = fileURLToPath(new URL("../../../fixtures/bench", import.meta.url));

describe("loadGroundTruth", () => {
  it("reads a trace for every task the real corpus has one for", () => {
    const corpus = loadCorpus(CORPUS);
    const gt = loadGroundTruth(CORPUS, corpus);
    for (const task of corpus.tasks) {
      expect(gt[task.id], task.id).toBeDefined();
      expect(gt[task.id]?.mode, task.id).toBe("unconstrained");
    }
  });

  // A missing trace must be absent rather than empty: runBench skips a task it
  // has no ground truth for, and an empty trace would instead score every
  // granted operation as over-granted and report a clean sweep.
  it("omits a task whose trace is missing rather than inventing an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-gt-"));
    const task = {
      id: "only-task", category: "single-file-fix",
      issue: { title: "t", body: "b" },
      seed: ["src/a.js"], expectedPaths: ["src/a.js"],
      acceptance: { kind: "test", command: "true" },
      provenance: { kind: "synthetic", note: "n" },
    };
    writeFileSync(join(dir, "index.json"),
      JSON.stringify({ repo: "a/b", tasks: ["only-task"] }));
    writeFileSync(join(dir, "only-task.json"), JSON.stringify(task));
    const seedPath = join(dir, "seed", "only-task", "src", "a.js");
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, "x\n");

    const corpus = loadCorpus(dir);
    expect(Object.keys(loadGroundTruth(dir, corpus))).toEqual([]);
  });

  it("reads a trace the recorder wrote, not only the committed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-gt2-"));
    const task = {
      id: "only-task", category: "single-file-fix",
      issue: { title: "t", body: "b" },
      seed: ["src/a.js"], expectedPaths: ["src/a.js"],
      acceptance: { kind: "test", command: "true" },
      provenance: { kind: "synthetic", note: "n" },
    };
    writeFileSync(join(dir, "index.json"),
      JSON.stringify({ repo: "a/b", tasks: ["only-task"] }));
    writeFileSync(join(dir, "only-task.json"), JSON.stringify(task));
    const seedPath = join(dir, "seed", "only-task", "src", "a.js");
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, "x\n");

    const r = new Recorder({ mode: "unconstrained" });
    r.recordCall({ tool: "get_file_contents", args: { owner: "a", repo: "b", path: "src/a.js" } })
      .completed({ content: [{ type: "text", text: "x" }] });
    const tracePath = join(dir, "traces", "only-task.unconstrained.jsonl");
    mkdirSync(dirname(tracePath), { recursive: true });
    writeFileSync(tracePath, r.toJsonl());

    const gt = loadGroundTruth(dir, loadCorpus(dir));
    expect(gt["only-task"]?.nodes).toHaveLength(1);
    expect(gt["only-task"]?.nodes[0]?.tool).toBe("get_file_contents");
  });
});

// The divergence that invalidated a sweep: the unconstrained prompt asked for a
// pull request and the mandated one did not, so ground truth contained a call
// the mandated run was never asked to make, and the under-grant it reported was
// an artifact of the two prompts.
describe("taskPrompt", () => {
  const task = {
    id: "only-task", category: "single-file-fix" as const,
    issue: { title: "a title", body: "a body" },
    seed: ["src/a.js"], expectedPaths: ["src/a.js"],
    acceptance: { kind: "test" as const, command: "true" },
    provenance: { kind: "synthetic" as const, note: "n" },
    files: { "src/a.js": "x\n" },
  };

  it("carries the issue the agent is meant to fix", () => {
    const p = taskPrompt(task, "acme/api", 7);
    expect(p).toContain("#7");
    expect(p).toContain("a title");
    expect(p).toContain("a body");
  });

  it("asks for the pull request the acceptance check requires", () => {
    expect(taskPrompt(task, "acme/api", 7)).toMatch(/open a pull request/i);
  });

  it("names the branch both passes expect the work on", () => {
    expect(taskPrompt(task, "acme/api", 7)).toContain(branchFor(task));
    expect(branchFor(task)).toBe("agent/only-task");
  });
});
