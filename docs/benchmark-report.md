# Mandate v0.1 benchmark report

## What this measures, and what it does not

**6 of a target 50 tasks.** Decision D8 fixes the corpus at 50 tasks (30 single-file-fix, 10 multi-file-fix, 5 dependency-bump, 5 triage). This corpus is 6, leaving a shortfall of 27 single-file-fix, 9 multi-file-fix, 4 dependency-bump, 4 triage. Every figure below is over 12 runs (6 tasks × 2 modes) and is not the 50-task result D8 asks for.

**6 of the tasks are synthetic.** A synthetic bug is easier than one found in the wild, and each seeded suite already contains a failing test, so the agent is told what is wrong rather than having to find it. Completion rate here is therefore **optimistic**, and it does not inherit the credibility of a corpus drawn from real repositories.

Ground truth: six unconstrained runs recorded 2026-10-06 against the live github-mcp-server, against `pkravella/mandate-sandbox`. Over- and under-grant are scored by replaying those traces through the production argument enforcer, so a score is the decision the proxy would have made.

> **How this sweep was run (Task 6.1, 2026-10-11).** It merges three runs, each
> task's mandate written once and its agent run once per mode:
> `retry-swallows-last-error` first, the other four fix tasks second, and
> `triage-timer-leak` re-run after a fix to the agent's instruction. The five
> fix tasks' agents were told that a tool carrying "Mandate limits" is granted
> and any other refused, which tells an agent how to rule out an ungranted tool
> without calling it, so **their offer-all denials are a lower bound**. Triage
> was re-run with an instruction that says only that a call outside the mandate
> is refused. Its first offer-all run, under the old instruction, made one call
> and never attempted the comment its task needed; under the new one it tried
> `add_issue_comment` and was refused. The cost section counts the runs
> reported here; the discarded triage pair cost $0.22 more, for $2.06 in all.

> **Write latency since this sweep (Task 6.2, 2026-10-11).** The latency rows
> below were measured with the writer at effort `high` for both calls. The six
> tasks' mandates were then written again from the same task text at several
> settings and compared with this sweep's, facet by facet. At `medium` for both
> calls all six were identical. On the five tasks written at both settings in
> the same session, every `medium` write was faster (by 0.4 to 5.3 s): median
> 10.4 s against 11.7 s for `high`, and 10.2 s across all six at `medium` --
> still over the 10 s target.
> Lowering only the prune call changed or broke three of five. The writer now
> defaults to `medium`; the measurements are in `docs/writer-effort-results.json`.

## Metrics

Baseline for the authority cut (D7): a token holding the permissions the GitHub MCP server's default toolsets require (contents: write, issues: write, pull_requests: write, actions: read, metadata: read), counted as reachable (operation × repository) pairs, and reported against two repository counts. **One repository** is the conservative figure: it is reproducible and credits Mandate with nothing for choosing the repository. **63 repositories** is the PRD's baseline, the agent's usual static token: the repositories pkravella's own GitHub token reaches as owner, collaborator or organization member (`gh api /user/repos`, 2026-10-10). Neither is the authority cut; each is labelled.

### Tools filtered (the product: a tool no grant reaches is not offered)

| Metric | Result | v0.1 target | Met |
| --- | --- | --- | --- |
| Task completion | 83.3% | at least 90% | **NO** |
| Authority cut, token layer, against 1 repository | 32.3% | at least 80% | **NO** |
| Authority cut, proxy layer, against 1 repository | 87.1% | at least 80% | yes |
| Authority cut, token layer, against 63 repositories | 98.9% | at least 80% | yes |
| Authority cut, proxy layer, against 63 repositories | 99.8% | at least 80% | yes |
| Over-grant | 0.0% | under 10% | yes |
| Widen requests | 0.00 | under 0.3 per task | yes |
| False pauses | 0.0% | under 5% | yes |
| Denials | 0 (0 a widen could satisfy) | — | — |
| Write latency | 13010 ms | under 10 s | **NO** |
| Ceiling breaches | 0 by construction | 0 | — |
| Proposals rejected by validate() | 0 | — | — |

