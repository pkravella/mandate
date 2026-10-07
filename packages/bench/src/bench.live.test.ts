import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { githubAppDeps } from "@mandate-dev/compiler";
import { loadCeiling, type UserAuthority } from "@mandate-dev/validator";
import { seededIssues } from "./seed.js";
import { loadCorpus, compositionOf } from "./tasks.js";
import { loadGroundTruth, runBench } from "./harness.js";
import { renderReport, type CorpusMeta } from "./report.js";

/**
 * The mandated sweep, and the v0.1 report. **This is Phase 3's exit
 * criterion** — except that the criterion names 50 tasks and this corpus has
 * six, which the report states rather than glosses.
 *
 * Spends money, with a predictive budget stop:
 *
 *   MANDATE_BENCH=1 MANDATE_BENCH_BUDGET=2.50 \
 *     pnpm --filter @mandate-dev/bench exec vitest run src/bench.live
 */
const env = (n: string): string | undefined => process.env[n];
const enabled = env("MANDATE_BENCH") === "1"
  && env("ANTHROPIC_API_KEY") !== undefined
  && env("MANDATE_APP_ID") !== undefined
  && env("MANDATE_INSTALLATION_ID") !== undefined
  && env("MANDATE_APP_KEY_PATH") !== undefined;

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
    const corpus = loadCorpus(CORPUS);
    const groundTruth = loadGroundTruth(CORPUS, corpus);
    expect(Object.keys(groundTruth).length, "no ground truth recorded").toBeGreaterThan(0);

    const installationId = Number(env("MANDATE_INSTALLATION_ID") ?? "0");
    const github = githubAppDeps({
      appId: env("MANDATE_APP_ID") ?? "",
      installationId,
      privateKeyPath: env("MANDATE_APP_KEY_PATH") ?? "",
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

    const results = await runBench(corpus, {
      anthropic: new Anthropic(),
      github,
      installationId,
      ceiling,
      authority,
      groundTruth,
      issues,
      outDir: OUT,
      budget: Number(env("MANDATE_BENCH_BUDGET") ?? "2.50"),
      log: (s) => { console.log(`    ${s}`); },
    });

    const meta: CorpusMeta = {
      repo: corpus.repo,
      composition: compositionOf(corpus.tasks),
      shortfall: corpus.shortfall,
      provenance: {
        synthetic: corpus.tasks.filter((t) => t.provenance.kind === "synthetic").length,
        derived: corpus.tasks.filter((t) => t.provenance.kind === "derived").length,
      },
      groundTruthFrom: "six unconstrained runs recorded 2026-10-06 against the live "
        + "github-mcp-server",
    };

    const report = renderReport(results, meta);
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${report}\n`, "utf8");
    console.log(`\n--- report written to ${REPORT}\n`);
    console.log(report);

    expect(results.length).toBeGreaterThan(0);
    // The report must never read as D8's 50-task result.
    expect(report).toMatch(/is not the 50-task result/i);
    expect(report).toMatch(/synthetic/i);
  }, 3_600_000);
});
