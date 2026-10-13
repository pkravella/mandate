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
const workflowText = readFileSync(root("examples/workflows/leastpilot-review.yml"), "utf8");
const workflow = parse(workflowText) as { on: unknown; permissions?: unknown; jobs: Record<string, Job> };

const PINNED = /@[0-9a-f]{40}$/;
const noInterpolation = (steps: readonly Step[], where: string): void => {
  for (const s of steps) {
    if (s.run === undefined) continue;
    expect(s.run, `${where}: step ${s.name ?? "?"} interpolates into its script`).not.toMatch(/\$\{\{/);
  }
};

/**
 * Both Actions run the published CLI (Task 9.1 step 5). They used to build it
 * from source with pnpm's frozen lockfile, which pinned every dependency. An
 * exact `@leastpilot/cli@x.y.z` alone would not: its third-party dependencies
 * are ranges, resolved fresh on every run. So the Actions install from a
 * committed npm lockfile with `npm ci`, which checks every package against its
 * integrity hash, and then check registry signatures and provenance.
 */
const installScript = existsSync(root("scripts/install-action-cli.sh"))
  ? readFileSync(root("scripts/install-action-cli.sh"), "utf8") : "";
const pin = existsSync(root("action-install/package.json"))
  ? JSON.parse(readFileSync(root("action-install/package.json"), "utf8")) as { dependencies?: Record<string, string> }
  : {};
const lock = existsSync(root("action-install/package-lock.json"))
  ? JSON.parse(readFileSync(root("action-install/package-lock.json"), "utf8")) as {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
  }
  : {};

const installsThenRuns = (steps: readonly Step[], runName: (s: Step) => boolean, where: string): void => {
  const node = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
  const install = steps.findIndex((s) => s.name === "Install LeastPilot");
  const run = steps.findIndex(runName);
  expect(steps[node]?.uses, where).toMatch(PINNED);
  expect(install, where).toBeGreaterThan(node);
  expect(run, where).toBeGreaterThan(install);
  expect(steps[install]?.id, where).toBe("cli");
  expect(steps[install]?.run, where).toMatch(/^bash "\$ACTION_(PATH|ROOT)\/scripts\/install-action-cli\.sh"$/);
  expect(steps[run]?.env?.["LEASTPILOT_BIN"], where).toBe("${{ steps.cli.outputs.bin }}");
  expect(steps[run]?.run, where).toContain('"$LEASTPILOT_BIN"');
  // Nothing runs a CLI built from the Action's checkout any more.
  for (const s of steps) expect(s.run ?? "", where).not.toMatch(/packages\/cli\/dist|build-action/);
};

describe("both Actions run the published CLI", () => {
  it("action.yml installs it, then runs it", () => {
    installsThenRuns(action.runs.steps, (s) => s.name?.includes("run the agent") ?? false, "action.yml");
  });

  it("review/action.yml installs it, then runs it", () => {
    installsThenRuns(review.runs.steps, (s) => s.name?.includes("post the review") ?? false, "review/action.yml");
  });

  it("never interpolates into a run block", () => {
    noInterpolation(action.runs.steps, "action.yml");
  });
});

describe("scripts/install-action-cli.sh", () => {
  it("installs from the lockfile, runs no install scripts, and checks signatures", () => {
    expect(installScript).toContain("set -euo pipefail");
    expect(installScript).toMatch(/npm ci [^\n]*--ignore-scripts/);
    expect(installScript).toContain("npm audit signatures");
    // `npm install` would re-resolve the ranges the lockfile exists to pin.
    expect(installScript).not.toMatch(/npm (install|i) /);
  });

  // A caller's NPM_CONFIG_REGISTRY or .npmrc would otherwise redirect every
  // fetch, and the signature check would ask that host for keys (review of
  // step 5). Command-line flags outrank both, so the trust root is npmjs.
  it("pins the registry on both npm commands, whatever the caller configured", () => {
    const pinned = "--registry=https://registry.npmjs.org/ --replace-registry-host=never";
    expect(installScript).toMatch(new RegExp(`npm ci [^\\n]*${pinned}`));
    expect(installScript).toMatch(new RegExp(`npm audit signatures [^\\n]*--registry=https://registry\\.npmjs\\.org/`));
  });
});

describe("action-install/, what the Actions install", () => {
  const cli = pin.dependencies?.["@leastpilot/cli"];

  it("depends on the CLI alone, at an exact version", () => {
    expect(Object.keys(pin.dependencies ?? {})).toEqual(["@leastpilot/cli"]);
    expect(cli).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("locks that version, and every LeastPilot package at it", () => {
    expect(lock.lockfileVersion).toBe(3);
    const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k.startsWith("node_modules/@leastpilot/"));
    expect(entries.map(([k]) => k)).toContain("node_modules/@leastpilot/cli");
    for (const [k, v] of entries) expect(v.version, k).toBe(cli);
  });

  // npm ci checks each tarball against this hash; an entry without one, or
  // from anywhere but the registry, is a package nothing checks.
  it("pins every package by integrity, from the npm registry", () => {
    const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k !== "");
    expect(entries.length).toBeGreaterThan(10);
    for (const [k, v] of entries) {
      expect(v.link, k).toBeUndefined();
      expect(v.resolved, k).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(v.integrity, k).toMatch(/^sha512-/);
    }
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

  it("posts a review with the task read from a file", () => {
    const post = steps.findIndex((s) => s.name?.includes("post the review"));
    expect(post).toBeGreaterThan(-1);
    const run = steps[post];
    expect(Object.keys(run?.env ?? {})).toEqual(expect.arrayContaining(["IN_TASK", "IN_ON", "IN_AS", "IN_REPO", "ANTHROPIC_API_KEY"]));
    expect(run?.run).toContain('printf \'%s\' "${IN_TASK#/leastpilot }" >');
    expect(run?.run).toMatch(/review[\s\S]*--task-file[\s\S]*--post/);
  });
});

describe("examples/workflows/leastpilot-review.yml", () => {
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

  // A commenter with no tie to the repository never starts a job: GitHub keeps
  // one pending job per concurrency group, so a stranger's comments could
  // cancel a requester's queued review (found in review). The level check in
  // the CLI is still the gate; this keeps strangers off the runner.
  const ASSOCIATED = "contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association)";

  it("reviews a /leastpilot request from a person tied to the repository, never an approval or a bot", () => {
    expect(reviewJob?.if).toContain("github.event.comment.user.type == 'User'");
    expect(reviewJob?.if).toContain(ASSOCIATED);
    expect(reviewJob?.if).toContain("startsWith(github.event.comment.body, '/leastpilot ')");
    // No trailing space: a bare "/leastpilot approve" is a mistyped approval, not
    // a task to pay a writer for.
    expect(reviewJob?.if).toContain("!startsWith(github.event.comment.body, '/leastpilot approve')");
  });

  it("pins LeastPilot to a commit the copier must fill in, and the agent to a version", () => {
    const uses = Object.values(workflow.jobs).flatMap((j) => j.steps).map((s) => s.uses ?? "")
      .filter((u) => u.startsWith("pkravella/mandate"));
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(u).toMatch(/@(?:[0-9a-f]{40}|PIN-TO-A-MANDATE-COMMIT-SHA)$/);
    expect(workflowText).toMatch(/npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
  });

  // The rate limit is read-then-write (7.1b review): two reviews at once could
  // both pass it. One at a time per repository, queued, not cancelled.
  it("runs reviews one at a time per repository", () => {
    expect(reviewJob?.concurrency?.group).toContain("${{ github.repository }}");
    expect(reviewJob?.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("runs an approved mandate with the approval it must check", () => {
    expect(runJob?.if).toContain("github.event.comment.user.type == 'User'");
    expect(runJob?.if).toContain(ASSOCIATED);
    expect(runJob?.if).toContain("startsWith(github.event.comment.body, '/leastpilot approve')");
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

// The run step's script, executed under bash with a stand-in `leastpilot`
// that records its arguments: the branches are behaviour, not strings to grep.
describe("action.yml's run step, executed", () => {
  const script = action.runs.steps.find((s) => s.name?.includes("run the agent"))?.run ?? "";

  const exec = (env: Record<string, string>): { code: number; calls: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-action-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls");
    writeFileSync(join(bin, "leastpilot"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
    chmodSync(join(bin, "leastpilot"), 0o755);
    writeFileSync(join(dir, "step.sh"), script);
    let code = 0;
    try {
      execFileSync("bash", [join(dir, "step.sh")], {
        env: {
          PATH: process.env["PATH"] ?? "", LEASTPILOT_BIN: join(bin, "leastpilot"), RUNNER_TEMP: dir,
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
