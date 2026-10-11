import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Ceiling, UserAuthority } from "@mandate-dev/validator";
import { validate } from "@mandate-dev/validator";
import { revokeToken, type MintDeps } from "@mandate-dev/compiler";
import {
  pauseRecord, parseJsonl,
  type ActionGraph, type Decision,
} from "@mandate-dev/proxy";
import { WriterError, writeMandate } from "@mandate-dev/writer";
import { scoreMandate, type Score } from "@mandate-dev/replay";
import type { ValidatedMandate } from "@mandate-dev/schema";
import { openSession } from "@mandate-dev/cli";
import { branchFor, taskPrompt } from "./prompt.js";
import type { BenchResult, CorpusMeta, ToolVisibility } from "./report.js";
import { compositionOf, type Corpus, type LoadedTask } from "./tasks.js";

/**
 * The mandated pass: the whole loop, per task, measured.
 *
 * The unconstrained pass is **not** re-run here. A ground-truth trace does not
 * change when a mandate changes, so it is recorded once and read from disk —
 * which is both correct and the difference between a $0.27 sweep per task and a
 * $0.90 one.
 */

// claude-opus-5-5, per million tokens. A cache write (5-minute TTL) is 1.25x
// input; a cache read is $0.20 on this model.
const IN_PER_M = 4;
const OUT_PER_M = 20;
const CACHE_WRITE_PER_M = 5;
const CACHE_READ_PER_M = 0.2;
const MAX_TURNS = 18;
/**
 * Charged against the budget before each run, so the stop is predictive.
 * Measured at $0.14–$0.27 per filtered run before caching; offering every tool
 * adds ~16k schema tokens a turn. The margin is deliberate.
 */
const ESTIMATED_COST_PER_RUN = 0.40;

type BilledUsage = Pick<
  Anthropic.Usage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
>;

/**
 * What a call cost. `input_tokens` excludes cached tokens, so the formula that
 * read only it and `output_tokens` would report a cached run as nearly free.
 */
export const costOf = (u: BilledUsage): number =>
  (u.input_tokens * IN_PER_M
    + u.output_tokens * OUT_PER_M
    + (u.cache_creation_input_tokens ?? 0) * CACHE_WRITE_PER_M
    + (u.cache_read_input_tokens ?? 0) * CACHE_READ_PER_M) / 1e6;

/**
 * Wraps the client so the writer's own token use is **measured** rather than
 * assumed. `WriteResult` carries a latency but no cost, and quoting a remembered
 * $0.03 in a published report would be a number nobody took.
 */
export const recordingUsage = (
  real: Anthropic, into: Anthropic.Usage[],
): Parameters<typeof writeMandate>[0] => ({
  messages: {
    stream: (params) => {
      const stream = real.messages.stream(params);
      return {
        finalMessage: async () => {
          const message = await stream.finalMessage();
          into.push(message.usage);
          return message;
        },
      };
    },
  },
});

export interface BenchDeps {
  readonly anthropic: Anthropic;
  readonly github: MintDeps;
  readonly installationId: number;
  readonly ceiling: Ceiling;
  readonly authority: UserAuthority;
  /** Ground-truth traces, keyed by task id. */
  readonly groundTruth: Readonly<Record<string, ActionGraph>>;
  /** Issue number per task, discovered from the seeder's marker. */
  readonly issues: Readonly<Record<string, number>>;
  /** Where a sweep's own traces go. Scratch, not a fixture. */
  readonly outDir: string;
  /**
   * Connects the upstream MCP server, given the minted token.
   *
   * Injectable only so the loop can be tested offline. It was a hardcoded
   * `docker run` here, which is the whole reason the function that produces the
   * published metrics had no test but the $1.15 live gate. Defaults to the real
   * Docker upstream, so a sweep is unchanged.
   */
  readonly upstream?: (token: string) => Promise<Client>;
  /** Stop before a task that would take the sweep past this. */
  readonly budget?: number;
  /**
   * The tool-visibility modes each task's agent runs in, under one mandate.
   * Defaults to `granted`, the product's behaviour.
   */
  readonly modes?: readonly ToolVisibility[];
  readonly log?: (s: string) => void;
}

/**
 * Whether the agent's work passes the task's acceptance command.
 *
 * Run against the agent's **branch**, not the default branch, because a mandate
 * never permits writing `main` — so the only place the work exists is the
 * branch it pushed. The seed is laid down first and the branch's version of each
 * changed file copied over it, which is what a reviewer looking at the pull
 * request would see.
 */
