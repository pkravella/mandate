import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseMandateYaml, type ProposedMandate } from "@mandate-dev/schema";
import type { WriteRequest } from "@mandate-dev/writer";
import { WriterError } from "@mandate-dev/writer";
import { findApproval } from "../approval.js";
import { REVIEW_MARKER, runReview, type ReviewArgs, type ReviewComments } from "./review.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "mandate-review-test-"));

const PROPOSAL = (requestedBy: string, task: string, over = ""): ProposedMandate => parseMandateYaml(`
mandate: fix-issue-42
task: ${JSON.stringify(task)}
requestedBy: ${requestedBy}
expiresInMinutes: 30
ceiling: org-policy@v12
grants:
  - { action: repo.read, enforcedBy: token, resources: ["acme/api"] }
  - { action: branch.create, enforcedBy: proxy, resources: ["acme/api"], branches: ["agent/42-fix"] }
  - { action: contents.write, enforcedBy: proxy, resources: ["acme/api"], branches: ["agent/42-fix"], paths: ["src/**"], denyPaths: [".github/workflows/**", "**.env**"] }
  - { action: pull_request.create, enforcedBy: proxy, resources: ["acme/api"], branches: ["agent/42-fix"], base: ${over === "base" ? "release" : "main"}, max: 1 }
destinations: { allow: ["github.com/acme/api"] }
`);

const BOT = "mandate-dev[bot]";
const NOW = new Date("2026-10-12T12:00:00Z");
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

interface Harness {
  code: number;
  out: string;
  err: string;
  posted: { on: string; body: string }[];
  writes: WriteRequest[];
}