**The false-pause figure is 0 because nothing paused, not because the mandates were the right size.** Across 6 runs the proxy issued **0 denials**, while replay predicts **7 under-granted calls**. The proxy filters `tools/list`, so a tool no grant reaches is never offered and therefore never attempted: the agent works around it or quietly fails. R10's promise that every pause names the clause it hit holds, and is vacuous where there is no pause. Under-grant, not false pauses, is the metric that sees this.

### Every tool offered (measurement: an ungranted tool is offered, and refused on call)

| Metric | Result | v0.1 target | Met |
| --- | --- | --- | --- |
| Task completion | 83.3% | at least 90% | **NO** |
| Authority cut, token layer, against 1 repository | 32.3% | at least 80% | **NO** |
| Authority cut, proxy layer, against 1 repository | 87.1% | at least 80% | yes |
| Authority cut, token layer, against 63 repositories | 98.9% | at least 80% | yes |
| Authority cut, proxy layer, against 63 repositories | 99.8% | at least 80% | yes |
| Over-grant | 0.0% | under 10% | yes |
| Widen requests | 0.00 | under 0.3 per task | yes |
| False pauses | 66.7% | under 5% | **NO** |
| Denials | 5 (0 a widen could satisfy) | — | — |
| Write latency | 13010 ms | under 10 s | **NO** |
| Ceiling breaches | 0 by construction | 0 | — |
| Proposals rejected by validate() | 0 | — | — |

With every tool offered, the proxy issued **5 denials** across 6 runs, against **7** under-granted calls replay predicts. 0 a widen could satisfy; 5 need a new mandate, because a widen may not add an operation, nor touch a deny path, an expiry or a destination. 4 runs had a false pause, and 3 of them still completed: a refused call the ground truth made is not always one the task needed, since both passes are given the issue text.

Over-grant counts granted operations; the authority cut counts (operation × repository) pairs. Each is right for its own definition, and the two do not compare.

Ceiling breaches are 0 **by construction**, not by measurement: nothing but `validate()` can produce a `ValidatedMandate`, and nothing downstream accepts anything else. The adversarial suite is what tests that claim under attack; this report does not.

The authority cut is two numbers because a GitHub App token cannot express branch or path scope. The token-layer figure is what holds if the agent escapes the proxy; the proxy-layer figure is what holds while it does not. See `docs/enforced-where.md`.

## Where the authority cut comes from

The baseline reaches 31 operations × 63 repositories = 1953 pairs. Medians across the 6 minted mandates, three things narrow it:

1. **Repository scoping**, 63 repositories to 1. Any installation token limited to the task's repository gets this without Mandate; what Mandate adds is choosing that repository per task. It is most of the cut against 63 repositories.
2. **Permission narrowing**, the token layer: 31 to 21 operations per repository, from the permissions the mandate's grants need.
3. **Operation narrowing**, the proxy layer: 21 to 4 operations per repository, the ones the mandate actually granted.

The gap between the layers is not all of what GitHub cannot enforce: it counts operations, and branch and path limits, which a token cannot express either, are invisible to an (operation × repository) count. It understates what only the proxy holds.

The baseline's permission set understates a personal access token's. A classic token with `repo` scope also carries `administration` on every repository its owner administers, which this baseline leaves out, so against such a token both layers' cuts are larger than reported here.

## What filtering hides

Each task ran under one mandate in each mode, so a difference between the columns is the mode, not the mandate. It is one run per mode per task, and an agent does not do the same thing twice, so a difference of one task is noise until it repeats.

| Task | Completed, filtered | Completed, offered | Denials, filtered | Denials, offered | False pauses, offered |
| --- | --- | --- | --- | --- | --- |
| retry-swallows-last-error | yes | yes | 0 | 0 | 0 |
| parse-config-throws-on-empty | yes | yes | 0 | 1 | 1 |
| paginate-drops-last-page | yes | yes | 0 | 0 | 0 |
| slug-collides-on-truncation | yes | yes | 0 | 1 | 1 |
| bump-pinned-tool-version | yes | yes | 0 | 1 | 1 |
| triage-timer-leak | **no** | **no** | 0 | 2 | 2 |