async function pullRequestFor(
  deps: BenchDeps, token: string, repo: string, branch: string,
  before: ReadonlySet<number>,
): Promise<number | undefined> {
  const [owner = "", name = ""] = repo.split("/");
  const res = await deps.github.asInstallation(
    "GET /repos/{owner}/{repo}/pulls", token,
    { owner, repo: name, state: "all", head: `${owner}:${branch}`, per_page: 100 },
  );
  if (res.status !== 200) return undefined;
  for (const raw of Array.isArray(res.data) ? res.data : []) {
    const pr = raw as { number?: unknown; head?: { ref?: unknown } };
    // Only one this run opened: the listing includes closed pull requests,
    // and an earlier run's on the same branch is not this run's work.
    if (pr.head?.ref === branch && typeof pr.number === "number" && !before.has(pr.number)) {
      return pr.number;
    }
  }
  return undefined;
}

/**
 * The paths a pull request changed.
 *
 * Read from the pull request rather than guessed from the task record. Grading
 * only `seed ∪ expectedPaths` silently omits a file the agent added that the
 * record did not anticipate — no run has done that yet, but the acceptance
 * command would then run against an incomplete tree and fail for a reason that
 * has nothing to do with the mandate.
 */
async function changedPaths(
  deps: BenchDeps, token: string, repo: string, pullNumber: number,
): Promise<readonly string[]> {
  const [owner = "", name = ""] = repo.split("/");
  const res = await deps.github.asInstallation(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", token,
    { owner, repo: name, pull_number: pullNumber, per_page: 100 },
  );
  if (res.status !== 200) return [];
  return (Array.isArray(res.data) ? res.data : [])
    .map((f) => (f as { filename?: unknown }).filename)
    .filter((f): f is string => typeof f === "string");
}

