import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { githubAppDeps } from "@leastpilot/compiler";
import { loadCeiling, type UserAuthority } from "@leastpilot/validator";
import { seededIssues } from "./seed.js";
import { loadCorpus } from "./tasks.js";
import {
  applyPrior, inCorpusOrder, loadGroundTruth, parseModes, runBench, selectTasks, sweepMeta,
} from "./harness.js";
import { renderReport, type BenchResult } from "./report.js";

/**
 * The mandated sweep, and the v0.1 report. **This is Phase 3's exit
 * criterion** — except that the criterion names 50 tasks and this corpus has
 * six, which the report states rather than glosses.
 *
 * Spends money, with a predictive budget stop:
 *
 *   LEASTPILOT_BENCH=1 LEASTPILOT_BENCH_BUDGET=2.50 \
 *     pnpm --filter @leastpilot/bench exec vitest run src/bench.live
 *
 * LEASTPILOT_BENCH_MODES=granted,all (the default) runs each task's agent once
 * per tool-visibility mode under one mandate (Task 6.1). LEASTPILOT_BENCH_TASKS
 * runs only the named tasks, and then writes its report to bench/out/ rather
 * than replacing the published one. LEASTPILOT_BENCH_PRIOR names an earlier
 * sweep's results.json: tasks it covers in every mode are not run again, and
 * the report and results.json cover both.
 */
const env = (n: string): string | undefined => process.env[n];
const enabled = env("LEASTPILOT_BENCH") === "1"
  && env("ANTHROPIC_API_KEY") !== undefined
  && env("LEASTPILOT_APP_ID") !== undefined
  && env("LEASTPILOT_INSTALLATION_ID") !== undefined
  && env("LEASTPILOT_APP_KEY_PATH") !== undefined;

const CORPUS = fileURLToPath(new URL("../../../fixtures/bench", import.meta.url));
/** Scratch output. Gitignored, because a sweep's traces are not fixtures. */
const OUT = fileURLToPath(new URL("../../../bench/out", import.meta.url));
/**
 * The report is a published document, so it lives in `docs/` rather than under
 * `fixtures/`: it is the deliverable, not an input to a test.
 */
const REPORT = fileURLToPath(new URL("../../../docs/benchmark-report.md", import.meta.url));
const CEILINGS = fileURLToPath(new URL("../../../fixtures/ceilings", import.meta.url));
const read = (p: string): string => readFileSync(p, "utf8");

describe.skipIf(!enabled)("the mandated sweep", () => {
  it("runs the corpus under mandates and writes the report", async () => {
    const modes = parseModes(env("LEASTPILOT_BENCH_MODES"));
    const selected = selectTasks(loadCorpus(CORPUS), env("LEASTPILOT_BENCH_TASKS"));
    const corpus = selected.corpus;
    const groundTruth = loadGroundTruth(CORPUS, corpus);
    expect(Object.keys(groundTruth).length, "no ground truth recorded").toBeGreaterThan(0);

    const installationId = Number(env("LEASTPILOT_INSTALLATION_ID") ?? "0");
    const github = githubAppDeps({
      appId: env("LEASTPILOT_APP_ID") ?? "",
      installationId,
      privateKeyPath: env("LEASTPILOT_APP_KEY_PATH") ?? "",
    });

    const ceiling = loadCeiling(
      "sandbox@v1",
      read(join(CEILINGS, "sandbox-v1.cedar")),
      read(join(CEILINGS, "schema.cedarschema")),
      read(join(CEILINGS, "sandbox-v1.destinations")),
    );
    const authority: UserAuthority = { login: "pkravella", level: "admin" };

    // Issue numbers come from the seeder's marker, not from the records: an
    // issue number is a fact about the repository and hard-coding one would
    // point a run at the wrong issue after a re-seed.
    const name = corpus.repo.split("/")[1] ?? "";
    const tokenRes = await github.asApp(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        repositories: [name],
        permissions: { issues: "read", metadata: "read" },
      },
    );
    expect(tokenRes.status, JSON.stringify(tokenRes.data)).toBe(201);
    const listToken = String((tokenRes.data as { token?: unknown }).token);
    // The shared lookup, not a third copy of the marker regex. Two copies of
    // the task *prompt* is what silently invalidated a whole sweep; the same
    // duplication here would point runs at the wrong issue after a re-seed.
    const issues = await seededIssues(github, listToken, corpus.repo);
    for (const task of corpus.tasks) {
      expect(issues[task.id], `${task.id} has no seeded issue`).toBeDefined();
    }

    const priorPath = env("LEASTPILOT_BENCH_PRIOR");
    const prior = priorPath === undefined ? [] : JSON.parse(read(priorPath)) as BenchResult[];
    const { corpus: toRun, kept } = applyPrior(corpus, prior, modes);

    const fresh = await runBench(toRun, {
      anthropic: new Anthropic(),
      github,
      installationId,
      ceiling,
      authority,
      groundTruth,
      issues,
      outDir: OUT,
      modes,
      budget: Number(env("LEASTPILOT_BENCH_BUDGET") ?? "2.50"),
      log: (s) => { console.log(`    ${s}`); },
    });
    // One file holds every result the report is computed from.
    const results = inCorpusOrder(corpus, [...kept, ...fresh], modes);
    writeFileSync(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");

    const meta = sweepMeta(corpus);

    const report = renderReport(results, meta);
    // A subset's report is a probe, not the published result.
    const target = selected.subset ? join(OUT, "report.md") : REPORT;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${report}\n`, "utf8");
    console.log(`\n--- report written to ${target}\n`);
    console.log(report);

    expect(results.length).toBeGreaterThan(0);
    // The report must never read as D8's 50-task result.
    expect(report).toMatch(/is not the 50-task result/i);
    expect(report).toMatch(/synthetic/i);
  }, 3_600_000);
});