## Completion and under-grant disagree

10 runs completed while the replay scored an under-grant. That is not a contradiction: a blocked call can be one the task could finish without — the agent worked around it, or the task text already carried what the call would have fetched. It does mean a completion rate alone would hide a mandate that is too narrow, so both are reported and neither is the headline.

- `retry-swallows-last-error` completed with filtered tools, blocked on 1 call(s); needed issue.read
- `retry-swallows-last-error` completed with offered tools, blocked on 1 call(s); needed issue.read
- `parse-config-throws-on-empty` completed with filtered tools, blocked on 1 call(s); needed issue.read
- `parse-config-throws-on-empty` completed with offered tools, blocked on 1 call(s); needed issue.read
- `paginate-drops-last-page` completed with filtered tools, blocked on 1 call(s); needed issue.read
- `paginate-drops-last-page` completed with offered tools, blocked on 1 call(s); needed issue.read
- `slug-collides-on-truncation` completed with filtered tools, blocked on 1 call(s); needed issue.read
- `slug-collides-on-truncation` completed with offered tools, blocked on 1 call(s); needed issue.read
- `bump-pinned-tool-version` completed with filtered tools, blocked on 1 call(s); needed issue.read
- `bump-pinned-tool-version` completed with offered tools, blocked on 1 call(s); needed issue.read

## Per task

| Task | Tools | Category | Completed | PR | Denials | Under-grants | Over-grant | Latency | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| retry-swallows-last-error | filtered | single-file-fix | yes | yes | 0 | 1 | 0.0% | 16406 ms | $0.1285 |
| retry-swallows-last-error | offered | single-file-fix | yes | yes | 0 | 1 | 0.0% | 16406 ms | $0.1841 |
| parse-config-throws-on-empty | filtered | single-file-fix | yes | yes | 0 | 1 | 0.0% | 16069 ms | $0.1463 |
| parse-config-throws-on-empty | offered | single-file-fix | yes | yes | 1 | 1 | 0.0% | 16069 ms | $0.1856 |
| paginate-drops-last-page | filtered | single-file-fix | yes | yes | 0 | 1 | 0.0% | 12983 ms | $0.1037 |
| paginate-drops-last-page | offered | single-file-fix | yes | yes | 0 | 1 | 0.0% | 12983 ms | $0.1599 |
| slug-collides-on-truncation | filtered | multi-file-fix | yes | yes | 0 | 1 | 0.0% | 11202 ms | $0.2128 |
| slug-collides-on-truncation | offered | multi-file-fix | yes | yes | 1 | 1 | 0.0% | 11202 ms | $0.2183 |
| bump-pinned-tool-version | filtered | dependency-bump | yes | yes | 0 | 1 | 0.0% | 13037 ms | $0.1000 |
| bump-pinned-tool-version | offered | dependency-bump | yes | yes | 1 | 1 | 0.0% | 13037 ms | $0.1603 |
| triage-timer-leak | filtered | triage | **no** | n/a | 0 | 2 | 0.0% | 11115 ms | $0.0805 |
| triage-timer-leak | offered | triage | **no** | n/a | 2 | 2 | 0.0% | 11115 ms | $0.1619 |

## By category

| Category | Tools | Tasks | Completed | In D8's target |
| --- | --- | --- | --- | --- |
| single-file-fix | filtered | 3 | 3 | 30 |
| single-file-fix | offered | 3 | 3 | 30 |
| multi-file-fix | filtered | 1 | 1 | 10 |
| multi-file-fix | offered | 1 | 1 | 10 |
| dependency-bump | filtered | 1 | 1 | 5 |
| dependency-bump | offered | 1 | 1 | 5 |
| triage | filtered | 1 | 0 | 5 |
| triage | offered | 1 | 0 | 5 |

## Under-grants by clause

- `mandate.grants`: 7

## Operations the corpus needed and mandates lacked

- `issue.comment`
- `issue.read`
- `pull_request.comment`

## Granted operations no task exercised

None.

## Cost

$1.8417 across 12 mandated runs, excluding the one-time ground-truth pass. The writer ran once per task; its cost is in the first mode's run.

