# LeastPilot

Task-scoped authority for AI agents.

LeastPilot gives each agent task its own authority and enforces it, before and
during execution, with one artifact. From a request like *"Fix issue #42 and
open a PR"* it writes a **mandate**: the resources, actions, argument limits,
allowed data destinations and expiry that the task needs. A deterministic
validator proves the mandate grants nothing beyond what the user and the
organization already allow. LeastPilot then compiles it into controls GitHub and
MCP gateways already enforce, and watches the run against it.

> **Renamed from Mandate.** The product, the `leastpilot` binary, the
> `@leastpilot/*` packages, the `/leastpilot` comment commands and the
> `LEASTPILOT_*` variables are new names; the old `MANDATE_*` ones are no
> longer read. What it writes is still a mandate, so the mandate YAML, the
> Cedar namespace `Mandate::`, `mandate-audit/1` and `mandate-approval/1` are
> unchanged: old logs still verify and old ceilings still load.

> **Status: v0.1 plus Phases 5 and 6 of the post-MVP plan. The loop runs end
> to end from one command, and is measured — but completion, write latency and
> the token-layer authority cut against one repository miss their targets, and
> the corpus is six tasks rather than fifty.** A model
> writes a mandate, the validator proves it against a Cedar ceiling and a
> destination allowlist, a repo-scoped GitHub App token is minted, and
> `leastpilot run` launches an agent whose GitHub tools all go through the enforced
> proxy. With `--sandbox` the agent runs in a container that holds no GitHub
> credential at all and reaches only the mandate's destinations; without it,
> any credential the agent can find is its own (see the
> [threat model](docs/threat-model.md) §3.1). Every decision is recorded as an
> action graph, and a replay evaluator scores mandates against traces of
> unconstrained runs.
>
> What is measured and what is missed: the
> [benchmark report](docs/benchmark-report.md), which states its own shortfalls
> before any metric and is rendered from the committed results it reports. What
> is not built: [below](#not-built).

## What a mandate looks like

```yaml
mandate: fix-issue-42
task: "Fix issue #42 and open a PR"
requestedBy: user:alice        # an authorized source, never the agent
expiresInMinutes: 60
ceiling: org-policy@v12        # proved to be a subset of this
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["acme/api"]
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    paths: ["src/**"]
    denyPaths: [".github/workflows/**", "**.env**"]
  - action: pull_request.create
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    base: main
    max: 1
destinations:
  allow: ["github.com/acme/api"]
```

Anything not granted is denied.

## What works today

```bash
pnpm install && pnpm build

node packages/cli/dist/index.js validate mandate.yaml \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema  fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --repo acme/api --repositories 20
```

`--repo` reads `alice`'s permission on `acme/api` from GitHub, which is what
makes the output an authorisation record. It needs `LEASTPILOT_APP_ID`,
`LEASTPILOT_INSTALLATION_ID` and `LEASTPILOT_APP_KEY_PATH`; the token it mints carries
`metadata: read` and nothing else, and is revoked straight after the lookup.

Without credentials, assert the level instead — and the output says, every
time, that it is an assertion:

```bash
node packages/cli/dist/index.js validate mandate.yaml \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema  fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --level push
```

There is no default. `--level` used to default to `push`, so every run quietly
asserted push authority with nothing in the output saying so.

Exit 0 prints the permission diff, 1 prints the rejection with the ceiling
clause and a counterexample, 2 means the input could not be read or the command
was mistyped. Every result names the ceiling it was checked against by its file
and the sha256 of its contents; a mandate's own `ceiling:` field is shown only
as the claim it is.

A paused call can be re-reviewed with more scope. `leastpilot widen` takes the
pause record the proxy emitted and re-validates the whole mandate from scratch,
so the agent can never grant itself anything:

```bash
node packages/cli/dist/index.js widen mandate.yaml pause.json \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema  fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --repo acme/api
```

Not every denial is widenable, and the refusal list is the contract: a deny
path, an expired mandate, an ungranted operation, a disallowed destination and
an internal error are all refused with the reason instead. A one-click "add
`.github/workflows/**` to your paths" would make the deny list decorative.

A refusal looks like this:

```
Mandate rejected.

  [not-contained] in grant #0 (contents.write) grant contents.write is wider
    than ceiling clause allow-agent-branch-writes: it would permit "feature/42-"
      ceiling clause: allow-agent-branch-writes
      counterexample: feature/42-

Nothing was minted. Narrow the mandate, or request a ceiling change.
```

Which of the two you used is printed with the result, because "verified
against GitHub" and "asserted by whoever ran the command" are different claims
and output that does not distinguish them reads like an authorisation record
without being one.

## Running an agent under a mandate

`leastpilot serve` is an MCP server that enforces one mandate. `leastpilot run`
validates, writes a config pointing at it, and launches the command you give:

```bash
node packages/cli/dist/index.js run \
  --mandate mandate.yaml \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema  fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --repo acme/api --trace run.jsonl --diff \
  -- claude --mcp-config '{mcpConfig}' -p "Fix issue #42 and open a PR"
```

`{mcpConfig}` becomes the config path, and `LEASTPILOT_MCP_CONFIG` is set in the
agent's environment, so an agent that takes a flag and one that reads the
environment both work.

LeastPilot does not drive a particular agent. Every MCP client already knows how to
start a server from a config, so *being* that server is the whole integration —
which is also what makes vendor neutrality true rather than aspirational. The
cost of that choice: LeastPilot bounds the authority it mints, and cannot bound an
agent holding a credential of its own. That is the sandbox's job, and
[docs/threat-model.md](docs/threat-model.md) §3.1 says so.

Nothing is minted and no agent is launched until the mandate validates. The
config the agent reads carries no credential: `leastpilot serve` mints its own
token in its own process. But without the sandbox the agent spawns that process
itself, with the operator's environment — which names the App's private key,
readable by the agent's own user. That is what `--sandbox` is for.

### In the sandbox

```bash
docker build -t mandate-sandbox sandbox
docker build -t mandate-agent-claude sandbox/examples/claude-code
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

node packages/cli/dist/index.js run --mandate mandate.yaml \
  --ceiling fixtures/ceilings/sandbox-v1.cedar \
  --schema  fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/sandbox-v1.destinations \
  --as pkravella --repo pkravella/mandate-sandbox \
  --sandbox --image mandate-agent-claude --agent-egress api.anthropic.com \
  --pass-env ANTHROPIC_API_KEY --pass-env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC \
  -- claude -p "read src/retry.js and say what it does" \
     --mcp-config '{mcpConfig}' --strict-mcp-config --allowedTools mcp__github
```

`leastpilot run` starts `leastpilot serve` itself, on the host, and runs the agent in a
container built from an allowlist: a depth-1 clone of HEAD (HEAD's tree and no
other object — no history, stash or host hook, no ignored `.env`; a dirty tree
is refused), egress to the mandate's destinations except GitHub's own hosts —
the agent reaches GitHub only through serve — plus the hosts named with
`--agent-egress`, and only the environment variables named with `--pass-env`,
refusing anything GitHub-named outright. squid never matches a destination by
reverse DNS and refuses IP addresses, and the agent runs with no way to regain
privileges. Ctrl-C or a `kill` stops docker, then serve (which revokes), then
removes the workspace. The agent
reaches serve through a relay with a secret handshake. Verified live with
Claude Code: the allowed read succeeded, a read of another repository was
refused at `repo.read.resources`, and the only egress was two tunnels to the
model's API. macOS with Docker Desktop only; `--sandbox` refuses elsewhere,
which includes the Action's Linux runners.

### An audit log

`--audit-log <path>` on `run` or `serve` writes a signed, append-only record of
the session as it happens: the mandate, every call sent to GitHub, every
decision, and a seal saying whether the session served or never opened. Each line is signed with
an Ed25519 key of its own (`LEASTPILOT_AUDIT_KEY_PATH`, made by
`leastpilot audit keygen`), never the App's, and chained to the line before it.
`leastpilot audit verify <log> --public-key <pub>` checks it with the public half
alone and names any call that was sent and never answered. With `--sandbox` the
key never reaches the agent; without it, the agent could read the key and
rewrite the log. [docs/audit-log.md](docs/audit-log.md) has the format and what
the signature does and does not prove.

### Requiring an approval

`--approval owner/repo#number` on `serve` or `run` refuses to mint until the
mandate's requester has approved it in a comment on that issue or pull request,
on a line of its own:

```
/leastpilot approve 3f9c…
```

The refusal prints the exact line to post. The digest covers the mandate's
content, the ceiling it was proved against and its requester, so a mandate
edited after review, or validated against another ceiling, needs a new
approval. Only the requester's own comment counts, and never an edited one,
since a repository admin can edit anyone's comment. GitHub dates comments to
the second, so an edit made within the second the comment was posted is not
detected. An approval stands until its comment is deleted: it covers every
session of that mandate, ceiling and requester, not one run. Each session's
approval goes into the audit log. Reading it needs the App's `issues: read` and
`pull_requests: read`: a pull request's comments are refused to an
`issues: read` token (probed).

### Asking for a mandate in a comment

`leastpilot review` writes a mandate for a requester's task and posts its
permission diff on the issue or pull request, with the exact line that
approves it:

```bash
node packages/cli/dist/index.js review --task-file task.txt --on acme/api#42 \
  --as alice --repo acme/api \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema  fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations --post
```

The model call costs money and the request is a comment, so everything that
can refuse without the model goes first:
- **The requester's level.** It is read from GitHub, and `--level` is refused.
  It must be at least `--min-level` (default `push`). The validator still
  bounds the mandate by that level afterwards.
- **A rate limit.** At most `--max-per-hour` (default 10) mandates per
  repository per hour. Only the App's own review comments are counted, since
  anyone can type the marker it leaves. Rejections and failed writes count too,
  since they were paid for. The count is read, then the write happens, so two
  reviews running at once can both pass it: run them one at a time per
  repository (a workflow `concurrency` group does that). Deleting the App's
  comments resets the count.
- **The task's length.** A mandate holds at most 4000 characters of task, and
  a longer one is refused before it is sent to the model.

The task text sits inside code fences it cannot close, so a comment cannot
write Markdown under the App's name. A rejected proposal, or a writer that
produced nothing, is posted too, with nothing to approve. Without `--post`, the
comment is printed instead.

### Exporting to gh-aw

`leastpilot export gh-aw` validates a mandate and prints it as the frontmatter of
a [GitHub Agentic Workflows](https://github.github.com/gh-aw/) workflow (gh-aw
v0.89.21). The agent runs read-only, and gh-aw's own job writes the pull
request or comments within the mandate's limits. It refuses anything gh-aw
cannot hold exactly rather than widen it: branch patterns (gh-aw normalises a
branch name after checking it, so `agent/42-!!` matches `agent/42-*` and is
pushed as `agent/42`), reads limited by path, more than one repository, a
mandate that writes nothing. It also switches off every gh-aw default that
writes something on its own. gh-aw sets these limits when the workflow is
written, so the result is a template for a kind of task, not one task's
mandate. A conformance test runs gh-aw's own matcher code against LeastPilot's.
[docs/gh-aw.md](docs/gh-aw.md) has the mapping and every refusal.

In a repository, [examples/workflows/leastpilot-review.yml](examples/workflows/leastpilot-review.yml)
runs this on comments:
1. `/leastpilot <task>` from someone with at least `push` posts the review.
2. `/leastpilot approve <digest>` from the same person runs the agent under that
   exact mandate. [review/action.yml](review/action.yml) posts the review, and
   the main Action's `approved-digest` and `approval` inputs run it.
3. Reviews run one at a time per repository, so the hourly limit holds.

There is also an [Action](action.yml) and an
[example workflow](.github/workflows/leastpilot.yml). Both Actions build LeastPilot
from source on every run, because the CLI is not published yet. That adds
about a minute to a run, and it is why `uses: pkravella/mandate@<sha>` works
from another repository. pnpm itself is pinned by hash, which corepack checks. The workflow sets
`permissions: {}` and the Action refuses to run if it finds a `GITHUB_TOKEN`,
because a second credential is authority no mandate bounds.

The Action takes the agent command **one argument per line**:

```yaml
agent: |
  claude
  --mcp-config
  {mcpConfig}
  -p
  Fix issue 42 and open a pull request.
```

That shape is deliberate. A single string would have to be word-split by the
shell, and a value reaching a shell from a workflow input is the classic
injection route — the first version of this Action interpolated every input
into its script and was a remote shell for anyone who could set one. One
element per line means spaces inside a line are kept and nothing in a line is
ever interpreted. It is enforced by a test that reads `action.yml` and fails on
an interpolation inside a `run:` block.

Note what that does **not** protect: an issue title placed in the prompt is
still attacker-controlled text going to the model. LeastPilot's answer to that is
the mandate — an injected agent is bounded by what was granted — but the two
are different problems. [docs/threat-model.md](docs/threat-model.md) §5 says
what to do about it.

## Documentation

| | |
| --- | --- |
| [Quickstart](docs/quickstart.md) | Validate a mandate, run an agent under it |
| [Mandate format](docs/mandate-format.md) | Every field, and what the lints refuse |
| [Writing a ceiling](docs/ceiling-authoring.md) | The constrained Cedar profile, as a contract |
| [Enforced where](docs/enforced-where.md) | Which control bounds what, and what defeats each |
| [Threat model](docs/threat-model.md) | What holds, what is out of scope, what breaks it |
| [Audit log](docs/audit-log.md) | The signed session log: turning it on, checking it, its format, what it proves |
| [gh-aw export](docs/gh-aw.md) | A mandate as a GitHub Agentic Workflows workflow: what maps, what is refused, what enforces it |
| [Architecture](docs/architecture.md) | The package graph and why it is shaped that way |
| [Benchmark report](docs/benchmark-report.md) | Measured completion, authority cut, over-grant, and the denials an under-grant produces, rendered from [its results](docs/benchmark-results.json) |

## Three things worth knowing up front

**Enforcement never rests on a model's judgment.** A model *proposes* a
mandate. A deterministic validator decides whether it may be granted, and the
proof is a language-inclusion check over finite automata, not a policy engine
answering point queries about representative requests. A grant is a pattern, so
it denotes a *set* — and a point query proves nothing about the rest of that
set. When a mandate is refused, the refusal names the ceiling clause it
exceeded and a concrete counterexample it would have permitted.

**No single control enforces a whole mandate, and the gaps are documented.** A
GitHub App token cannot limit by branch or path. Every grant therefore records
which control enforces it, and
[docs/enforced-where.md](docs/enforced-where.md) states for each layer what it
bounds, what it does not, and what defeats it.

**LeastPilot does not detect prompt injection.** It limits what an injected agent
can do. That is a deliberate non-goal, along with being an identity provider, a
credential vault, or another MCP gateway.

## Build status

The v0.1 plan ran in four phases; the post-MVP plan continues from Phase 5.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Contract and ceiling: operation catalog, mandate schema, containment engine, Cedar ceiling, validator, lints | exit criterion **met** — 21/21 seeded over-grants rejected |
| 2 | Write and enforce: mandate writer, scoped GitHub App tokens, MCP proxy, argument enforcement, permission diff | exit criterion **met** — see below |
| 3 | Runtime and measurement: action graph, destination rules, egress sandbox, widen flow, replay evaluator, benchmark | built; exit criterion **not met as written** — it asks for 50 tasks and the corpus has 6 |
| 4 | Adversarial testing and launch: the attack corpus, `leastpilot run`, packaging, docs | exit criterion **met** — zero ceiling breaches across 34 adversarial cases |
| 5 | Make the trust story true: the agent in the sandbox, destination extraction, requester and ceiling identity, the token clock, `max` | exit criterion **met** — every security property the docs assert is exercised by a test, threat-model §3 is shorter, and no module is tested but unreachable |
| 6 | Make the numbers mean something: the authority cut against a real baseline, under-granting made observable, write latency | exit criterion **met** — every figure in the report is measured on the corpus it names or labelled, and a test re-renders the report from its committed results; the derived 50-task corpus is not started (budget) |

Phase 5 closed the distance between what the docs claimed and what the shipped
path did, and most of what it fixed was found by probing rather than planned:
an agent could leave the sandbox over IPv6; destination extraction read
`https://github.com@evil.example.com/` as github.com, missed `HTTPS://` and
`../` traversal, and never saw the one destination field the real server has (a
fork's `organization`); the CLI printed a ceiling name chosen by the mandate's
writer; a mandate could name any requester; and `max: 1` on `issue.create` let
three issues through when updates were also granted. It also ran a real agent
in the sandbox for the first time, which found that no agent image could be
built on the base image at all.

Phase 6 made the published numbers checkable. The first sweep had kept neither
its mandates nor its results, and called a one-repository figure an org-wide
baseline; a sweep now commits `results.json` beside the report, and a test
re-renders the report from it. The authority cut is reported against one
repository and against the 63 a developer's own token reaches. Each mandate is
run twice — with tools filtered, as the product runs, and with every tool
offered and refused on call — which is what finally made an under-grant show
up as a denial. Grading had been crediting an earlier sweep's pull request and
borrowing the mandate's own token; a task's acceptance command, which runs the
agent's own code, ran on the host with the App key readable, and now runs in a
container with neither. Two fresh reviewers then checked the phase and found no
Critical issue.

Writing a mandate costs about **$0.03** and misses the PRD's under-ten-second
target. Phase 6 measured the lever: six tasks written again at effort `medium`
gave mandates identical to `high`'s, facet by facet. On the five tasks written
at both settings, every `medium` write was faster -- a median of **10.4
seconds** against 11.7 (10.2 across all six) -- so `medium` is now the
default. Lowering only the second call changed three mandates in five. The
remaining cost is two sequential model calls
([writer-effort-results.json](docs/writer-effort-results.json)).

Phase 2's exit criterion was *"an agent fixes a real issue end to end under a
mandate, and an attempted merge is blocked."* Run against a throwaway
repository seeded with a `retry()` that swallowed its last error: the agent read
the file, branched to `agent/issue-1-rethrow-last-error`, replaced the swallow
with `throw lastError`, added a regression test asserting the last error
specifically, and opened a pull request. Six turns, $0.23. The merge attempt
came back refused with `clause: mandate.grants`. Ten proxy decisions, one
denial, and that denial was the merge.

Phase 4 added the attack corpus and the commands. The adversarial suite was 34
cases (42 since Phase 5 added eight destination cases) across four families — injected issue text, hostile MCP tool
declarations, over-asking agent plans, argument-level escapes — each paired with
the invariant it must not break. Every case assumes a **fully compromised
writer** that proposed exactly what the attack asked for, because LeastPilot does
not detect prompt injection: the question is only whether the ceiling held
anyway. It did, and the suite found three holes in the process, all closed.

`leastpilot run` was verified live. An agent importing nothing from this
repository was handed an MCP config, spawned what it named, and was offered
exactly `get_file_contents`, `list_branches` and `search_code` — three tools
from a single `repo.read` grant, with no write tool and no merge. Calling
`merge_pull_request` by name came back refused with `clause: mandate.grants`.
The requester's level was read from GitHub rather than asserted, so that run is
an authorisation record.

That second check is a **negative control**, and it exists because of what
Phase 3 measured: the proxy filters `tools/list`, so an ungranted tool is never
offered and therefore never attempted. Across six mandated benchmark runs there
were **zero denials while replay predicted seven under-granted calls**. A clean
run can mean the mandate was right or that nothing ever tested it, and the two
look identical from the outside — so the suite calls the forbidden tool by name
rather than waiting for a model to try.

Phase 3 added the runtime half and measured it; Phase 6 re-ran the sweep with
each mandate in both tool-visibility modes. The full
[benchmark report](docs/benchmark-report.md) is committed; the headline is:

| Metric | Result | v0.1 target |
| --- | --- | --- |
| Task completion (either mode) | 83.3% | at least 90% |
| Authority cut, token layer, against 1 repository | 32.3% | at least 80% |
| Authority cut, proxy layer, against 1 repository | **87.1%** | at least 80% |
| Authority cut, token layer, against 63 repositories | 98.9% | at least 80% |
| Authority cut, proxy layer, against 63 repositories | 99.8% | at least 80% |
| Over-grant | **0.0%** | under 10% |
| False pauses, tools filtered | 0.0% — nothing was attempted, so nothing paused | under 5% |
| False pauses, every tool offered | 66.7% — 4 of 6 runs, 3 of which still completed | under 5% |
| Write latency | 13,010 ms at effort `high`; ~10.2 s at `medium`, now the default | under 10 s |

Two caveats the report states at length and this table cannot: the corpus is
**6 tasks, not the 50** Phase 3's exit criterion asks for, and those tasks are
**synthetic**, so the completion figure is optimistic.

The authority cut is reported against two baselines and neither is the figure.
One repository is the conservative one. Sixty-three is what the developer's own
token reaches, which is the PRD's comparison, and nearly all of that cut is
repository scoping that any token limited to one repository gets without
LeastPilot. What LeastPilot adds per repository is 31 operations to 21 at the token
and to 4 at the proxy.

**The finding worth reading the report for.** With tools filtered, as the
product runs, the proxy issued **zero denials** across six runs while replay
predicted **seven under-granted calls**. Filtering `tools/list` means a tool no
grant reaches is never offered, so it is never attempted — R10's promise that
every pause names the clause it hit is true and *vacuous where there is no
pause*.

So the benchmark also runs each mandate with **every tool offered** and refused
on call. That produced five denials, and they split two ways. Four were
`issue_read`, three of them on tasks that finished anyway: the agent already had
the issue text, so most of the "seven predicted" were redundant calls, not
mandates too narrow.
The fifth is the real one: the triage agent tried `add_issue_comment`, was
refused, and could not report what it found. None of the five could be fixed by
a widen, which may not add an operation, so "widen requests" stays at zero by
design and the useful count is denials that need a new mandate. One run per mode
per task; the report says how noisy that is.

### Packages

The dependency graph is a DAG with the validator as its waist. Everything
upstream of it is untrusted; everything downstream takes only a
`ValidatedMandate`, whose constructor the validator owns.

| Package | Responsibility |
| --- | --- |
| `@leastpilot/catalog` | 46 GitHub operations, each tying together LeastPilot's action atom, the REST route, the `github-mcp-server` tool name, and the GitHub App permission a token needs. Pure data. |
| `@leastpilot/schema` | The mandate contract, canonical hashing, the ceiling digest, and the `ValidatedMandate` brand. |
| `@leastpilot/validator` | Glob-set containment by DFA inclusion, the constrained Cedar ceiling profile, the two-layer subset proof, and the R4 lints. |
| `@leastpilot/writer` | The one model-driven component, and untrusted. Covers from the catalog, prunes, and emits a `ProposedMandate` that only `validate()` accepts. Runs both calls at effort `medium`, by measurement. |
| `@leastpilot/compiler` | Mints a repository-scoped GitHub App token and revokes it, and compiles the mandate into proxy rules — capped to end before the token does — plus the token-versus-proxy enforcement report and the gh-aw export. |
| `@leastpilot/proxy` | An MCP server facing the agent and an MCP client facing `github-mcp-server`. Filters `tools/list` (or, in the benchmark's measurement mode only, offers every tool and refuses on call), checks every call's repository, branch, base, paths, destinations and count, records every decision as an action graph, and turns a denial into a clause and a reviewable widen request. Writes and verifies the signed audit log. |
| `@leastpilot/replay` | Scores a mandate by replaying a recorded action graph through the production argument enforcer, reporting over-grant, under-grant, and which operations a task needed that the mandate lacked. |
| `@leastpilot/cli` | `leastpilot validate`, `widen`, `serve`, `run` (with `--sandbox`: the workspace clone, the container launch and the relay listener) `audit keygen`/`verify` and `export gh-aw`, the permission diff, the rejection report, and the enforced session the CLI and the benchmark share. |
| `@leastpilot/bench` | Private. The benchmark corpus loader, the seeder, the harness (each mandated run with tools filtered and with every tool offered; acceptance in a locked-down container), the writer-effort sweep, and the report renderer. |

**The egress sandbox is the layer that actually holds.** An MCP proxy sees MCP
traffic and nothing else, so an agent with a shell, a `git push` to a remote it
configures itself, or a `curl` never transits it. [`sandbox/`](sandbox/README.md)
is a container whose only route out is a `CONNECT` proxy allowlist compiled from
the mandate's destinations, with `iptables` rejecting everything else from the
agent's uid, over IPv4 and IPv6. `leastpilot run --sandbox` runs the agent in it,
with no GitHub credential inside — the token stays with `leastpilot serve` on the
host — and a clone of HEAD for a working copy. It verifies itself, including
negative controls that widen the allowlist and strip the firewall rules to
confirm the checks can fail, and it exits rather than starting the agent if it
cannot install the rules. macOS with Docker Desktop for now.

**Running the proxy needs the right upstream toolsets.** `github-mcp-server`
exposes 46 tools by default and 91 with `GITHUB_TOOLSETS=all`. Six catalog
operations name tools in the non-default sets, so granting `actions.read`
against a default server reaches nothing — and because the proxy only offers
tools the upstream advertises, the agent never sees it and the task fails with
nothing explaining why. `TOOLSET_REQUIRED` in the catalog names the toolset each
one needs, and `unreachableOperations()` reports the gap for a running server.

The npm scope is `@leastpilot` because `@mandate` is already taken; the CLI
binary is still `mandate`. The project name is provisional pending a trademark
check.

<a id="not-built"></a>
## Not built in v0.1

Stated here rather than left to be discovered.

**R5 has no auto-approval.** There is no template library (R13) for an
auto-approval policy to name. The review flow itself,
[examples/workflows/leastpilot-review.yml](examples/workflows/leastpilot-review.yml),
has run end to end in a private test repository:
1. A `/leastpilot` comment produced a review.
2. The App's own reply re-triggered the workflow, and that run was skipped.
3. The requester's approval ran the agent under that exact mandate.

**No `app:` requesters.** A mandate requested by an automation account is
refused: GitHub reveals what another App may do only to that App, so LeastPilot
has no source for an app principal's authority, and borrowing the operator's
would attribute the request to the automation while a person's level bounded
it. `requestedBy` must name the user checked with `--as`.

**One of R12's four backends.** `leastpilot export gh-aw` is built (see below).
The Docker MCP Gateway, Cedar/AgentCore and OPA exports are not. Shipping four
half-implemented backends would be four things that look supported and are not.

**The audit log has no outside witness, and the Action does not write one.** A
log with no seal was killed or truncated, and nothing in the file can tell
which. Without `--sandbox` the agent can read the audit key, so the signature
proves nothing against it, and that includes the Action. See
[docs/audit-log.md](docs/audit-log.md).

**Thirteen catalog operations no MCP tool reaches**, so the proxy is not in the
way of them at all. Most are classed `forbidden` and the lints reject them,
which is the real mitigation. `branch.delete` is the sharp one.

**The corpus is six synthetic tasks, not fifty derived ones.** A 50-task sweep
in both modes is now estimated at about $14 — the agent loop caches its prompt —
plus recording ground truth for each new task, against a whole budget of $10
that Phase 6's measurements nearly used up. The corpus schema
records `synthetic` as a provenance that cannot imply attribution it lacks, and
`loadCorpus` reports the shortfall as a number so nothing can present six as
fifty.

**The sandbox is macOS and Docker Desktop only.** On Linux the relay needs
`host-gateway` and serve would have to bind the bridge address; that path has
never been run, so `--sandbox` refuses there rather than claim it.

**`max` limits a session, not a task.** A new session starts the count at zero —
with `--sandbox` only the operator can start one, without it the agent can, by
restarting its MCP server — and where operations share a tool and a call cannot
say which it is, their limits combine. [docs/mandate-format.md](docs/mandate-format.md)
has the exact rule.

**A zero false-pause count is not evidence.** The proxy filters `tools/list`, so
an ungranted tool is never offered and therefore never attempted — measured,
zero denials across six mandated runs while replay predicted seven under-granted
calls. The benchmark's measurement mode, which offers every tool and refuses on
call, surfaced the real one: the triage agent's refused `add_issue_comment`.
[docs/threat-model.md](docs/threat-model.md) §3.3 explains why this matters more
than it sounds.

## Development

```bash
pnpm install
pnpm typecheck   # solution build, then typecheck the test files
pnpm lint        # includes the trust-boundary rules
pnpm test
pnpm build
```

Requires Node 22.12 or newer. **1,080 tests run offline with no credentials**, and
that is what CI runs. Rebuild with the root `pnpm build`: the packages have no
build script of their own, so `pnpm --filter <pkg> build` exits 0 having done
nothing.

Fifty-two more are gated, each behind its own variable, because they spend
money, mint real credentials, write to a real repository, or need Docker. CI
never runs any of them and needs no secrets.

| Gate | What it does | Cost |
| --- | --- | --- |
| `LEASTPILOT_LIVE=1` | The writer against the live model, token minting against a real GitHub App, and the whole loop end to end | ~$0.03 to ~$0.30 |
| `LEASTPILOT_SANDBOX=1` | Builds the sandbox and verifies its egress, the relay to `leastpilot serve`, and `leastpilot run --sandbox` end to end (the last two on macOS), and the benchmark's acceptance container, each with negative controls | free, needs Docker |
| `LEASTPILOT_SEED=1` | Seeds the benchmark corpus into the bench repository — **writes to its default branch and opens issues** | free |
| `LEASTPILOT_GROUND_TRUTH=1` | Re-records the benchmark's ground-truth traces, **overwriting the committed ones** | ~$3 |
| `LEASTPILOT_BENCH=1` | The mandated sweep and the report: each task's mandated run with tools filtered and with every tool offered | ~$1.80 for six tasks |
| `LEASTPILOT_WRITER_SWEEP=1` | Writes each task's mandate again at several effort settings and compares it with the published one | ~$0.03 a write |

The credential-backed gates also need `ANTHROPIC_API_KEY`, `LEASTPILOT_APP_ID`,
`LEASTPILOT_INSTALLATION_ID`, `LEASTPILOT_APP_KEY_PATH` and `LEASTPILOT_TEST_REPO`. See
[CONTRIBUTING.md](CONTRIBUTING.md) — in particular the one rule that is not
negotiable.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
