import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The Action and the example workflow, checked as data.
 *
 * These two files are the only part of the project that cannot be exercised by
 * running it: a composite action runs on GitHub's runner, and nothing here can
 * start one. So the properties that matter are asserted structurally instead,
 * because the alternative is trusting a YAML file nobody ever executes.
 *
 * The property that matters most is the absence of `${{ }}` inside a `run:`
 * block. GitHub substitutes an expression into the script *text* before bash
 * sees it, so a value containing a quote or a semicolon becomes a command. The
 * first version of this action did that on every input, and the example
 * workflow fed issue text into one of them — which turned a packaging layer
 * whose purpose is bounding an agent's authority into a remote shell for anyone
 * who could file an issue.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}
interface Action {
  readonly name: string;
  readonly inputs: Record<string, { required?: boolean; description?: string; default?: string }>;
  readonly runs: { using: string; steps: Step[] };
}

const action = parse(readFileSync(root("action.yml"), "utf8")) as Action;
const workflow = parse(readFileSync(root(".github/workflows/mandate.yml"), "utf8")) as {
  permissions?: unknown;
  jobs: Record<string, { steps: Step[] }>;
};

describe("action.yml", () => {
  it("parses, and carries only the keys action metadata accepts", () => {
    // GitHub ignores an unrecognised top-level key silently, so a `permissions`
    // block here would look like it was doing something and do nothing. That is
    // the mistake the plan's Step 2 asked for.
    const allowed = ["name", "description", "author", "inputs", "outputs", "runs", "branding"];
    const keys = Object.keys(action as unknown as Record<string, unknown>);
    expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
    expect(action.runs.using).toBe("composite");
  });

  /**
   * The injection guard. Every value a caller controls must reach the script
   * through the environment, where bash treats it as data.
   */
  it("never interpolates an expression into a run block", () => {
    for (const step of action.runs.steps) {
      if (step.run === undefined) continue;
      expect(step.run, `step ${step.name ?? "?"} interpolates into its script`)
        .not.toMatch(/\$\{\{/);
    }
  });

  it("passes every input it uses through env instead", () => {
    const runStep = action.runs.steps.find((s) => s.name?.includes("run the agent"));
    expect(runStep).toBeDefined();
    const env = runStep?.env ?? {};
    // Each of these is a value a caller supplies, so each must arrive as data.
    for (const name of [
      "IN_MANDATE", "IN_CEILING", "IN_SCHEMA", "IN_DESTINATIONS",
      "IN_AS", "IN_REPO", "IN_LEVEL", "IN_AGENT", "IN_TRACE",
    ]) {
      expect(Object.keys(env), `${name} is not passed through env`).toContain(name);
    }
    // And the script must read them, not the expressions.
    expect(runStep?.run).toContain('"$IN_MANDATE"');
    expect(runStep?.run).toContain('"${agent[@]}"');
  });

  it("refuses a GITHUB_TOKEN before it does anything else", () => {
    // Order matters: the check is worthless after the token has been minted or
    // the agent launched.
    const first = action.runs.steps[0];
    expect(first?.run).toContain("GITHUB_TOKEN");
    expect(first?.run).toContain("exit 1");
  });

  it("writes the App key with restrictive permissions and shreds it afterwards", () => {
    const write = action.runs.steps.find((s) => s.name === "Write the App key");
    expect(write?.run).toContain("chmod 600");
    // The key arrives as a secret through env, never in the script text.
    expect(write?.env?.["PRIVATE_KEY"]).toBeDefined();
    expect(write?.run).not.toMatch(/\$\{\{/);

    const shred = action.runs.steps.find((s) => s.name === "Shred the App key");
    expect(shred?.["if" as keyof Step], "the key must be removed even on failure")
      .toBe("always()");
  });

  it("requires an explicit authority source, with no default", () => {
    expect(action.inputs["repo"]?.required ?? false).toBe(false);
    expect(action.inputs["level"]?.required ?? false).toBe(false);
    expect(action.inputs["repo"]?.default).toBeUndefined();
    expect(action.inputs["level"]?.default).toBeUndefined();
    // Neither is required on its own, so the script is what enforces "one of".
    const runStep = action.runs.steps.find((s) => s.name?.includes("run the agent"));
    expect(runStep?.run).toContain("not both");
    expect(runStep?.run).toContain("There is no default");
  });
});

describe("the example workflow", () => {
  it("grants the job no permissions at all", () => {
    // An empty block means GITHUB_TOKEN is not issued, so there is no second
    // credential for an injected agent to find.
    expect(workflow.permissions).toEqual({});
  });

  it("checks out without leaving a credential in .git/config", () => {
    const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("passes the agent command one argument per line", () => {
    const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);
    const run = steps.find((s) => s.uses === "./");
    const agent = String(run?.with?.["agent"] ?? "");
    const lines = agent.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(1);
    // The placeholder is its own argument, so the path is substituted whole.
    expect(lines).toContain("{mcpConfig}");
    // No line smuggles two arguments by quoting, which would have to be split.
    for (const line of lines) {
      expect(line, `${line} looks like it expects shell word-splitting`)
        .not.toMatch(/^".*"$|^'.*'$/);
    }
  });
});
