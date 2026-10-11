import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sweepMeta } from "./harness.js";
import { renderReport, type BenchResult } from "./report.js";
import { loadCorpus } from "./tasks.js";

/**
 * The published report, recomputed from the results it was rendered from.
 *
 * The first sweep kept neither its mandates nor its results, so no figure in
 * it could be checked. The sweep's results.json is now committed beside the
 * report, and this re-renders the report from it: a figure edited by hand, or
 * a report left stale after the renderer changed, fails here. Notes added by
 * hand are blockquotes, and only those are set aside.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

const withoutNotes = (md: string): string =>
  md.split("\n\n").filter((block) => !block.startsWith("> ")).join("\n\n").trim();

describe("docs/benchmark-report.md", () => {
  it("is what the committed results render to, apart from notes added by hand", () => {
    const results = JSON.parse(readFileSync(root("docs/benchmark-results.json"), "utf8")) as BenchResult[];
    const corpus = loadCorpus(root("fixtures/bench"));
    const rendered = renderReport(results, sweepMeta(corpus));
    expect(withoutNotes(readFileSync(root("docs/benchmark-report.md"), "utf8"))).toBe(withoutNotes(rendered));
  });
});