async function acceptancePasses(
  deps: BenchDeps, token: string, repo: string, task: LoadedTask, branch: string,
  pullNumber: number | undefined, commentsBefore: ReadonlySet<number>,
): Promise<{ passed: boolean; evidence: string }> {
  if (task.acceptance.kind === "comment") {
    const issue = deps.issues[task.id];
    if (issue === undefined) return { passed: false, evidence: "no issue for this task" };
    const res = await deps.github.asInstallation(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", token,
      {
        owner: repo.split("/")[0] ?? "", repo: repo.split("/")[1] ?? "",
        issue_number: issue, per_page: 100,
      },
    );
    const comments = Array.isArray(res.data) ? res.data : [];
    // The agent's own comment from this run: not the seeder's marker, and not
    // one an earlier run left on the same issue.
    const theirs = comments.filter((c) => {
      const { body, id } = c as { body?: unknown; id?: unknown };
      return typeof body === "string" && !body.includes("mandate-bench:")
        && !(typeof id === "number" && commentsBefore.has(id));
    });
    return theirs.length > 0
      ? { passed: true, evidence: `${theirs.length} comment(s) on issue #${issue}` }
      : { passed: false, evidence: `no comment on issue #${issue}` };
  }

  const dir = mkdtempSync(join(tmpdir(), `mandate-accept-${task.id}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "accept", private: true, type: "module" }),
  );
  for (const [path, content] of Object.entries(task.files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  // Whatever the agent changed on its branch wins over the seed. The file list
  // comes from the pull request when there is one, and falls back to what the
  // record anticipated only when there is not.
  const [owner = "", name = ""] = repo.split("/");
  const fromPr = pullNumber === undefined
    ? []
    : await changedPaths(deps, token, repo, pullNumber);
  const toFetch = new Set([...task.seed, ...task.expectedPaths, ...fromPr]);
  for (const path of toFetch) {
    const res = await deps.github.asInstallation(
      "GET /repos/{owner}/{repo}/contents/{path}", token,
      { owner, repo: name, path, ref: branch },
    );
    if (res.status !== 200) continue;
    const raw = (res.data as { content?: unknown }).content;
    if (typeof raw !== "string") continue;
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(raw, "base64").toString("utf8"), "utf8");
  }

  try {
    execFileSync("bash", ["-c", task.acceptance.command], { cwd: dir, stdio: "pipe" });
    return { passed: true, evidence: `${task.acceptance.command} passed on ${branch}` };
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e);
    return { passed: false, evidence: `${task.acceptance.command} failed on ${branch}: ${detail}` };
  }
}

/**
 * A token for the harness's own reads and writes: grading, and the reset
 * before each run. Grading used to borrow the mandate's token, so the grade
 * depended on the mandate -- a triage mandate without issues access could not
 * read the comment it was graded on.
 */
async function harnessToken(deps: BenchDeps, repo: string): Promise<string | undefined> {
  const res = await deps.github.asApp(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: deps.installationId,
      repositories: [repo.split("/")[1] ?? ""],
      permissions: { contents: "write", pull_requests: "write", issues: "read", metadata: "read" },
    },
  );
  const token = (res.data as { token?: unknown } | null)?.token;
  return res.status === 201 && typeof token === "string" ? token : undefined;
}

/** A reset that did not happen. The run it was for is not run. */
class ResetError extends Error {}

/**
 * Puts a task's branch back where the seed left it, and says what already
 * existed so it is not credited to the run about to start.
 *
 * Without this, a pull request left by an earlier sweep -- or by the other
 * mode a minute ago -- was found by the next run's lookup, which searched
 * every pull request on the branch, closed ones included; and the second mode
 * would have found the first mode's branch, commits and all.
 */
async function resetTask(
  deps: BenchDeps, token: string, repo: string, task: LoadedTask, branch: string,
): Promise<{ pullsBefore: ReadonlySet<number>; commentsBefore: ReadonlySet<number> }> {
  const [owner = "", name = ""] = repo.split("/");
  const pullsBefore = new Set<number>();
  const listed = await deps.github.asInstallation(
    "GET /repos/{owner}/{repo}/pulls", token,
    { owner, repo: name, state: "all", head: `${owner}:${branch}`, per_page: 100 },
  );
  if (listed.status !== 200) throw new ResetError(`listing its pull requests answered ${listed.status}`);
  for (const raw of Array.isArray(listed.data) ? listed.data : []) {
    const pr = raw as { number?: unknown; state?: unknown; head?: { ref?: unknown } };
    if (pr.head?.ref !== branch || typeof pr.number !== "number") continue;
    pullsBefore.add(pr.number);
    if (pr.state === "closed") continue;
    const closed = await deps.github.asInstallation(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}", token,
      { owner, repo: name, pull_number: pr.number, state: "closed" },
    );
    if (closed.status !== 200) {
      throw new ResetError(`closing pull request #${pr.number} answered ${closed.status}`);
    }
  }
  // Checked, because a branch left in place keeps the last run's commits, and
  // the next run would be graded on them. Already gone is the point: 404, or
  // GitHub's 422 "Reference does not exist" -- and no other 422.
  const deleted = await deps.github.asInstallation(
    "DELETE /repos/{owner}/{repo}/git/refs/{ref}", token,
    { owner, repo: name, ref: `heads/${branch}` },
  );
  const message = (deleted.data as { message?: unknown } | null)?.message;
  const gone = deleted.status === 204 || deleted.status === 404
    || (deleted.status === 422 && message === "Reference does not exist");
  if (!gone) throw new ResetError(`deleting ${branch} answered ${deleted.status}`);

  const commentsBefore = new Set<number>();
  const issue = deps.issues[task.id];
  if (task.acceptance.kind === "comment" && issue !== undefined) {
    const res = await deps.github.asInstallation(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", token,
      { owner, repo: name, issue_number: issue, per_page: 100 },
    );
    for (const c of Array.isArray(res.data) ? res.data : []) {
      const id = (c as { id?: unknown }).id;
      if (typeof id === "number") commentsBefore.add(id);
    }
  }
  return { pullsBefore, commentsBefore };
}

/**
 * Said to the agent in every mode, and true in each. "You only have the tools
 * listed" was false with every tool offered, and a prompt that differed between
 * the modes would be what the comparison measured.
 *
 * It says that a call outside the mandate is refused, and deliberately not how
 * to tell which calls those are. The first sweep's version said a tool carrying
 * "Mandate limits" was granted and any other refused, which let the agent rule
 * out an ungranted tool without calling it -- the offer-all triage run never
 * attempted the comment its task needed, and filtering came back through the
 * prompt.
 */
const MANDATE_NOTE = "You are working under a Mandate: a call outside it is refused, and the "
  + "refusal names the clause it broke.";

