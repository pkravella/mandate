# The benchmark corpus

Decision D8. Task records, and the repository state each one needs.

`packages/bench` loads and validates this directory; `packages/bench/src/seed.ts`
materializes it into the bench repository.

## What is here

| | |
| --- | --- |
| `index.json` | the bench repository, and the task ids in order |
| `<id>.json` | one task: its issue, its seed paths, its acceptance, its provenance |
| `seed/<id>/...` | the files that task seeds, at their repository paths |
| `reference/<id>/...` | a correct fix, used only to prove the task is solvable |
| `traces/<id>.unconstrained.jsonl` | the ground-truth trace, committed |

A sweep's own traces are **not** here: they go to `bench/out/`, which is
gitignored. The distinction matters because the two are different kinds of
thing. A ground-truth trace is reproducible *input* — every later score is
measured against it, and committing it makes that scoring offline and free. A
mandated trace is the *output* of one sweep and goes stale the moment the
mandate changes. The published report is
[`docs/benchmark-report.md`](../../docs/benchmark-report.md).

Seed and reference files are real source files rather than strings inside JSON,
so a reviewer reads JavaScript instead of escaped text.

## One repository hosts every task

The corpus does not need one repository per task, and that falls out of a
property the system already has: **no mandate may permit a write to a default
branch**, so a run cannot mutate `main`. Each task therefore owns a disjoint set
of files, seeds them onto `main` once, and resets by closing its pull request and
deleting its branch.

The loader enforces the disjointness, because two tasks sharing a file would
interfere in a way nothing downstream would attribute correctly. The isolation
comes from the disjoint paths, not from a repository boundary — and one
repository means the GitHub App needs installing once rather than fifty times.

## Acceptance has to discriminate, and it is checked

Every non-triage task's acceptance command must **fail on the seeded state** and
**pass with the reference fix applied**. `packages/bench/src/corpus.test.ts`
runs both directions for every task, offline and free.

This is not a formality. On the first draft, four of five acceptance commands
*passed* on the seeded bug — so finishing the task proved nothing — and the one
that failed contradicted its own issue text by claiming the suite passed.

A triage task writes nothing, so its acceptance is the comment it leaves and its
`expectedPaths` is empty. A mandate that grants a write for a triage task is
over-granting by construction.

## What this corpus is not

**It is smaller than D8 requires.** D8 fixes the mix at 30 single-file fixes, 10
multi-file fixes, 5 dependency bumps and 5 triage tasks. `loadCorpus` reports
the shortfall against that target as a number, so a report cannot present a
result over this corpus as a result over that one.

Reaching 50 is a budget question, not a code one. The harness runs each task
twice — unconstrained for ground truth, then mandated — and the unconstrained
pass is the more expensive one, because the agent is shown all 46 of the default
server's tools rather than the handful a mandate grants. Measured with
`countTokens`: 19,405 tool-schema tokens against 3,053, a difference of 16,352
per turn. At six turns that is ~98k extra input tokens, about **$0.39 more per
unconstrained run**.

| | cost |
| --- | --- |
| Mandated pass (writer + agent) | ~$0.27 |
| Unconstrained pass | ~$0.63 |
| Per task, both passes | ~$0.89 |
| 50 tasks, one sweep | **~$45** |

The unconstrained trace is ground truth and is recorded **once** per task; it
does not change when a mandate changes. Scoring a candidate mandate against an
existing trace is offline and free.

Re-recording is therefore its own gate, `MANDATE_GROUND_TRUTH=1`, separate from
the mandated sweep's `MANDATE_BENCH=1`. It overwrites the committed traces, so
re-record only when the corpus or the shared task prompt changes — a trace
recorded against a different question is not ground truth for this one.

**Its tasks are synthetic, and easier than real ones.** Every record here
declares `provenance: { kind: "synthetic" }`, and the schema will not let a
synthetic task imply attribution it does not have. Two things make these easier
than the issues the PRD's completion-rate target is about:

- the seeded test suite already contains a failing test, so the agent is told
  what is wrong rather than having to find it; and
- the bugs are single-cause and local, because they were written to be.

That trade is deliberate. The benchmark measures whether the **mandate** let the
agent finish, not whether the agent could locate a subtle bug, and a
deterministic completion signal is worth more for that than difficulty fidelity.
But it means a completion rate measured here is optimistic, and a report must say
so rather than inherit the credibility of a corpus drawn from real repositories.
A `derived` provenance exists in the schema for records that are, and it requires
the source repository, a full commit sha, the license, and the issue URL.

## Both passes must be asked the same question

`taskPrompt` in `packages/bench/src/prompt.ts` is the single prompt both the
unconstrained and the mandated pass use. It is shared because it was not, and
the divergence silently invalidated a whole sweep: the unconstrained prompt
asked for a pull request and the mandated one did not, so ground truth contained
a call the mandated run was never asked to make, the writer correctly granted
nothing for a pull request nobody asked for, and the under-grant the sweep
reported was an artifact of the two prompts rather than a property of the
mandate.

A benchmark whose two passes are asked different questions measures nothing. If
you change the prompt, re-record ground truth.

## Seeding and resetting

Seeding writes to the default branch and opens issues. **No mandate permits
either, and none should** — the agent's authority is the thing under
measurement, so the fixture it runs against has to be built by something outside
the enforced loop. The seeder uses the installation token directly.

It is idempotent: a file whose content already matches is left alone, and a task
whose issue already exists is reused. The issue is matched on a
`<!-- mandate-bench:<id> -->` marker in its body rather than on its title, so a
reworded title does not duplicate it.

Between runs, close each task's pull request and delete its branch:

```bash
gh pr close <n> --repo <bench-repo> --delete-branch
```

`main` needs no reset, because nothing was ever allowed to write it.