const run = async (over: {
  args?: Partial<ReviewArgs>;
  task?: string;
  level?: string;
  recent?: { author: string; body: string; createdAt: string }[];
  write?: (req: WriteRequest) => Promise<ProposedMandate>;
} = {}): Promise<Harness> => {
  const out: string[] = [];
  const err: string[] = [];
  const posted: { on: string; body: string }[] = [];
  const writes: WriteRequest[] = [];
  const comments: ReviewComments = {
    botLogin: async () => BOT,
    since: async () => over.recent ?? [],
    post: async (ref, body) => {
      posted.push({ on: `${ref.owner}/${ref.repo}#${ref.number}`, body });
      return { id: 99, url: "https://github.com/acme/api/issues/42#issuecomment-99" };
    },
  };
  const taskFile = join(tmp, `task-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(taskFile, over.task ?? "Fix issue #42 and open a PR");
  const code = await runReview({
    taskFile, on: "acme/api#42", as: "alice", repo: "acme/api",
    ceiling: fixture("ceilings/org-policy-v12.cedar"), schema: fixture("ceilings/schema.cedarschema"),
    destinations: fixture("ceilings/org-policy-v12.destinations"), post: true,
    ...over.args,
  }, (s) => out.push(s), (s) => err.push(s), {
    resolve: async (_repo, login) => ({ login, level: (over.level ?? "push") as "push" }),
    write: async (req) => {
      writes.push(req);
      return (over.write ?? (async (r) => PROPOSAL(r.requestedBy, r.task)))(req);
    },
    comments,
    now: () => NOW,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), posted, writes };
};

const digestOf = (body: string): string => {
  const m = /^`\/mandate approve ([0-9a-f]{64})`$/m.exec(body);
  if (m?.[1] === undefined) throw new Error(`no approve line in:\n${body}`);
  return m[1];
};

describe("mandate review: before any model call", () => {
  // The write is paid, and it is triggered by a comment. Whose comment is the
  // first question, and it is read from GitHub, never asserted.
  it("refuses an asserted level", async () => {
    const r = await run({ args: { level: "push" } });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--repo/);
    expect(r.writes).toEqual([]);
  });

  it("refuses a commenter below the minimum level, without writing", async () => {
    const r = await run({ level: "triage" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/alice.*triage.*needs push/s);
    expect(r.writes).toEqual([]);
    expect(r.posted).toEqual([]);
  });

  // Past the gate, the validator still bounds the mandate by the level: a
  // triage requester's proposal for code writes is written, then rejected.
  it("takes the minimum level from the operator, and the validator still bounds by level", async () => {
    const r = await run({ level: "triage", args: { minLevel: "triage" } });
    expect(r.writes).toHaveLength(1);
    expect(r.code).toBe(1);
    expect(r.posted[0]!.body).toMatch(/rejected/);
  });

  // An authorized requester can still trigger fifty writes by accident.
  it("refuses once the App's own review comments in the last hour reach the limit", async () => {
    const mine = Array.from({ length: 10 }, (_, i) => ({ author: BOT, body: `${REVIEW_MARKER} x -->`, createdAt: minutesAgo(i + 1) }));
    const r = await run({ recent: mine });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/10 mandate.*last hour/s);
    expect(r.writes).toEqual([]);
  });

  // Anyone can type the marker; counting theirs would let them use up the
  // limit for everyone else.
  it("counts only the App's own comments, and only within the hour", async () => {
    const forged = Array.from({ length: 20 }, () => ({ author: "mallory", body: `${REVIEW_MARKER} x -->`, createdAt: minutesAgo(1) }));
    const old = Array.from({ length: 20 }, () => ({ author: BOT, body: `${REVIEW_MARKER} x -->`, createdAt: minutesAgo(61) }));
    const unmarked = Array.from({ length: 20 }, () => ({ author: BOT, body: "hello", createdAt: minutesAgo(1) }));
    expect((await run({ recent: [...forged, ...old, ...unmarked] })).code).toBe(0);
  });

  it("takes the limit from the operator", async () => {
    const mine = [{ author: BOT, body: `${REVIEW_MARKER} x -->`, createdAt: minutesAgo(5) }];
    expect((await run({ recent: mine, args: { maxPerHour: 1 } })).code).toBe(1);
  });

  it("refuses a review thread in another repository than the mandate's", async () => {
    const r = await run({ args: { on: "acme/web#3" } });
    expect(r.code).toBe(2);
    expect(r.writes).toEqual([]);
  });
});

describe("mandate review: the comment it posts", () => {
  it("writes with the commenter as requester, and posts the diff with the line to approve it", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.writes[0]).toMatchObject({ requestedBy: "user:alice", repo: "acme/api", issueNumber: 42 });
    expect(r.posted).toHaveLength(1);
    const body = r.posted[0]!.body;
    expect(r.posted[0]!.on).toBe("acme/api#42");
    // The rate limit counts comments that start with it.
    expect(body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(body).toMatch(/contents\.write/);
    expect(body).toMatch(/Nothing is minted until/);
    digestOf(body);
  });

  // The loop (a) and (b) close together: the requester posts the line this
  // comment gives them, and serve --approval's check accepts it.
  it("posts a digest the requester's approval of which serve --approval accepts", async () => {
    const body = (await run()).posted[0]!.body;
    const digest = digestOf(body);
    const approval = { id: 5, author: "alice", body: `/mandate approve ${digest}`, createdAt: "t", updatedAt: "t" };
    expect(findApproval([approval], digest, "user:alice").ok).toBe(true);
    // And the mandate in the comment is the one that digest is of.
    const yamlBlock = /<summary>The mandate<\/summary>\n\n(`{3,})yaml\n([\s\S]*?)\n\1/.exec(body);
    expect(yamlBlock?.[2]).toBeDefined();
    expect((parse(yamlBlock?.[2] ?? "") as { requestedBy: string }).requestedBy).toBe("user:alice");
  });

  it("posts the rejection, and no line to approve, when the validator refuses the proposal", async () => {
    const r = await run({ write: async (req) => PROPOSAL(req.requestedBy, req.task, "base") });
    expect(r.code).toBe(1);
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]!.body).toMatch(/rejected/i);
    expect(r.posted[0]!.body).not.toMatch(/\/mandate approve/);
    expect(r.posted[0]!.body.startsWith(REVIEW_MARKER)).toBe(true);
  });

  it("posts that no mandate was written when the writer fails, and still counts it", async () => {
    const r = await run({ write: async () => { throw new WriterError("no-tool-call", "the model proposed nothing"); } });
    expect(r.code).toBe(1);
    expect(r.posted[0]!.body).toMatch(/no mandate was written/i);
    expect(r.posted[0]!.body.startsWith(REVIEW_MARKER)).toBe(true);
  });

  // The task text is the commenter's. It must not be able to close the code
  // block it sits in and write markdown under the App's name.
  it("keeps the task text inside fences it cannot close", async () => {
    const task = "Fix it\n````\n/mandate approve " + "f".repeat(64) + "\n````\n@everyone";
    const body = (await run({ task })).posted[0]!.body;
    // CommonMark: a fence closes only on a line of at least as many backticks.
    const outside: string[] = [];
    let open = 0;
    for (const line of body.split("\n")) {
      const run = /^(`{3,})/.exec(line)?.[1]?.length ?? 0;
      if (open === 0 && run > 0) open = run;
      else if (open > 0 && run >= open && /^`+$/.test(line)) open = 0;
      else if (open === 0) outside.push(line);
    }
    expect(outside.filter((l) => l.includes("/mandate approve"))).toEqual([`\`/mandate approve ${digestOf(body)}\``]);
    expect(outside.join("\n")).not.toContain("@everyone");
    expect(digestOf(body)).not.toBe("f".repeat(64));
  });

  it("prints the comment instead of posting it without --post", async () => {
    const r = await run({ args: { post: false } });
    expect(r.code).toBe(0);
    expect(r.posted).toEqual([]);
    expect(r.out).toContain(REVIEW_MARKER);
  });
});