interface RunInput {
  readonly corpus: Corpus;
  readonly task: LoadedTask;
  readonly visibility: ToolVisibility;
  readonly mandate: ValidatedMandate;
  readonly score: Score;
  readonly groundTruth: ActionGraph;
  readonly taskText: string;
  readonly branch: string;
  readonly harness: string;
  readonly before: { pullsBefore: ReadonlySet<number>; commentsBefore: ReadonlySet<number> };
  readonly writeLatencyMs: number;
}

/** One run of the agent under one mandate in one visibility mode. Cost is the agent's alone. */
async function runOnce(deps: BenchDeps, run: RunInput, log: (s: string) => void): Promise<BenchResult> {
  const { corpus, task, visibility, mandate, score, groundTruth, branch } = run;
  const failed = (evidence: string, cost: number): BenchResult => ({
    taskId: task.id, category: task.category, visibility, completed: false,
    completionEvidence: evidence,
    pullRequestOpened: false, deniedCalls: 0,
    widenRequests: 0, widenRefusals: 0, falsePauses: 0, proposalRejected: false,
    score, writeLatencyMs: run.writeLatencyMs, mandate, cost,
  });

  // ---- mint and enforce -------------------------------------------
  // A per-task failure — a refused mint, a Docker that will not start, an API
  // outage — used to abort the sweep and lose every result before it. The
  // run is recorded as failed and the sweep goes on, because five measured
  // tasks and one error are worth more than nothing.
  // One seam, shared with `mandate run` and `mandate serve`. The benchmark
  // and the command must enforce the same thing or the published numbers
  // describe something nobody can run.
  const decisions: Decision[] = [];
  let session;
  try {
    session = await openSession({
      mandate, github: deps.github, toolVisibility: visibility,
      ...(deps.upstream === undefined ? {} : { upstream: deps.upstream }),
      onDecision: (d: Decision) => decisions.push(d),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`${task.id} [${visibility}]: session FAILED — ${detail}`);
    return failed(`the enforced session could not be opened: ${detail}`, 0);
  }

  const { rules, recorder } = session;
  let cost = 0;

  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: "agent", version: "0.1.0" });
    await Promise.all([session.proxy.connect(a), agent.connect(b)]);

    const offered = (await agent.listTools()).tools;
    const tools: Anthropic.Tool[] = offered.map((t) => ({
      name: t.name, description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const messages: Anthropic.MessageParam[] = [{
      role: "user",
      content: `${run.taskText}\n\nRepository: ${corpus.repo}. ${MANDATE_NOTE} `
        + `Read a file before updating it, because an update needs its sha. `
        + `When you are done, say DONE.`,
    }];

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const reply = await deps.anthropic.messages.stream({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        // The tools and the history are resent every turn, and with every tool
        // offered the tools alone are ~19k tokens. Caching changes what a turn
        // costs, not what the model sees or says.
        cache_control: { type: "ephemeral" },
        tools,
        tool_choice: { type: "auto" },
        messages,
      }).finalMessage();
      cost += costOf(reply.usage);
      messages.push({ role: "assistant", content: reply.content });

      const calls = reply.content.filter((c) => c.type === "tool_use");
      if (calls.length === 0) break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        if (call.type !== "tool_use") continue;
        const args = call.input !== null && typeof call.input === "object"
          ? (call.input as Record<string, unknown>)
          : {};
        const out = await agent.callTool({ name: call.name, arguments: args });
        toolResults.push({
          type: "tool_result", tool_use_id: call.id,
          content: JSON.stringify(out.content).slice(0, 4000),
          ...(out.isError === true ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    // Every non-triage task's issue asks for a pull request, so a run that
    // only pushed a branch has not finished the task as stated. Measured
    // separately from the acceptance command: an early sweep scored four
    // tasks complete whose mandate never granted pull_request.create, because
    // a branch-only check cannot see the difference.
    //
    // Found first, because the pull request is also what says which files to
    // grade.
    const prNumber = task.category === "triage"
      ? undefined
      : await pullRequestFor(deps, run.harness, corpus.repo, branch, run.before.pullsBefore);
    const accepted = await acceptancePasses(
      deps, run.harness, corpus.repo, task, branch, prNumber, run.before.commentsBefore,
    );
    const prRequired = task.category !== "triage";
    const completed = accepted.passed && (!prRequired || prNumber !== undefined);
    const evidence = prRequired && prNumber === undefined
      ? `${accepted.evidence}; no pull request was opened on ${branch}`
      : accepted.evidence;

    // Widen accounting, from the same refusal list the CLI applies.
    const denials: readonly (Decision & { kind: "deny" })[] =
      decisions.filter((d): d is Decision & { kind: "deny" } => d.kind === "deny");
    let widenRequests = 0;
    let widenRefusals = 0;
    for (const d of denials) {
      const pause = pauseRecord({ mandateId: rules.mandateId, decision: d, observed: {} });
      if (pause.widenRequest === undefined) widenRefusals += 1;
      else widenRequests += 1;
    }

    // A false pause: refused here, and the ground truth needed that call.
    const neededTools = new Set(groundTruth.nodes.map((nd) => nd.tool));
    const falsePauses = denials.filter((d) => neededTools.has(d.tool)).length;

    // Written to the scratch output directory, not into `fixtures/`. A
    // mandated trace is the *output* of one sweep and goes stale the moment
    // the mandate changes; the ground-truth traces under `fixtures/bench/`
    // are reproducible *input*. Mixing them meant a sweep dirtied the
    // fixtures and left six files nothing reads. One per mode.
    const trace = recorder.toJsonl();
    const outPath = join(deps.outDir, `${task.id}.${visibility}.mandated.jsonl`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, trace, "utf8");
    // A trace the recorder wrote that parseJsonl will not read back is a
    // format bug, so it is checked on every run rather than trusted.
    parseJsonl(trace);

    log(`${task.id} [${visibility}]: ${completed ? "completed" : "FAILED"}, `
      + `pr=${prNumber ?? "none"}, `
      + `${denials.length} denial(s), ${falsePauses} false pause(s), `
      + `${score.underGrants.length} predicted under-grant(s), $${cost.toFixed(4)}`);

    return {
      taskId: task.id, category: task.category, visibility,
      completed, completionEvidence: evidence,
      pullRequestOpened: prNumber !== undefined,
      deniedCalls: denials.length,
      widenRequests, widenRefusals, falsePauses, proposalRejected: false,
      score, writeLatencyMs: run.writeLatencyMs,
      mandate,
      cost,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`${task.id} [${visibility}]: run FAILED — ${detail}`);
    return failed(`the run did not finish: ${detail}`, cost);
  } finally {
    await session.close();
  }
}

export async function runBench(
  corpus: Corpus, deps: BenchDeps,
): Promise<readonly BenchResult[]> {
  const log = deps.log ?? ((): void => undefined);
  const budget = deps.budget ?? Number.POSITIVE_INFINITY;
  const modes = deps.modes ?? ["granted"];
  const results: BenchResult[] = [];
  // Rewritten after every run, beside the traces, so a published figure can
  // be recomputed from what the sweep enforced -- and a sweep that dies part
  // way still leaves the runs it paid for. A trace header names its mandate
  // only by id and hash.
  const record = (r: BenchResult): void => {
    results.push(r);
    spent += r.cost;
    mkdirSync(deps.outDir, { recursive: true });
    writeFileSync(join(deps.outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  };
  let spent = 0;

  for (const task of corpus.tasks) {
    const groundTruth = deps.groundTruth[task.id];
    if (groundTruth === undefined) {
      log(`skip ${task.id}: no ground-truth trace`);
      continue;
    }
    // Predictive, and for every mode the task will run in: a sweep that
    // notices the overspend afterwards has overspent.
    if (spent + ESTIMATED_COST_PER_RUN * modes.length > budget) {
      log(`skip ${task.id}: would exceed the $${budget.toFixed(2)} budget`);
      continue;
    }

    const issueNumber = deps.issues[task.id] ?? 0;
    const branch = branchFor(task);
    // The same prompt the unconstrained pass used. Identical by construction,
    // because two passes asked different questions do not compare.
    const taskText = taskPrompt(task, corpus.repo, issueNumber);

    // ---- write, once for every mode ---------------------------------
    // One mandate per task, so a difference between the modes is the mode.
    const writerUsage: Anthropic.Usage[] = [];
    const writerCost = (): number => writerUsage.reduce((a, u) => a + costOf(u), 0);
    // The writer ran once; its cost is charged to the first mode's result.
    const charge = (i: number, agentCost: number): number => agentCost + (i === 0 ? writerCost() : 0);
    const noScore: Score = {
      granted: 0, exercised: 0, overGrantRate: 0, unusedActions: [],
      underGrants: [], underGrantRate: 0, consideredCalls: 0, missingActions: [],
    };
    let written;
    try {
      written = await writeMandate(recordingUsage(deps.anthropic, writerUsage), {
        // The identity whose authority validates it below. This was hard-coded
        // to `user:bench` while the live sweep validated as pkravella, so every
        // published benchmark mandate named a requester nobody checked.
        task: taskText, repo: corpus.repo, requestedBy: `user:${deps.authority.login}`,
        ceiling: deps.ceiling, issueNumber,
      });
    } catch (e) {
      // A writer that produced no mandate is a failed task, not a failed sweep:
      // it used to propagate, losing the task's result, its spend and the
      // report. Recorded once per mode, like a refused proposal.
      if (!(e instanceof WriterError)) throw e;
      log(`${task.id}: writer FAILED — ${e.message}`);
      modes.forEach((visibility, i) => record({
        taskId: task.id, category: task.category, visibility, completed: false,
        completionEvidence: `the writer produced no mandate: ${e.message}`,
        pullRequestOpened: false, deniedCalls: 0,
        widenRequests: 0, widenRefusals: 0, falsePauses: 0, proposalRejected: false,
        score: noScore, writeLatencyMs: 0, cost: charge(i, 0),
      }));
      continue;
    }

    const decision = validate(written.proposed, {
      ceiling: deps.ceiling, authority: deps.authority,
    });
    if (!decision.ok) {
      log(`${task.id}: proposal REJECTED — ${decision.rejections.map((r) => r.code).join(", ")}`);
      // Nothing was minted and nothing ran, so there is no mandate to score.
      // Recorded once per mode, so each mode's completion counts the failure.
      modes.forEach((visibility, i) => record({
        taskId: task.id,
        category: task.category,
        visibility,
        completed: false,
        completionEvidence: "validate() rejected the writer's proposal: "
          + decision.rejections.map((r) => r.message).join("; "),
        pullRequestOpened: false,
        deniedCalls: 0,
        widenRequests: 0,
        widenRefusals: 0,
        falsePauses: 0,
        proposalRejected: true,
        score: noScore,
        writeLatencyMs: written.latencyMs,
        cost: charge(i, 0),
      }));
      continue;
    }
    const mandate = decision.mandate;

    // ---- score against ground truth, before anything runs -----------
    // The score is a property of the mandate and the trace, not of a run.
    const score = scoreMandate(mandate, groundTruth);

    const harness = await harnessToken(deps, corpus.repo).catch(() => undefined);
    try {
      for (const [i, visibility] of modes.entries()) {
        if (harness === undefined) {
          record({
            taskId: task.id, category: task.category, visibility, completed: false,
            completionEvidence: "the harness could not mint the token it grades with",
            pullRequestOpened: false, deniedCalls: 0,
            widenRequests: 0, widenRefusals: 0, falsePauses: 0, proposalRejected: false,
            score, writeLatencyMs: written.latencyMs, mandate, cost: charge(i, 0),
          });
          continue;
        }
        let before;
        try {
          before = await resetTask(deps, harness, corpus.repo, task, branch);
        } catch (e) {
          if (!(e instanceof ResetError)) throw e;
          log(`${task.id} [${visibility}]: reset FAILED — ${e.message}`);
          record({
            taskId: task.id, category: task.category, visibility, completed: false,
            completionEvidence: `not run: the reset before it failed (${e.message}), so the `
              + `branch could still hold an earlier run's work`,
            pullRequestOpened: false, deniedCalls: 0,
            widenRequests: 0, widenRefusals: 0, falsePauses: 0, proposalRejected: false,
            score, writeLatencyMs: written.latencyMs, mandate, cost: charge(i, 0),
          });
          continue;
        }
        const r = await runOnce(deps, {
          corpus, task, visibility, mandate, score, groundTruth, taskText, branch,
          harness, before, writeLatencyMs: written.latencyMs,
        }, log);
        record({ ...r, cost: charge(i, r.cost) });
      }
    } finally {
      if (harness !== undefined) await revokeToken(deps.github, harness).catch(() => undefined);
    }
    log(`${task.id}: spent $${spent.toFixed(4)} so far`);
  }

  return results;
}

/**
 * The live sweep's modes, from `MANDATE_BENCH_MODES`. Both by default: the
 * point of Task 6.1 is the difference between them. Anything unrecognised
 * stops the sweep before it spends.
 */
export function parseModes(raw: string | undefined): readonly ToolVisibility[] {
  if (raw === undefined) return ["granted", "all"];
  const modes = raw.split(",").map((m) => m.trim()).filter((m) => m.length > 0);
  if (modes.length === 0) throw new Error("MANDATE_BENCH_MODES names no mode");
  return modes.map((m) => {
    if (m !== "granted" && m !== "all") {
      throw new Error(`unknown tool-visibility mode ${JSON.stringify(m)}; use granted or all`);
    }
    return m;
  });
}

/**
 * The tasks to run, from `MANDATE_BENCH_TASKS`, in corpus order. A subset is
 * said to be one, so its report does not replace the published report.
 */
export function selectTasks(
  corpus: Corpus, raw: string | undefined,
): { readonly corpus: Corpus; readonly subset: boolean } {
  if (raw === undefined) return { corpus, subset: false };
  const wanted = new Set(raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0));
  for (const id of wanted) {
    if (!corpus.tasks.some((t) => t.id === id)) throw new Error(`no task ${JSON.stringify(id)} in the corpus`);
  }
  return { corpus: { ...corpus, tasks: corpus.tasks.filter((t) => wanted.has(t.id)) }, subset: true };
}

/**
 * An earlier sweep's results, reused rather than paid for again
 * (`MANDATE_BENCH_PRIOR`). A task is done only if they cover it in every mode
 * this sweep runs; a partial task runs again and its earlier results are
 * dropped, so no task mixes runs from two sweeps.
 */
export function applyPrior(
  corpus: Corpus, prior: readonly BenchResult[], modes: readonly ToolVisibility[],
): { readonly corpus: Corpus; readonly kept: readonly BenchResult[] } {
  for (const r of prior) {
    if (!corpus.tasks.some((t) => t.id === r.taskId)) {
      throw new Error(`earlier results name ${JSON.stringify(r.taskId)}, which is not in the corpus`);
    }
  }
  const done = new Set(corpus.tasks
    .filter((t) => modes.every((m) => prior.some((r) => r.taskId === t.id && r.visibility === m)))
    .map((t) => t.id));
  return {
    corpus: { ...corpus, tasks: corpus.tasks.filter((t) => !done.has(t.id)) },
    kept: prior.filter((r) => done.has(r.taskId) && modes.includes(r.visibility)),
  };
}

/** Results in corpus order, then mode order, whichever sweep produced them. */
export function inCorpusOrder(
  corpus: Corpus, results: readonly BenchResult[], modes: readonly ToolVisibility[],
): readonly BenchResult[] {
  const at = (r: BenchResult): number =>
    corpus.tasks.findIndex((t) => t.id === r.taskId) * modes.length + modes.indexOf(r.visibility);
  return [...results].sort((a, b) => at(a) - at(b));
}

/**
 * What the published report says about its corpus. One function, called by
 * the live sweep that writes the report and by the test that re-renders it from
 * the committed results, so the two cannot describe the corpus differently.
 */
export function sweepMeta(corpus: Corpus): CorpusMeta {
  return {
    repo: corpus.repo,
    composition: compositionOf(corpus.tasks),
    shortfall: corpus.shortfall,
    provenance: {
      synthetic: corpus.tasks.filter((t) => t.provenance.kind === "synthetic").length,
      derived: corpus.tasks.filter((t) => t.provenance.kind === "derived").length,
    },
    groundTruthFrom: "six unconstrained runs recorded 2026-10-06 against the live "
      + "github-mcp-server",
    // Task 6.4. Not the installation's count: the dev App is installed on the
    // sandbox repository alone, so that would reproduce the one-repository
    // figure. The PRD's baseline is the developer's own token.
    baselineRepositories: {
      count: 63,
      source: "the repositories pkravella's own GitHub token reaches as owner, "
        + "collaborator or organization member (`gh api /user/repos`, 2026-10-10)",
    },
  };
}

/** Reads the committed ground-truth traces for a corpus. */
export function loadGroundTruth(
  corpusDir: string, corpus: Corpus,
): Readonly<Record<string, ActionGraph>> {
  const out: Record<string, ActionGraph> = {};
  for (const task of corpus.tasks) {
    const p = join(corpusDir, "traces", `${task.id}.unconstrained.jsonl`);
    if (!existsSync(p)) continue;
    out[task.id] = parseJsonl(readFileSync(p, "utf8"));
  }
  return out;
}
