import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { effortFindings, type WriterSweepRecord } from "./writer-sweep.js";

/**
 * The writer-effort figures the docs quote, recomputed from the writes they
 * came from. published.test.ts exempts hand-written notes, and that is where
 * these live -- so without this, an edit to either the notes or the results
 * would go unchecked. Found by the Phase 6 review, which also found the first
 * wording compared six writes at one setting with five at the other.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const records = JSON.parse(readFileSync(root("docs/writer-effort-results.json"), "utf8")) as WriterSweepRecord[];
const s = (ms: number): string => (ms / 1000).toFixed(1);

describe("the writer-effort figures the docs quote", () => {
  const f = effortFindings(records, { cover: "high", prune: "high" }, { cover: "medium", prune: "medium" });

  it("are what docs/writer-effort-results.json holds", () => {
    expect(f).toEqual({
      paired: 5, candidateFasterOnAll: true,
      candidatePairedMedianMs: 10448, controlPairedMedianMs: 11652, candidateAllMedianMs: 10186,
      fastestGainMs: 431, largestGainMs: 5308,
      candidateIdentical: [6, 6], controlIdentical: [5, 5],
    });
    const highLow = effortFindings(records, { cover: "high", prune: "high" }, { cover: "high", prune: "low" });
    expect(highLow.candidateIdentical).toEqual([2, 5]);
  });

  it("are the ones the report note and the README state", () => {
    const report = readFileSync(root("docs/benchmark-report.md"), "utf8").replace(/\n> /g, " ");
    expect(report).toContain(`median ${s(f.candidatePairedMedianMs)} s against ${s(f.controlPairedMedianMs)} s`);
    expect(report).toContain(`${s(f.candidateAllMedianMs)} s across all six`);
    expect(report).toContain(`by ${s(f.fastestGainMs)} to ${s(f.largestGainMs)} s`);
    const readme = readFileSync(root("README.md"), "utf8").replace(/\n/g, " ");
    expect(readme).toContain(`median of **${s(f.candidatePairedMedianMs)} seconds** against ${s(f.controlPairedMedianMs)}`);
    expect(readme).toContain(`${s(f.candidateAllMedianMs)} across all six`);
  });
});
