# Architecture

Nine packages, split along the trust boundary. The shape of the dependency
graph is the security argument, so it is worth reading before the code.

---

## The dependency graph is a DAG with the validator as its waist

```
catalog ← schema ← validator ← { writer, compiler, proxy, replay } ← cli ← bench
```

Nothing is circular and nothing reaches around the validator.

| Package | Does | Depends on nothing but |
| --- | --- | --- |
| `catalog` | ~47 GitHub operations: REST route, MCP tools, App permission, minimum user level, risk class, what each is constrainable by | — |
| `schema` | Mandate types, the Zod schema, canonical YAML and hash, the destination predicate, the widen contract, and `ValidatedMandate` | `catalog` |
| `validator` | Glob→DFA containment, the Cedar ceiling loader and cross-check, the lints, `validate()`, the user-authority lookup | `schema`, `catalog` |
| `writer` | A model proposes a mandate, cover-then-prune. **Untrusted** | `validator` (for the ceiling digest), `schema` |
| `compiler` | Mints a repo-scoped token, compiles proxy rules and the egress policy, reports what is enforced where | `validator`, `schema` |
| `proxy` | The MCP interceptor: tool filtering, per-call argument enforcement, explained pauses, the action-graph recorder | `compiler`, `validator`, `schema` |
| `replay` | Scores a mandate against a recorded trace: under- and over-grants | `proxy`, `schema` |
| `cli` | `validate`, `widen`, `serve`, `run`, the permission diff, the enforced session | all of the above |
| `bench` | The corpus, the seeder, the harness, the report | `cli` and the rest |

**`catalog` and `schema` are dependency-free** so they can be published as the
shared contract format the business model rests on. An organization adopting the
format should not have to take the validator with it.

**`validator` is the only package that imports `cedar-wasm`.** Swapping the
cross-check engine touches one package.

**`proxy` is deliberately separate from `compiler`** because they run at
different times and in different processes — before the run versus during it.

---

## The trust boundary is a type

```
  task text, issue bodies, agent plans, tool descriptions
            │  UNTRUSTED
            ▼
      ┌───────────┐
      │  writer   │  a model
      └─────┬─────┘
            │  ProposedMandate
            ▼
      ┌───────────┐   ◄── ceiling (operator, as data)
      │ validate  │   ◄── requester's real GitHub level
      └─────┬─────┘
            │  ValidatedMandate  ── brand private to the validator
            ▼
   ┌────────┴────────┬──────────────┐
   ▼                 ▼              ▼
 token            proxy rules    egress policy
```

`ValidatedMandate` is a branded type whose constructor is not exported. Only
`validate()` can produce one, and every consumer downstream accepts only that
type. So **"the model can never grant itself anything" is checked by the
compiler**, not by convention or review.

`ProposedMandate` is the writer's output type, accepted by exactly one
function. A lint rule keeps it out of every package but the writer and the
validator, so a future contributor cannot quietly add a second consumer.

Two consequences worth stating:

