import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { githubAppDeps } from "@mandate-dev/compiler";
import { loadCeiling, type UserAuthority } from "@mandate-dev/validator";
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
    const [owner = "", name = ""] = corpus.repo.split("/");
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
    const issuesRes = await github.asInstallation(
      "GET /repos/{owner}/{repo}/issues", listToken,
      { owner, repo: name, state: "all", per_page: 100 },
    );
    const issues: Record<string, number> = {};
    for (const raw of Array.isArray(issuesRes.data) ? issuesRes.data : []) {
      const issue = raw as { number?: unknown; body?: unknown };
      if (typeof issue.body !== "string" || typeof issue.number !== "number") continue;
      const m = /<!-- mandate-bench:([a-z0-9-]+) -->/.exec(issue.body);
      if (m?.[1] !== undefined) issues[m[1]] = issue.number;
    }

    const results = await runBench(corpus, {
      anthropic: new Anthropic(),
      github,
      installationId,
      ceiling,
      authority,
      groundTruth,
      issues,
      corpusDir: CORPUS,
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
    const reportPath = join(CORPUS, "report.md");
    writeFileSync(reportPath, `${report}\n`, "utf8");
    console.log(`\n--- report written to ${reportPath}\n`);
    console.log(report);

    expect(results.length).toBeGreaterThan(0);
    // The report must never read as D8's 50-task result.
    expect(report).toMatch(/is not the 50-task result/i);
    expect(report).toMatch(/synthetic/i);
  }, 3_600_000);
});
