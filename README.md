# Mandate

Task-scoped authority for AI agents.

Mandate gives each agent task its own authority and enforces it, before and
during execution, with one artifact. From a request like *"Fix issue #42 and
open a PR"* it writes a **mandate**: the resources, actions, argument limits,
allowed data destinations and expiry that the task needs. A deterministic
validator proves the mandate grants nothing beyond what the user and the
organization already allow. Mandate then compiles it into controls GitHub and
MCP gateways already enforce, and watches the run against it.

> **Status: v0.1. The loop runs end to end from one command, and is measured —
> but three of the seven headline metrics miss their target and the corpus is
> six tasks rather than fifty.** A model writes a mandate, the validator proves
> it against a Cedar ceiling and a destination allowlist, a repo-scoped GitHub
> App token is minted, and `mandate run` launches an agent whose only route to
> GitHub is the enforced proxy. Every decision is recorded as an action graph,
> and a replay evaluator scores mandates against traces of unconstrained runs.
>
> What is measured and what is missed: the
> [benchmark report](docs/benchmark-report.md), which states its own shortfalls
> before any metric. What is not built: [below](#not-built).

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
makes the output an authorisation record. It needs `MANDATE_APP_ID`,
`MANDATE_INSTALLATION_ID` and `MANDATE_APP_KEY_PATH`; the token it mints carries
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
clause and a counterexample, 2 means the input could not be read.

A paused call can be re-reviewed with more scope. `mandate widen` takes the
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

`mandate serve` is an MCP server that enforces one mandate. `mandate run`
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

`{mcpConfig}` becomes the config path, and `MANDATE_MCP_CONFIG` is set in the
agent's environment, so an agent that takes a flag and one that reads the
environment both work.

Mandate does not drive a particular agent. Every MCP client already knows how to
start a server from a config, so *being* that server is the whole integration —
which is also what makes vendor neutrality true rather than aspirational. The
cost of that choice: Mandate bounds the authority it mints, and cannot bound an
agent holding a credential of its own. That is the sandbox's job, and
[docs/threat-model.md](docs/threat-model.md) §3.1 says so.

Nothing is minted and no agent is launched until the mandate validates. The
config the agent reads carries no credential: `mandate serve` mints its own
token in its own process.

There is also an [Action](action.yml) and an
[example workflow](.github/workflows/mandate.yml). The workflow sets
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
still attacker-controlled text going to the model. Mandate's answer to that is
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
| [Architecture](docs/architecture.md) | The package graph and why it is shaped that way |
| [Benchmark report](docs/benchmark-report.md) | Measured completion, authority cut, over-grant |

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

**Mandate does not detect prompt injection.** It limits what an injected agent
can do. That is a deliberate non-goal, along with being an identity provider, a
credential vault, or another MCP gateway.

## Build status

The v0.1 plan runs in four phases.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Contract and ceiling: operation catalog, mandate schema, containment engine, Cedar ceiling, validator, lints | exit criterion **met** — 21/21 seeded over-grants rejected |
| 2 | Write and enforce: mandate writer, scoped GitHub App tokens, MCP proxy, argument enforcement, permission diff | exit criterion **met** — see below |
| 3 | Runtime and measurement: action graph, destination rules, egress sandbox, widen flow, replay evaluator, benchmark | built; exit criterion **not met as written** — it asks for 50 tasks and the corpus has 6 |
| 4 | Adversarial testing and launch: the attack corpus, `mandate run`, packaging, docs | exit criterion **met** — zero ceiling breaches across 34 adversarial cases |

Phase 2's exit criterion was *"an agent fixes a real issue end to end under a
mandate, and an attempted merge is blocked."* Run against a throwaway
repository seeded with a `retry()` that swallowed its last error: the agent read
the file, branched to `agent/issue-1-rethrow-last-error`, replaced the swallow
with `throw lastError`, added a regression test asserting the last error
specifically, and opened a pull request. Six turns, $0.23. The merge attempt
came back refused with `clause: mandate.grants`. Ten proxy decisions, one
denial, and that denial was the merge.

Writing a mandate costs about **$0.03** and takes **12 seconds** at the median,
which misses the PRD's under-ten-second target. Two sequential model calls at
effort `high` is why, and effort is the lever.

Phase 4 added the attack corpus and the commands. The adversarial suite was 34
cases (42 since Phase 5 added eight destination cases) across four families — injected issue text, hostile MCP tool
declarations, over-asking agent plans, argument-level escapes — each paired with
the invariant it must not break. Every case assumes a **fully compromised
writer** that proposed exactly what the attack asked for, because Mandate does
not detect prompt injection: the question is only whether the ceiling held
anyway. It did, and the suite found three holes in the process, all closed.

`mandate run` was verified live. An agent importing nothing from this
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

Phase 3 added the runtime half and measured it. The full
[benchmark report](docs/benchmark-report.md) is committed; the headline is:

| Metric | Result | v0.1 target |
| --- | --- | --- |
| Task completion | 83.3% | at least 90% |
| Authority cut, token layer | 32.0% | at least 80% |
| Authority cut, proxy layer | **87.0%** | at least 80% |
| Over-grant | **0.0%** | under 10% |
| Write latency | 11,915 ms | under 10 s |

Two caveats the report states at length and this table cannot: the corpus is
**6 tasks, not the 50** Phase 3's exit criterion asks for, and those tasks are
**synthetic**, so the completion figure is optimistic.

**The finding worth reading the report for.** The proxy issued **zero denials**
across all six runs while replay predicted **seven under-granted calls**.
Filtering `tools/list` means a tool no grant reaches is never offered, so it is
never attempted — R10's promise that every pause names the clause it hit is true
and *vacuous where there is no pause*. An under-grant surfaces as a silent
workaround or a silent failure instead. The triage task is the clean case: seven
allowed reads, zero denials, and a failure, because the mandate granted no
`issue.comment` and the agent had no way to report what it found.

### Packages

The dependency graph is a DAG with the validator as its waist. Everything
upstream of it is untrusted; everything downstream takes only a
`ValidatedMandate`, whose constructor the validator owns.

| Package | Responsibility |
| --- | --- |
| `@mandate-dev/catalog` | 46 GitHub operations, each tying together Mandate's action atom, the REST route, the `github-mcp-server` tool name, and the GitHub App permission a token needs. Pure data. |
| `@mandate-dev/schema` | The mandate contract, canonical hashing, the ceiling digest, and the `ValidatedMandate` brand. |
| `@mandate-dev/validator` | Glob-set containment by DFA inclusion, the constrained Cedar ceiling profile, the two-layer subset proof, and the R4 lints. |
| `@mandate-dev/writer` | The one model-driven component, and untrusted. Covers from the catalog, prunes, and emits a `ProposedMandate` that only `validate()` accepts. |
| `@mandate-dev/compiler` | Mints a repository-scoped GitHub App token and revokes it, and compiles the mandate into proxy rules — capped to end before the token does — plus the token-versus-proxy enforcement report. |
| `@mandate-dev/proxy` | An MCP server facing the agent and an MCP client facing `github-mcp-server`. Filters `tools/list`, checks every call's repository, branch, base, paths, destinations and count, records every decision as an action graph, and turns a denial into a clause and a reviewable widen request. |
| `@mandate-dev/replay` | Scores a mandate by replaying a recorded action graph through the production argument enforcer, reporting over-grant, under-grant, and which operations a task needed that the mandate lacked. |
| `@mandate-dev/cli` | The permission diff, the rejection report, `mandate validate` and `mandate widen`. |
| `@mandate-dev/bench` | Private. The benchmark corpus loader, the seeder, the two-pass harness and the report renderer. |

**The egress sandbox is the layer that actually holds.** An MCP proxy sees MCP
traffic and nothing else, so an agent with a shell, a `git push` to a remote it
configures itself, or a `curl` never transits it. [`sandbox/`](sandbox/README.md)
is a container whose only route out is a `CONNECT` proxy allowlist compiled from
the mandate's destinations, with `iptables` rejecting everything else from the
agent's uid, over IPv4 and IPv6. `mandate run --sandbox` runs the agent in it,
with no GitHub credential inside — the token stays with `mandate serve` on the
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

The npm scope is `@mandate-dev` because `@mandate` is already taken; the CLI
binary is still `mandate`. The project name is provisional pending a trademark
check.

<a id="not-built"></a>
## Not built in v0.1

Stated here rather than left to be discovered.

**No GitHub App webhook service.** The plan had an App that subscribed to
`issue_comment`, wrote a mandate on `/mandate <task>`, and posted the permission
diff with an approval checkbox. It is not built, for two reasons. It needs
persistent state that nothing in this project has — "approval recorded against
`mandateHash`" is a database — and more importantly it would spend money writing
a mandate in response to **untrusted input**, since any commenter could trigger
it. The PRD's own R2 is that task text arrives from an authorized source, and a
drive-by comment is not one. Half of it, shipped, would look like the reviewed
approval flow R5 describes while being neither reviewed nor authorized.

The CLI half of R5 — the permission diff — is built and is what `--diff` prints.

**No `app:` requesters.** A mandate requested by an automation account is
refused: GitHub reveals what another App may do only to that App, so Mandate
has no source for an app principal's authority, and borrowing the operator's
would attribute the request to the automation while a person's level bounded
it. `requestedBy` must name the user checked with `--as`.

**R12's other backends and R16's audit log are interfaces only.** `Backend` in
`compiler/src/rules.ts` and `GraphSink` in `proxy/src/graph.ts` are the seams
the Docker MCP Gateway, Cedar/AgentCore, OPA and gh-aw exports and a signed
append-only log slot into. Shipping four half-implemented backends would be four
things that look supported and are not.

**Thirteen catalog operations no MCP tool reaches**, so the proxy is not in the
way of them at all. Most are classed `forbidden` and the lints reject them,
which is the real mitigation. `branch.delete` is the sharp one.

**The corpus is six synthetic tasks, not fifty derived ones.** A 50-task sweep
costs about $45 and this project's whole budget was $10. The corpus schema
records `synthetic` as a provenance that cannot imply attribution it lacks, and
`loadCorpus` reports the shortfall as a number so nothing can present six as
fifty.

**A zero false-pause count is not evidence.** The proxy filters `tools/list`, so
an ungranted tool is never offered and therefore never attempted — measured,
zero denials across six mandated runs while replay predicted seven under-granted
calls. [docs/threat-model.md](docs/threat-model.md) §3.3 explains why this
matters more than it sounds.

## Development

```bash
pnpm install
pnpm typecheck   # solution build, then typecheck the test files
pnpm lint        # includes the trust-boundary rules
pnpm test
pnpm build
```

Requires Node 22 or newer. **830 tests run offline with no credentials**, and
that is what CI runs.

Twenty-five more are gated, each behind its own variable, because they spend
money, mint real credentials, or write to a real repository. CI never runs any
of them and needs no secrets.

| Gate | What it does | Cost |
| --- | --- | --- |
| `MANDATE_LIVE=1` | The writer against the live model, token minting against a real GitHub App, and the whole loop end to end | ~$0.03 to ~$0.30 |
| `MANDATE_SANDBOX=1` | Builds the egress container and verifies it, with negative controls | free, needs Docker |
| `MANDATE_SEED=1` | Seeds the benchmark corpus into the bench repository — **writes to its default branch and opens issues** | free |
| `MANDATE_GROUND_TRUTH=1` | Re-records the benchmark's ground-truth traces, **overwriting the committed ones** | ~$3 |
| `MANDATE_BENCH=1` | The mandated sweep and the report | ~$1.15 |

The credential-backed gates also need `ANTHROPIC_API_KEY`, `MANDATE_APP_ID`,
`MANDATE_INSTALLATION_ID`, `MANDATE_APP_KEY_PATH` and `MANDATE_TEST_REPO`. See
[CONTRIBUTING.md](CONTRIBUTING.md) — in particular the one rule that is not
negotiable.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