- A new enforcement backend (R12's OPA, AgentCore, Docker MCP Gateway, gh-aw)
  implements `Backend`, whose `compile` takes a `ValidatedMandate`. It therefore
  cannot become a second path by which model output reaches an enforcement
  surface. The interface is in `compiler/src/rules.ts`, interface-only in v0.1.
- A future audit sink (R16) implements `GraphSink`, whose `append` returns
  `Promise<void>`. It has no way to signal "do not allow this", so it cannot
  become a second enforcement point whose rules nothing validated. Interface in
  `proxy/src/graph.ts`, also interface-only.

---

## Containment is a pattern algebra, not a policy query

This is the one design decision everything else rests on.

A grant is a **pattern** — `contents.write on acme/api@agent/42-*` with deny
paths — so it denotes a *set* of concrete requests. Cedar's `isAuthorized`
answers a point question. Asking it once per grant with a representative
resource proves nothing about the rest of the set: a grant of `branch.create` on
`*` would pass a probe against `agent/42-foo` while also permitting `main`.

So:

1. Normalize each grant and each ceiling clause into
   `{ action, resources, branches, paths, base }` glob sets.
2. Compile each glob to an NFA, subset-construct to a DFA, and decide
   `L(inner) ⊆ L(outer)` by searching the product of inner and the complement
   of outer for a reachable accepting state.
3. A reachable accepting state **is the counterexample** — a concrete string the
   mandate would have permitted and the ceiling does not. That is exactly what
   the permission diff (R5) and the pause message (R10) need to print, which is
   why there is always one.

The glob language is kept tiny on purpose (literals, `*`, `**`, `**/`) so
inclusion stays decidable and cheap. Any other metacharacter is a parse error,
hence a refusal.

Cedar keeps two jobs: it is the authoring format for the ceiling, and it is an
**independent cross-check** — boundary witnesses replayed through
`isAuthorized`, where a Cedar denial of a witness the automata called contained
fails the run closed. Two representations that must agree is stronger than
either alone, and it catches extraction that is too *wide*, which is the
direction that over-grants.

Both layers are bounded. `MAX_DFA_STATES` caps a single automaton and a work
budget caps the whole `validate()` call, because "reject on any doubt" includes
doubt about termination. The budget is deterministic rather than a wall-clock
deadline: a validator whose verdict depends on how busy the machine is cannot be
something a mandate is proved against.

---

## Before the run, and during it

**Before:** write → validate → review → compile → mint.

The compiler emits three things from one `ValidatedMandate`: an installation
token scoped to the mandate's repositories and the permissions its grants need;
the proxy's rules for branches, paths, arguments and destinations; and the
sandbox's egress allowlist. One artifact decides all three, which is the
"merge" the PRD is named for — the policy that mints the token is the policy
that pauses the run.

**During:** the agent's only credential is that token, and its tool calls go
through the proxy.

```
agent ──MCP──► mandate serve ──MCP──► github-mcp-server ──REST──► GitHub
                    │
                    ├─ filters tools/list to what the mandate reaches
                    ├─ decides every call against the compiled rules
                    ├─ records every call as an action node (R8)
                    └─ refuses out of scope, naming the clause (R10)
```

`mandate serve` is an MCP server on stdio, which is what every MCP client
already knows how to spawn. That is the whole agent integration: no per-vendor
adapter, and `mandate run` just writes a config pointing at it and launches the
command the operator gives it.

The token is minted inside the `serve` process, so the config the agent reads
carries no credential.

**One enforced session, shared.** `openSession` in `cli/src/session.ts` does the
five steps — mint, compile, connect upstream, build the proxy, give the token
back — and both `mandate serve` and the benchmark harness call it. If they had
separate copies, the published numbers would describe something other than what
the command enforces.

---

## Measurement is part of the architecture

`replay` scores a mandate against a recorded trace, which is what makes
under- and over-granting a number rather than an opinion.

The trace format is a mode-tagged discriminated contract: an `ActionGraph`
carries `mode: "enforced" | "unconstrained"`, and the mandate id and hash are
present *only* when enforced, so an unconstrained trace cannot claim a mandate.
`parseJsonl` is strict and fails closed — an unknown line type, an unrecognised
field, a second header, a denial with no clause, an allow with no outcome, or
any gap or repeat in the sequence is a rejection rather than a dropped row. It
is the only place a file on disk becomes typed evidence the scorer acts on.

Ground-truth traces are recorded once and committed, because a trace does not
change when a mandate changes — so scoring is offline and free forever. A
sweep's own traces go to a gitignored directory: reproducible input is a
fixture, sweep output is not.

What the numbers mean, and what they do not, is in
[benchmark-report.md](benchmark-report.md), which states its own shortfalls
before any metric.

---

## What is not here

- **No second gateway.** The proxy sits in front of `github-mcp-server`; it does
  not replace it.
- **No identity provider, no credential vault.** GitHub App tokens, minted and
  revoked.
- **No model in any decision path.** The writer proposes; the validator decides.
  R15's drift monitor is P1 and absent rather than shipped and load-bearing.
- **No webhook service.** Task 20 planned a GitHub App that wrote a mandate on
  an issue comment. It is not built, and [the README](../README.md#not-built)
  says why.
