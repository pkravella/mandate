# Mandate

Task-scoped authority for AI agents.

Mandate gives each agent task its own authority and enforces it, before and
during execution, with one artifact. From a request like *"Fix issue #42 and
open a PR"* it writes a **mandate**: the resources, actions, argument limits,
allowed data destinations and expiry that the task needs. A deterministic
validator proves the mandate grants nothing beyond what the user and the
organization already allow. Mandate then compiles it into controls GitHub and
MCP gateways already enforce, and watches the run against it.

> **Status: the loop works end to end and is measured, but there is still no
> one-command way to run it.** A live model writes a mandate, the validator
> proves it against a Cedar ceiling and a destination allowlist, a real GitHub
> App token is minted for one repository, and the real `github-mcp-server` runs
> behind the proxy with the agent limited to the tools the mandate reaches. Every
> decision is recorded as an action graph, and a replay evaluator scores mandates
> against traces of unconstrained runs.
>
> The CLI has `mandate validate` and `mandate widen`. The full loop is still
> driven by a test harness rather than by `mandate run`, which does not exist.
> See [Build status](#build-status) and the
> [benchmark report](docs/benchmark-report.md).

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
  --as alice --repositories 20
```

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
  --as alice
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

`--level` is operator-supplied and trusted, so local output is not an
authorisation record: the real GitHub permission lookup is not wired in yet.

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
| 4 | Adversarial testing and launch | not started |

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
| `@mandate-dev/compiler` | Mints a repository-scoped GitHub App token, refreshes and revokes it, and compiles the mandate into proxy rules plus the token-versus-proxy enforcement report. |
| `@mandate-dev/proxy` | An MCP server facing the agent and an MCP client facing `github-mcp-server`. Filters `tools/list`, checks every call's repository, branch, base, paths, destinations and count, records every decision as an action graph, and turns a denial into a clause and a reviewable widen request. |
| `@mandate-dev/replay` | Scores a mandate by replaying a recorded action graph through the production argument enforcer, reporting over-grant, under-grant, and which operations a task needed that the mandate lacked. |
| `@mandate-dev/cli` | The permission diff, the rejection report, `mandate validate` and `mandate widen`. |
| `@mandate-dev/bench` | Private. The benchmark corpus loader, the seeder, the two-pass harness and the report renderer. |

**The egress sandbox is the layer that actually holds.** An MCP proxy sees MCP
traffic and nothing else, so an agent with a shell, a `git push` to a remote it
configures itself, or a `curl` never transits it. [`sandbox/`](sandbox/README.md)
is a container whose only route out is a `CONNECT` proxy allowlist compiled from
the mandate's destinations, with `iptables` rejecting everything else from the
agent's uid. It verifies itself — including negative controls that widen the
allowlist and strip the firewall rules to confirm the checks can fail — and it
exits rather than starting the agent if it cannot install the rules.

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

## Development

```bash
pnpm install
pnpm typecheck   # solution build, then typecheck the test files
pnpm lint        # includes the trust-boundary rules
pnpm test
pnpm build
```

Requires Node 22 or newer. **695 tests run offline with no credentials**, and
that is what CI runs.

Twenty-three more are gated, each behind its own variable, because they spend
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
