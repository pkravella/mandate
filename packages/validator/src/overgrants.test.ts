import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMandateYaml, type ProposedMandate } from "@mandate-dev/schema";
import { loadCeiling } from "./ceiling.js";
import { validate } from "./validate.js";
import type { UserAuthority } from "./userAuthority.js";

const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(root(p), "utf8");

const ceiling = loadCeiling(
  "org-policy@v12",
  read("fixtures/ceilings/org-policy-v12.cedar"),
  read("fixtures/ceilings/schema.cedarschema"),
  read("fixtures/ceilings/org-policy-v12.destinations"),
);

interface Case {
  readonly file: string;
  /** "schema" means the mandate is refused before validate() is reached. */
  readonly expect: string;
}
const cases: Case[] = JSON.parse(read("fixtures/overgrants/index.json")) as Case[];

const AUTHORITY: Readonly<Record<string, UserAuthority>> = {
  "user:alice": { login: "alice", level: "push" },
  "user:bob": { login: "bob", level: "pull" },
};

type Outcome =
  | { readonly rejected: true; readonly codes: readonly string[] }
  | { readonly rejected: false };

function run(file: string): Outcome {
  let proposed: ProposedMandate;
  try {
    proposed = parseMandateYaml(read(`fixtures/overgrants/${file}`));
  } catch {
    // The schema refused it. That is still a rejection, and the strongest
    // kind: the mandate never reached the validator at all.
    return { rejected: true, codes: ["schema"] };
  }
  const authority = AUTHORITY[proposed.requestedBy] ?? { login: "unknown", level: "none" };
  const result = validate(proposed, { ceiling, authority });
  if (result.ok) return { rejected: false };
  return { rejected: true, codes: result.rejections.map((r) => r.code) };
}

describe("seeded over-grant suite — Phase 1 exit criterion", () => {
  it("has an index entry for every fixture on disk, and vice versa", () => {
    const onDisk = readdirSync(root("fixtures/overgrants")).filter((f) => f.endsWith(".yaml"));
    expect(new Set(cases.map((c) => c.file))).toEqual(new Set(onDisk));
  });

  it("covers every rejection reason the validator can produce", () => {
    expect(new Set(cases.map((c) => c.expect))).toEqual(
      new Set(["schema", "lint", "not-contained", "no-ceiling-rule", "user-authority"]),
    );
  });

  for (const c of cases) {
    it(`rejects ${c.file} with ${c.expect}`, () => {
      const outcome = run(c.file);
      expect(outcome.rejected, `${c.file} was ACCEPTED`).toBe(true);
      if (!outcome.rejected) return;
      expect(outcome.codes, `${c.file} rejected, but not for the stated reason`).toContain(c.expect);
    });
  }

  // The headline assertion. The PRD's Phase 1 exit is "the validator rejects
  // 100% of a seeded suite of over-grants".
  it("rejects 100% of the suite", () => {
    const accepted = cases.filter((c) => !run(c.file).rejected).map((c) => c.file);
    expect(accepted).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
});
