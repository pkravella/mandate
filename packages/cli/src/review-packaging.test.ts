import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * R5's workflow pieces, checked as data like packaging.test.ts: the main
 * Action's new inputs and self-build, the review Action, and the example
 * workflow that runs them on comments. Nothing here can start a runner, so
 * the properties that matter are asserted on the files.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}
interface Action {
  readonly inputs: Record<string, { required?: boolean; default?: string }>;
  readonly runs: { using: string; steps: Step[] };
}
interface Job {
  readonly if?: string;
  readonly concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  readonly steps: Step[];
}

const action = parse(readFileSync(root("action.yml"), "utf8")) as Action;
const review = parse(readFileSync(root("review/action.yml"), "utf8")) as Action;
const workflowText = readFileSync(root("examples/workflows/mandate-review.yml"), "utf8");
const workflow = parse(workflowText) as { on: unknown; permissions?: unknown; jobs: Record<string, Job> };
const buildScript = readFileSync(root("scripts/build-action.sh"), "utf8");

const PINNED = /@[0-9a-f]{40}$/;
const noInterpolation = (steps: readonly Step[], where: string): void => {
  for (const s of steps) {
    if (s.run === undefined) continue;
    expect(s.run, `${where}: step ${s.name ?? "?"} interpolates into its script`).not.toMatch(/\$\{\{/);
  }
};

describe("action.yml, used from another repository", () => {
  // dist/ is never committed, so `uses: pkravella/mandate@<sha>` from any other
  // repository had no CLI to run. The Action builds itself.
  it("sets up Node from a pinned action and builds Mandate before running it", () => {
    const steps = action.runs.steps;
    const node = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
    const build = steps.findIndex((s) => s.name === "Build Mandate");
    const run = steps.findIndex((s) => s.name?.includes("run the agent"));
    expect(steps[node]?.uses).toMatch(PINNED);
    expect(node).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(node);
    expect(run).toBeGreaterThan(build);
    expect(steps[build]?.run).toContain('"$ACTION_PATH/scripts/build-action.sh"');
    expect(steps[build]?.env?.["ACTION_PATH"]).toBe("${{ github.action_path }}");
  });

  it("builds from the lockfile, and not again when the CLI is already built", () => {
    expect(buildScript).toContain("--frozen-lockfile");
    expect(buildScript).toMatch(/packages\/cli\/dist\/index\.js/);
    expect(buildScript).toContain("set -euo pipefail");
  });

  it("still never interpolates into a run block", () => {
    noInterpolation(action.runs.steps, "action.yml");
  });
});

describe("action.yml, running an approved mandate", () => {
  const runStep = action.runs.steps.find((s) => s.name?.includes("run the agent"));

  it("takes an approval and a reviewed mandate's digest, both optional, through env", () => {
    expect(action.inputs["approval"]?.required ?? false).toBe(false);
    expect(action.inputs["approved-digest"]?.required ?? false).toBe(false);
    expect(action.inputs["mandate"]?.required ?? false).toBe(false);
    expect(Object.keys(runStep?.env ?? {})).toEqual(expect.arrayContaining(["IN_APPROVAL", "IN_APPROVED_DIGEST"]));
    expect(runStep?.run).toContain('--approval "$IN_APPROVAL"');
  });

  it("writes the reviewed mandate and its task out, and refuses a digest without an approval to check it", () => {
    expect(runStep?.run).toMatch(/reviewed[\s\S]*--digest "\$IN_APPROVED_DIGEST"[\s\S]*--task-out/);
    expect(runStep?.run).toContain("approved-digest needs approval");
    expect(runStep?.run).toContain("Pass mandate or approved-digest, not both");
  });
});

describe("review/action.yml", () => {
  const steps = review.runs.steps;

  it("is a composite action that never interpolates into a run block", () => {
    expect(review.runs.using).toBe("composite");
    noInterpolation(steps, "review/action.yml");
  });

  it("refuses a GITHUB_TOKEN first, and handles the App key as the main Action does", () => {
    expect(steps[0]?.run).toContain("GITHUB_TOKEN");
    expect(steps[0]?.run).toContain("exit 1");
    const write = steps.find((s) => s.name === "Write the App key");
    expect(write?.run).toContain("chmod 600");
    const shred = steps.find((s) => s.name === "Shred the App key");
    expect(shred?.if).toBe("always()");
  });

  it("builds Mandate, then posts a review with the task read from a file", () => {
    const build = steps.findIndex((s) => s.name === "Build Mandate");
    const post = steps.findIndex((s) => s.name?.includes("post the review"));
    expect(build).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(build);
    const run = steps[post];
    expect(Object.keys(run?.env ?? {})).toEqual(expect.arrayContaining(["IN_TASK", "IN_ON", "IN_AS", "IN_REPO", "ANTHROPIC_API_KEY"]));
    expect(run?.run).toContain('printf \'%s\' "${IN_TASK#/mandate }" >');
    expect(run?.run).toMatch(/review[\s\S]*--task-file[\s\S]*--post/);
  });
});

describe("examples/workflows/mandate-review.yml", () => {
  const reviewJob = Object.values(workflow.jobs).find((j) => j.steps.some((s) => s.uses?.includes("/review@") || s.uses === "./review"));
  const runJob = Object.values(workflow.jobs).find((j) => j.steps.some((s) => s.with?.["approved-digest"] !== undefined));

  // Found by the live run: with permissions: {} there is no token for
  // actions/checkout, and a private repository refuses the clone. Each job gets
  // contents: read and nothing else; checkout keeps it out of .git/config and
  // no step puts it in the environment the Actions check.
  it("runs on new comments only, with contents: read for checkout and nothing more", () => {
    expect(workflow.on).toEqual({ issue_comment: { types: ["created"] } });
    expect(workflow.permissions).toEqual({});
    for (const job of Object.values(workflow.jobs)) {
      expect((job as { permissions?: unknown }).permissions).toEqual({ contents: "read" });
    }
  });

  it("reviews a /mandate request from a person, never an approval or a bot", () => {
    expect(reviewJob?.if).toContain("github.event.comment.user.type == 'User'");
    expect(reviewJob?.if).toContain("startsWith(github.event.comment.body, '/mandate ')");
    expect(reviewJob?.if).toContain("!startsWith(github.event.comment.body, '/mandate approve ')");
  });

  // The rate limit is read-then-write (7.1b review): two reviews at once could
  // both pass it. One at a time per repository, queued, not cancelled.
  it("runs reviews one at a time per repository", () => {
    expect(reviewJob?.concurrency?.group).toContain("${{ github.repository }}");
    expect(reviewJob?.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("runs an approved mandate with the approval it must check", () => {
    expect(runJob?.if).toContain("github.event.comment.user.type == 'User'");
    expect(runJob?.if).toContain("startsWith(github.event.comment.body, '/mandate approve ')");
    const run = runJob?.steps.find((s) => s.with?.["approved-digest"] !== undefined);
    expect(String(run?.with?.["approval"])).toBe("${{ github.repository }}#${{ github.event.issue.number }}");
    expect(String(run?.with?.["as"])).toBe("${{ github.event.comment.user.login }}");
  });

  it("checks out without credentials and never interpolates into a run block", () => {
    for (const job of Object.values(workflow.jobs)) {
      const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout"));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
      noInterpolation(job.steps, "the example workflow");
    }
  });

  // The comment body is the requester's text. It reaches the review Action's
  // `task` (which reads it from env) and a step's env, and nothing else -- in
  // particular never the run Action's inputs, whose `agent` lines are argv.
  it("passes the comment body only to the review's task and through env", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const s of job.steps) {
        for (const [k, v] of Object.entries(s.with ?? {})) {
          if (k === "task" && job === reviewJob) continue;
          expect(String(v), `${s.name ?? s.uses ?? "?"}.with.${k}`).not.toContain("comment.body");
        }
      }
    }
    const reviewStep = reviewJob?.steps.find((s) => s.with?.["task"] !== undefined);
    expect(String(reviewStep?.with?.["task"])).toBe("${{ github.event.comment.body }}");
    expect(workflowText).toContain("COMMENT_BODY: ${{ github.event.comment.body }}");
  });
});

// The run step's script, executed under bash with a stand-in `node` that
// records its arguments: the branches are behaviour, not strings to grep.
describe("action.yml's run step, executed", () => {
  const script = action.runs.steps.find((s) => s.name?.includes("run the agent"))?.run ?? "";

  const exec = (env: Record<string, string>): { code: number; calls: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-action-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls");
    writeFileSync(join(bin, "node"), `#!/usr/bin/env bash\nshift\nprintf '%s\\n' "$*" >> "${log}"\n`);
    chmodSync(join(bin, "node"), 0o755);
    writeFileSync(join(dir, "step.sh"), script);
    let code = 0;
    try {
      execFileSync("bash", [join(dir, "step.sh")], {
        env: {
          PATH: `${bin}:${process.env["PATH"] ?? ""}`, ACTION_PATH: "/action", RUNNER_TEMP: dir,
          GITHUB_WORKSPACE: dir, GITHUB_OUTPUT: join(dir, "out"),
          IN_MANDATE: "", IN_APPROVED_DIGEST: "", IN_APPROVAL: "", IN_REPO: "acme/api", IN_LEVEL: "",
          IN_AGENT: "claude\n{mcpConfig}", IN_TRACE: "t.jsonl", IN_AS: "alice", IN_CEILING: "c",
          IN_SCHEMA: "s", IN_DESTINATIONS: "d", ...env,
        },
        stdio: "pipe",
      });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    return { code, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  const D = "a".repeat(64);

  it("runs a committed mandate file, with no approval unless one is given", () => {
    const r = exec({ IN_MANDATE: "m.yaml" });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^run --mandate m\.yaml /);
    expect(r.calls[0]).not.toContain("--approval");
  });

  it("fetches the reviewed mandate and runs it under its approval", () => {
    const r = exec({ IN_APPROVED_DIGEST: D, IN_APPROVAL: "acme/api#42" });
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatch(new RegExp(`^reviewed --on acme/api#42 --digest ${D} --out .*mandate-approved\\.yaml --task-out .*\\.mandate-task\\.md$`));
    expect(r.calls[1]).toMatch(/^run --mandate .*mandate-approved\.yaml .*--approval acme\/api#42/);
  });

  it("refuses a digest without an approval to check, running nothing", () => {
    expect(exec({ IN_APPROVED_DIGEST: D })).toEqual({ code: 2, calls: [] });
  });

  it("refuses both a file and a digest, and neither, running nothing", () => {
    expect(exec({ IN_MANDATE: "m.yaml", IN_APPROVED_DIGEST: D, IN_APPROVAL: "acme/api#42" })).toEqual({ code: 2, calls: [] });
    expect(exec({})).toEqual({ code: 2, calls: [] });
  });
});
