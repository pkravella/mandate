# Threat model

What Mandate defends against, what it does not, and what breaks it. This is
written to be useful to someone deciding whether to trust it, which means the
limits are stated as plainly as the guarantees.

Measurements in this document come from v0.1 and are reproducible offline unless
marked otherwise. The benchmark numbers they rest on are in
[benchmark-report.md](benchmark-report.md), which states its own shortfalls
before any metric.

---

## 1. The attacker Mandate is for

**An agent whose context has been injected, running with a mandate-minted
token.**

The agent is not malicious code. It is a model that has read something — an
issue body, a file, a tool description, a dependency's README — that told it to
do something other than its task. It then tries to do that, using the tools it
has.

This is the realistic case and it is the only one Mandate claims to bound.
Mandate **does not detect prompt injection**; that is an explicit PRD non-goal.
It assumes the injection worked. Every test in `fixtures/adversarial/` therefore
simulates a *fully compromised writer* — one that proposed exactly what the
injected text demanded — and asks only whether the deterministic layers refused
it anyway. The question is never "did the model notice?"

**What holds against this attacker:**

| | |
| --- | --- |
| It cannot grant itself anything | `ValidatedMandate`'s constructor is private to the validator. The writer's output is typed `ProposedMandate` and exactly one function accepts it. This is a compile-time property, not a convention. |
| It cannot exceed the ceiling | Containment is a glob→DFA language-inclusion check, not a policy engine answering point queries. A grant is a *pattern*, so it denotes a set, and a point query proves nothing about the rest of that set. |
| It cannot exceed the requester's own authority | Decided separately and reported separately, from the requester's real GitHub permission. |
| It cannot see tools it was not granted | The proxy filters `tools/list`. Measured: 46 tools to 7, which is also an 84% cut in tool-schema tokens. |
| It cannot reach a repository, branch, path or base outside the grant | Enforced per call at the proxy, with the clause named on refusal. |
| It cannot write a default branch | No mandate may grant it, and the lints reject one that tries. |
| It cannot widen its own mandate | A widen re-validates the whole mandate from scratch, may only union patterns onto a grant already held, and **may not introduce an operation**. The refusal list is a shared definition, so the surface that offers and the command that applies read the same rule. |
| It cannot send repository data to an undeclared destination | Checked on destination-bearing argument fields: URLs of any scheme, read the way an HTTP client reads them; git's scp-style remotes; and the organization a fork goes to. A value in such a field that cannot be read as a destination is refused, not skipped. The validator and the proxy share one predicate; the sandbox's egress compiler applies the same rule and tests hold the two in step. |
| It cannot exhaust the validator or the proxy | A work budget across the whole `validate()` call and a per-call path cap. Both are rejections, because "reject on any doubt" includes doubt about termination. |

---

## 2. What is out of scope, and why

These are not oversights. Each is a decision with a reason.

**A malicious operator.** Whoever runs `mandate validate` chooses the ceiling
file. `loadCeiling` labels that file with the id the *mandate* declares, so an
operator can point it at a permissive policy and the output will say
`org-policy@v12`. Containment is still proved against the file actually given,
so this mislabels rather than over-grants — but an operator who wants to grant
more does not need to attack Mandate, they can edit the ceiling. Defending
against the person holding the ceiling is a different product (a hosted broker,
which is the paid half of the business model).

**A compromised GitHub App private key.** It mints tokens directly. Nothing in
Mandate is between an attacker with that key and the installation's full
authority. Protect it as the credential it is; v0.1 expects it on disk at mode
600.

**A malicious contributor to Mandate itself.** Supply-chain integrity of this
repository is out of scope. `ValidatedMandate`'s brand stops *model output* from
reaching the compiler; it does nothing about a commit.

**A model's judgment as a control.** Mandate never asks a model whether an
action is in scope. Intent checkers that do can be talked out of their answer,
and the PRD's position — a model may flag, never allow — is why R15's drift
monitor is P1 and absent rather than shipped and load-bearing.

**Data-flow tracking.** If the agent writes a URL into a source file and
something later executes it, Mandate does not see that. R14, P1. The sandbox is
the mitigation in v0.1.

---

## 3. What actually breaks it

The honest list. Each of these defeats Mandate today.

### 3.1 Another credential

**This is the big one.** Mandate bounds the authority *it* mints. An agent that
has a personal access token in its environment, a credential in
`.git/config`, a logged-in `gh` CLI, or an SSH key does not need the proxy and
never transits it.

The mitigation is R9b: run the agent in a sandbox whose only credential is the
minted token and whose only egress is the allowlist compiled from
`destinations.allow`. `sandbox/` ships that recipe and verifies itself over raw
sockets, with negative controls that widen the ACL and strip the firewall rules
to confirm the checks can actually fail — because a security control that is
never exercised is worse than none, since the docs assert it holds.

**Mandate's own launch path is one such credential today.** `mandate run`
starts the agent with the operator's environment, and the agent then spawns
`mandate serve` from its MCP config — so the agent's environment names
`MANDATE_APP_KEY_PATH`, and the agent runs as the user who can read that key.
An agent that reads it can mint a token for the App's whole installation. The
sandboxed launch (in progress) removes this: serve is started on the host by
`mandate run`, never by the agent, and the container's environment is built
from an allowlist.

