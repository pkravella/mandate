import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { loadCeiling, type UserAuthority } from "@mandate-dev/validator";
import { loadGroundTruth, selectTasks } from "./harness.js";
import type { BenchResult } from "./report.js";
import { loadCorpus } from "./tasks.js";
import { parseSettings, runWriterSweep, summarizeWriterSweep } from "./writer-sweep.js";

/**
 * Task 6.2's measurement: every corpus task's mandate written again at each
 * effort setting and compared with the one docs/benchmark-results.json holds,
 * which the published sweep wrote at high/high. Writes only -- no GitHub, no
 * agent -- so it needs only the Anthropic key. Spends money:
 *
 *   MANDATE_WRITER_SWEEP=1 MANDATE_WRITER_BUDGET=0.50 \
 *     pnpm --filter @mandate-dev/bench exec vitest run src/writer-sweep.live
 *
 * MANDATE_WRITER_SETTINGS takes cover/prune pairs, by default
 * high/high,high/low,medium/medium. MANDATE_WRITER_TASKS names a subset of
 * task ids. Results go to bench/out/.
 */
const env = (n: string): string | undefined => process.env[n];
const enabled = env("MANDATE_WRITER_SWEEP") === "1" && env("ANTHROPIC_API_KEY") !== undefined;

const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(root(p), "utf8");
const OUT = root("bench/out");

describe.skipIf(!enabled)("the writer at several efforts", () => {
  it("writes each task's mandate per setting and compares it with the published one", async () => {
    const corpus = selectTasks(loadCorpus(root("fixtures/bench")), env("MANDATE_WRITER_TASKS")).corpus;
    const ceiling = loadCeiling(
      "sandbox@v1",
      read("fixtures/ceilings/sandbox-v1.cedar"),
      read("fixtures/ceilings/schema.cedarschema"),
      read("fixtures/ceilings/sandbox-v1.destinations"),
    );
    const authority: UserAuthority = { login: "pkravella", level: "admin" };
    const records = await runWriterSweep(corpus, {
      anthropic: new Anthropic(),
      ceiling,
      authority,
      groundTruth: loadGroundTruth(root("fixtures/bench"), corpus),
      baseline: JSON.parse(read("docs/benchmark-results.json")) as BenchResult[],
      settings: parseSettings(env("MANDATE_WRITER_SETTINGS")),
      budget: Number(env("MANDATE_WRITER_BUDGET") ?? "0.50"),
      log: (s) => { console.log(`    ${s}`); },
    });
    const summary = summarizeWriterSweep(records);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "writer-sweep.json"), `${JSON.stringify(records, null, 2)}\n`, "utf8");
    writeFileSync(join(OUT, "writer-sweep.md"), `${summary}\n`, "utf8");
    console.log(summary);
    expect(records.length).toBeGreaterThan(0);
  }, 3_600_000);
});
