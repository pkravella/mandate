# Mandate

Task-scoped authority for AI agents.

Mandate gives each agent task its own authority and enforces it, before and
during execution, with one artifact. From a request like *"Fix issue #42 and
open a PR"* it writes a **mandate**: the resources, actions, argument limits,
allowed data destinations and expiry that the task needs. A deterministic
validator proves the mandate grants nothing beyond what the user and the
organization already allow. Mandate then compiles it into controls GitHub and
MCP gateways already enforce, and watches the run against it.

> **Status: mid-build, not yet usable.** The contract format and the validator
> work and are tested. There is no CLI yet, and nothing mints credentials or
> intercepts calls. See [Build status](#build-status).

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
| 1 | Contract and ceiling: operation catalog, mandate schema, containment engine, Cedar ceiling, validator, lints | exit criterion **met** — 21/21 seeded over-grants rejected. The CLI and permission diff are still outstanding. |
| 2 | Write and enforce: mandate writer, scoped GitHub App tokens, MCP proxy | not started |
| 3 | Runtime and measurement: action graph, destination rules, pause and widen, replay evaluator, 50-task benchmark | not started |
| 4 | Adversarial testing and launch | not started |

### Packages

| Package | Responsibility |
| --- | --- |
| `@mandate-dev/catalog` | 46 GitHub operations, each tying together Mandate's action atom, the REST route, the `github-mcp-server` tool name, and the GitHub App permission a token needs. Pure data. |
| `@mandate-dev/schema` | The mandate contract, canonical hashing, and the `ValidatedMandate` brand. |
| `@mandate-dev/validator` | Glob-set containment by DFA inclusion, the constrained Cedar ceiling profile, the two-layer subset proof, and the R4 lints. |

The npm scope is `@mandate-dev` because `@mandate` is already taken; the CLI
binary is still `mandate`. The project name is provisional pending a trademark
check.

## Development

```bash
pnpm install
pnpm typecheck   # solution build, then typecheck the test files
pnpm lint        # includes the trust-boundary rules
pnpm test
```

Requires Node 22 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md) — in
particular the one rule that is not negotiable.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