**Without the sandbox, destination enforcement at the proxy is advisory.**
Decision D3 says so and [enforced-where.md](enforced-where.md) repeats it. The
example workflow sets `permissions: {}` and `persist-credentials: false`, and
the action fails if it finds a `GITHUB_TOKEN`, for exactly this reason.

### 3.2 The token is coarser than the mandate

A GitHub App installation token can be limited to a repository set and a
permission set, and nothing finer. It cannot limit by branch or by path. So a
mandate saying `contents.write on acme/api@agent/42-* except .github/workflows/**`
compiles to a token that can write **any branch and any path** in `acme/api`,
with the branch and path limits enforced only at the proxy.

This is why every grant carries `enforcedBy`, and why that is a required schema
field rather than prose: it keeps the audit log honest about the gap between
what a mandate says and what GitHub can actually refuse. The full table is in
[enforced-where.md](enforced-where.md).

### 3.3 Filtering is not refusing

The single most important finding of Phase 3, and it changes how the numbers
should be read.

The proxy filters `tools/list`, so an ungranted tool is never offered and
therefore never *attempted*. Measured across the six mandated benchmark runs:
**zero denials, while replay predicted seven under-granted calls.** R10's "every
pause names the clause it hit" is true and vacuous where there is no pause.

The clean case is the triage task: seven allowed reads, zero denials, and a
failure — because the mandate granted no `issue.comment` and the agent had no
way to report what it found. **A false-pause count of zero is not evidence a
mandate was the right size.**

### 3.4 Operations no MCP tool reaches

Thirteen catalog operations have no tool on `github-mcp-server`. A mandate
granting them gets a token carrying the permission, and nothing in the proxy is
in the way of the raw REST API. `branch.delete` is the sharp one. Most are
classed `forbidden` or `elevated` and the lints reject them, which is the real
mitigation.

### 3.5 Quotas reset, and a failed call still spends one

`max` counts per proxy process. Restart the proxy and the quota resets. A call
the enforcer allowed but that failed upstream still spends its quota, which is
the safe direction but not the intuitive one.

### 3.6 Mandate ids can collide

`slug()` truncates at 48 characters on a word boundary, so two tasks opening
with the same words share an id. `mandateHash` exists for this and the trace
header uses it; nothing else keys on the hash.

---

## 4. Trust boundaries

```
  task text, issue bodies, agent plans, tool descriptions
            │
            │   UNTRUSTED. Evidence, never authority.
            ▼
      ┌───────────┐
      │  writer   │  a model. Output is typed ProposedMandate.
      └─────┬─────┘
            │   ProposedMandate — accepted by exactly one function
            ▼
      ┌───────────┐
      │ validate  │  ◄── ceiling (operator) + requester's real GitHub level
      └─────┬─────┘      deterministic; rejects on any doubt
            │   ValidatedMandate — brand private to the validator
            ▼
   ┌────────┴────────┬──────────────┐
   ▼                 ▼              ▼
 token            proxy rules    egress policy
 (repo + perms)   (facets)       (allowlist)
```

Everything above `validate` is untrusted. Everything below consumes only a
`ValidatedMandate`. The line is enforced by the type system and by a lint rule
that keeps `ProposedMandate` out of every package but the writer and the
validator.

A plan is the clearest case: `WriteRequest.agentPlan` exists, and
`requestedBy`, `ceiling` and `expiresInMinutes` are taken from the request the
operator built. The propose tool has **no property** for any of them, so the
model cannot express them however convincingly a plan asks — and a test reads
the tool schemas actually sent to the model and fails if one appears.

---

## 5. What an operator should actually do

1. **Run the agent in the sandbox.** Everything in §3.1 depends on it, and it is
   the difference between "enforced" and "advisory" for destinations.
2. **Set `permissions: {}`** on the job, and `persist-credentials: false` on
   checkout. The action refuses to run with a `GITHUB_TOKEN` present.
3. **Use `--repo`, not `--level`.** `--level` is an assertion, labelled as one
   in every line of output that reports it. Only `--repo` makes the result an
   authorisation record.
4. **Read `enforcedBy` in the permission diff.** A grant marked `proxy` is not
   enforced by the token, so it does not survive the agent going around the
   proxy.
5. **Do not read a zero false-pause count as success.** See §3.3.
6. **Keep the App's permission set minimal.** The token can never be narrower
   than the installation; `actions` is deliberately absent from the
   development App, which is what makes the 422 path a test fixture.
7. **Never splice untrusted text into the agent's prompt.** An issue title or
   body passed through the Action's `agent` input reaches the model as
   instructions. Mandate bounds what an injected agent can *do*, which is the
   whole premise — but that is a different guarantee from the text not being
   injected in the first place, and conflating them is how an operator ends up
   surprised. Pass identifiers, and let the agent fetch the content through its
   granted read tools, where the fetch is recorded in the action graph.

   Separately: the Action takes `agent` as one argument per line and never lets
   a line reach a shell. That is a *shell* injection defence, not a prompt one.
   The first version of the Action interpolated every input into its script with
   `${{ }}`, which GitHub substitutes into the script text before bash sees it —
   so a value containing a semicolon ran as a command, and the example workflow
   fed issue text into exactly that path. A packaging layer whose purpose is
   bounding an agent's authority was a remote shell for anyone who could file an
   issue. A test now reads `action.yml` and fails on an interpolation inside a
   `run:` block.
