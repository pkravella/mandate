import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalDigest, parseMandateYaml, type Mandate } from "@mandate-dev/schema";
import { extractReviewedMandate } from "./reviewFetch.js";
import { REVIEW_MARKER } from "./commands/review.js";

const BOT = "mandate-dev[bot]";
const D = "a".repeat(64);
const YAML = `mandate: fix-issue-42
task: Fix issue 42
requestedBy: user:alice
expiresInMinutes: 30
ceiling: org-policy@v12
grants:
  - action: repo.read
    enforcedBy: token
    resources:
      - acme/api
destinations:
  allow: []
`;
const body = (digest: string, yaml = YAML, fence = "```") => [
  `${REVIEW_MARKER} digest=${digest} -->`, "**A mandate for @alice**", "", `${fence}text`, "diff", fence, "",
  `\`/mandate approve ${digest}\``, "", "<details><summary>The mandate</summary>", "",
  `${fence}yaml`, yaml.trimEnd(), fence, "", "</details>",
].join("\n");
const c = (author: string, b: string, id = 1) => ({ id, author, body: b, createdAt: "t", updatedAt: "t" });

describe("extractReviewedMandate", () => {
  it("returns the YAML from the App's review comment carrying that digest", () => {
    const r = extractReviewedMandate([c(BOT, body("b".repeat(64)), 1), c(BOT, body(D), 2)], BOT, D);
    expect(r).toEqual({ ok: true, yaml: YAML.trimEnd(), comment: 2 });
  });

  // Anyone can post a comment that looks like the App's. The digest binds the
  // content anyway, but the mandate is only ever taken from the App's own.
  it("ignores a lookalike comment by anyone else", () => {
    const r = extractReviewedMandate([c("mallory", body(D))], BOT, D);
    expect(r).toMatchObject({ ok: false });
  });

  it("reads a fence longer than three backticks", () => {
    const r = extractReviewedMandate([c(BOT, body(D, YAML, "`````"))], BOT, D);
    expect(r).toMatchObject({ ok: true, yaml: YAML.trimEnd() });
  });

  it("refuses an unknown digest, naming it", () => {
    const r = extractReviewedMandate([c(BOT, body("b".repeat(64)))], BOT, D);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain(D);
  });

  it("matches the App's login without case", () => {
    expect(extractReviewedMandate([c("Mandate-Dev[bot]", body(D))], BOT, D).ok).toBe(true);
  });

  // The point of the round trip: what the run step writes out is a mandate
  // whose approval digest, under the same ceiling and requester, is the one
  // the requester approved.
  it("gives back YAML that parses to the mandate the digest was taken of", () => {
    const m = parseMandateYaml(YAML) as Mandate;
    const digest = approvalDigest(m, "c".repeat(64), m.requestedBy);
    const r = extractReviewedMandate([c(BOT, body(digest))], BOT, digest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(approvalDigest(parseMandateYaml(r.yaml) as Mandate, "c".repeat(64), "user:alice")).toBe(digest);
  });
});

describe("runReviewFetch", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-reviewed-"));
  const deps = (bodyDigest = D) => ({
    comments: async () => [c(BOT, body(bodyDigest))],
    botLogin: async () => BOT,
  });
  const go = async (over: Partial<{ on: string; digest: string; out: string; taskOut: string }>, d = deps()) => {
    const { runReviewFetch } = await import("./reviewFetch.js");
    const log: string[] = [];
    const code = await runReviewFetch({ on: "acme/api#42", digest: D, out: join(dir, `${Math.random()}.yaml`), ...over }, (s) => log.push(s), d);
    return { code, log: log.join("\n") };
  };

  it("writes the reviewed mandate and exits 0", async () => {
    const out = join(dir, "m.yaml");
    expect((await go({ out })).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`${YAML.trimEnd()}\n`);
  });

  // The agent is told to read its task from a file, so the task never
  // becomes an argv line built from comment text.
  it("writes the mandate's task to --task-out", async () => {
    const out = join(dir, "t.yaml");
    const taskOut = join(dir, "task.md");
    expect((await go({ out, taskOut })).code).toBe(0);
    expect(readFileSync(taskOut, "utf8")).toBe("Fix issue 42\n");
  });

  it("exits 1 when no review carries that digest, writing nothing", async () => {
    const out = join(dir, "none.yaml");
    expect((await go({ out }, deps("b".repeat(64)))).code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it("never overwrites a file", async () => {
    const out = join(dir, "taken.yaml");
    writeFileSync(out, "mine\n");
    expect((await go({ out })).code).toBe(2);
    expect(readFileSync(out, "utf8")).toBe("mine\n");
  });

  it.each([{ on: "acme/api" }, { digest: "abc" }])("exits 2 on bad input %o", async (over) => {
    expect((await go(over)).code).toBe(2);
  });

  it("exits 2 without a way to read GitHub", async () => {
    expect((await go({}, { comments: undefined, botLogin: undefined } as never)).code).toBe(2);
  });
});
