import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { githubAppDeps } from "@mandate-dev/compiler";
import { loadCorpus } from "./tasks.js";
import { seedCorpus } from "./seed.js";

/**
 * Seeds the corpus into the bench repository, for real.
 *
 * Gated on its own variable rather than on `MANDATE_LIVE`, because this one
 * **writes to the default branch and opens issues**. That is deliberate — the
 * agent's authority is what the benchmark measures, so the fixture it runs
 * against cannot be built by the enforced loop — but it means a run that fires
 * by accident mutates a real repository.
 *
 * Costs nothing: GitHub API only, no model.
 *
 *   MANDATE_SEED=1 pnpm --filter @mandate-dev/bench exec vitest run src/seed.live.test.ts
 *
 * Idempotent. Re-running leaves matching files alone and reuses each task's
 * existing issue.
 */
const env = (n: string): string | undefined => process.env[n];
const enabled = env("MANDATE_SEED") === "1"
  && env("MANDATE_APP_ID") !== undefined
  && env("MANDATE_INSTALLATION_ID") !== undefined
  && env("MANDATE_APP_KEY_PATH") !== undefined;

const CORPUS = fileURLToPath(new URL("../../../fixtures/bench", import.meta.url));

describe.skipIf(!enabled)("seeding the corpus", () => {
  it("writes every task's files and opens one issue each", async () => {
    const corpus = loadCorpus(CORPUS);
    const deps = githubAppDeps({
      appId: env("MANDATE_APP_ID") ?? "",
      installationId: Number(env("MANDATE_INSTALLATION_ID") ?? "0"),
      privateKeyPath: env("MANDATE_APP_KEY_PATH") ?? "",
    });

    const [, name = ""] = corpus.repo.split("/");

    // Minted directly rather than through mintToken, which takes a
    // ValidatedMandate: no mandate permits writing a default branch or opening
    // an issue, and none should. Seeding is outside the enforced loop and this
    // is the line where that is true.
    const res = await deps.asApp(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: Number(env("MANDATE_INSTALLATION_ID") ?? "0"),
        repositories: [name],
        permissions: { contents: "write", issues: "write", metadata: "read" },
      },
    );
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    const token = (res.data as { token?: unknown }).token;
    expect(typeof token).toBe("string");

    const results = await seedCorpus(deps, String(token), corpus);

    console.log(`\n--- seeded ${results.length} tasks into ${corpus.repo}`);
    for (const r of results) {
      console.log(
        `    ${r.taskId}  issue #${r.issueNumber}`
        + `${r.issueCreated ? " (created)" : " (existing)"}`
        + `  wrote ${r.filesWritten.length}, unchanged ${r.filesUnchanged.length}`,
      );
    }
    console.log(`--- composition ${JSON.stringify(corpus.composition)}`);
    console.log(`--- shortfall against D8's 50 ${JSON.stringify(corpus.shortfall)}`);

    expect(results).toHaveLength(corpus.tasks.length);
    for (const r of results) expect(r.issueNumber).toBeGreaterThan(0);

    // Every seeded path is now on the default branch with the content the
    // corpus declares. Checked for real, because the whole point of a fixture
    // is that the agent reads what the record says it will.
    for (const task of corpus.tasks) {
      for (const [path, content] of Object.entries(task.files)) {
        const got = await deps.asInstallation(
          "GET /repos/{owner}/{repo}/contents/{path}", String(token),
          { owner: corpus.repo.split("/")[0] ?? "", repo: name, path },
        );
        expect(got.status, `${task.id}:${path}`).toBe(200);
        const raw = (got.data as { content?: unknown }).content;
        expect(
          Buffer.from(typeof raw === "string" ? raw : "", "base64").toString("utf8"),
          `${task.id}:${path}`,
        ).toBe(content);
      }
    }
  }, 300_000);
});

/** Prints the issue numbers a later run needs, without writing anything. */
describe.skipIf(!enabled)("the seeded corpus", () => {
  it("is loadable and complete", () => {
    const corpus = loadCorpus(CORPUS);
    expect(corpus.tasks.length).toBeGreaterThan(0);
    const total = Object.values(corpus.composition).reduce((a, b) => a + b, 0);
    expect(total).toBe(corpus.tasks.length);
  });
});
