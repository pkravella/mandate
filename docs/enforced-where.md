# Enforced where

A mandate says more than any single control can enforce. This page says which
control enforces which part, what each one does **not** bound, and what defeats
it. R7 requires documenting this; keeping it honest is the point.

**Status column:** Mandate is mid-build. A row marked *planned* describes a
control that does not exist yet, and nothing in the repository enforces it
today.

| Control | Bounds | Does **not** bound | Defeated by | Status |
| --- | --- | --- | --- | --- |
| Mandate schema + validator | What may be granted at all: the operation set, pattern decidability, the organization ceiling, the requester's own permission level, the destinations data may reach | Anything at runtime — it decides before the agent starts | Nothing; it is deterministic and fails closed | **built** |
| GitHub App installation token | Repository set, permission set, one-hour lifetime | Branch, path, argument, call count | Nothing — but it is coarse by design, see below | **built** |
| Token revocation on run exit | Reuse of a leaked token, after a propagation delay | The ~4 s window measured below, and work already done | Using the token inside that window | **built** |
| MCP proxy | Tool set, branch, path, base, call count, destinations appearing in arguments | Anything not sent as an MCP call; 13 catalog operations no MCP tool reaches | An agent with a shell and another credential | **built** |
| Sandbox egress allowlist | All network egress from the `agent` user: the proxy is the only route out, and it tunnels only to an allowed host on 443 | Data sent to an **allowed** destination | Running the agent outside the sandbox, or starting it without `--cap-add=NET_ADMIN` (which the entrypoint refuses to do) | **built** |
| Mandate expiry | Call acceptance after `expiresAt` | Work already done | Nothing | **built** |
| GitHub rulesets (backstop) | Pushes to protected branches, required reviews | Anything outside branch rules | An admin token | planned |

## The asymmetry that matters

A GitHub App installation token can express a **repository set** and a
**permission set**, and nothing finer. It cannot limit by branch or by path.

So a mandate granting `contents.write` on `acme/api@agent/42-*` with
`denyPaths: [".github/workflows/**"]` compiles to a token with
`contents: write` **on the whole repository**. If the agent escapes the proxy,
that token can write `main` and workflow files.

The honest claim for v0.1 is therefore:

> The token bounds the repository and the permission set. The proxy bounds the
> branch, the path, the arguments and the destinations.

Every grant in a mandate carries an `enforcedBy` field for exactly this reason,
and a lint (`enforcement-overclaim`) rejects a grant that claims `token`
enforcement while carrying a branch or path limit — because that grant is
describing a control that does not exist.

This is also why the benchmark reports **authority cut twice**, once per layer.

## What minting actually does, measured

These are observations against the live GitHub API, not readings of the docs.

**Asking for more than the installation holds is refused, not trimmed.** A
token request naming a permission the installation was never granted comes back
`422 The permissions requested are not granted to this installation.`, and one
asking for `write` where the installation holds `read` comes back `422 The level
of access for permissions requested are not granted to this installation.`
Mandate surfaces GitHub's own wording, because the fix is either installing the
app with that permission or narrowing the mandate, and the message says which.

**Omitting the permission set asks for everything.** A request that sends
`repositories` but no `permissions` mints a token carrying *every* permission
the installation holds. Mandate therefore always sends an explicit permission
set and refuses to mint with an empty one — an absent set would be read as "all
of them", which is the opposite of what an empty one means.

**The repository list takes bare names.** `repositories: ["api"]`, not
`["acme/api"]`; a full name is refused as *"does not exist or is not accessible
to the parent installation"*, which reads like a permissions problem and is not
one. Because the owner has to be dropped, Mandate refuses a mandate whose grants
span two owners rather than let `acme/api` and `other/api` collapse to one name.

**Revocation is real but not instant.** `DELETE /installation/token` answers
`204` immediately and is idempotent, but the token kept working for **about two
to four seconds** afterwards. So revocation shortens the window in which a
leaked token is useful; it is not what ends the authority. That is the proxy
refusing every call past the mandate's `expiresAt`, which takes effect at once.

> Revoking a token is a cleanup, not a boundary. If you need a credential to
> stop working at a precise moment, the control is the proxy, not the token.

## Two blind spots in the proxy

Both are properties of the operation catalog, and both are reported per grant by
`enforcementReport` rather than left for someone to notice.

**Thirteen operations no MCP tool reaches.** `repo.delete`, `branch.delete`,
`branch.protect`, `secrets.read`, `secrets.write`, `variables.read`,
`environments.write`, `collaborators.read`, `collaborators.write`,
`webhooks.write`, `rulesets.write`, `deploy_keys.write` and `releases.write` have
no entry in the GitHub MCP server's tool set. The proxy sees MCP calls and
nothing else, so for these it can neither allow nor deny: the token is the only
control. `branch.delete` is the sharp case — a mandate granting it gets a token
with `contents: write`, and nothing stops the deletion over the raw REST API.
Most of these are classed `forbidden` or `elevated` and the R4 lints reject them
outright, which is the real mitigation.

**Destinations are enforced on fields, not on content.** R9a scans "every tool
call argument ... for destination-bearing fields (URLs, remotes, webhook
targets, fork owners)", and the field list is the operative part. A URL inside
a file's `content` or an issue `body` is **not** treated as a destination,
because writing `curl evil.example.com` into a source file sends nothing
anywhere — the bytes still travel to GitHub, an allowed destination. Treating
content as a destination would deny any commit touching a `package.json`, a
licence header or a document with a link in it, against a target of under 5%
false pauses, while blocking no actual exfiltration.

A URL written into the repository and *later executed* is a real risk. It is
the sandbox's (R9b) and taint tracking's (R14, P1), and until the sandbox is in
place destination enforcement at the proxy is advisory — which Decision D3 says
in as many words.

Destination entries are matched as `host/path` prefixes on a segment boundary,
so a mandate allowing `github.com/acme/api` does not permit
`github.com/evil/api` or `github.com/acme/api-private`. A bare host entry also
covers its subdomains.

**A traversal is refused in a ref as well as in a path, and refused here rather
than upstream.** A path containing a `..` segment or a NUL is denied whatever the
grant constrains, and since 2026-10-07 so is a *ref* containing `..` anywhere,
for `branch` and for `base` alike. The asymmetry mattered: the ceiling authors
`context.branch like "agent/*"` in Cedar, whose `*` spans `/`, so the faithful
glob translation is `agent/**` — and a mandate granting `branches: ["agent/**"]`
is both schema-legal and ceiling-contained, under which `agent/../main` matched
the pattern and was forwarded. `..` is rejected anywhere in a ref rather than as
a whole segment, which is what `git check-ref-format` does, so no ref git would
accept is denied.

A percent-encoded traversal (`src/%2e%2e/…`) is **allowed** by the proxy, and
that is deliberate. Probed on 2026-10-07 against both upstreams: github-mcp-server
v1.14.0 refuses it outright (`path must not contain '..' due to auth
vulnerability issue`), and GitHub's contents API treats `%2e%2e` as a literal
directory name and writes the file *inside* `src/`. Neither decodes it into an
escape, so decoding here would add a decoder to disagree with and no protection.

**One call cannot buy unbounded work, and neither can one mandate.** A call
naming more than 256 paths is denied, naming the cap — truncating instead would
send the paths past it upstream unchecked. On the validator side,
`MAX_DFA_STATES` bounds a single automaton, not a mandate, and a mandate is up to
64 grants of several facets each plus a Cedar cross-check whose witness set is a
product. Measured before the bound: a 22 KB mandate of star-dense patterns, all
of them inside the ceiling and over-granting nothing, validated `ok: true` in
2.6 s, and a 698 KB one built the same way ran for over five minutes. A work
budget is now shared across the whole `validate()` call and exhausting it is a
rejection, because R3's "reject on any doubt" includes doubt about termination.
The budget is deterministic — the same mandate spends the same units on any
machine — rather than a wall-clock deadline, because a validator whose verdict
depends on how busy the runner is cannot be something a mandate is proved
against.

**A granted operation can be unreachable, depending on how the upstream is
run.** `github-mcp-server`'s default toolsets expose 46 tools;
`GITHUB_TOOLSETS=all` exposes 91. Six catalog operations —
`actions.read`, `actions.logs.read`, `actions.write`, `discussions.read`,
`notifications.read` and `gist.write` — name tools that appear only once extra
toolsets are enabled. The proxy filters `tools/list` to what the upstream
offers, so a grant whose tools are absent means the agent never sees the tool
and the task fails with nothing explaining why. `TOOLSET_REQUIRED` in the
catalog names the toolset each one needs, and `unreachableOperations()` reports
the gap for a running server.

**The loosest rule for a tool decides.** Nine MCP tools are reached by more than
one operation — `get_file_contents` by both `repo.read` and `contents.read`,
`create_or_update_file` by both `contents.write` and `workflows.write`. A call is
allowed if it satisfies *at least one* rule for its tool, which is the only
coherent reading: requiring all of them would mean a read had to satisfy
`contents.write`'s rule too, so adding a grant would narrow the mandate. The
consequence is that a grant leaving a facet unconstrained makes every other
grant's limit on that facet useless *for the tools they share*. Granting
`repo.read` alongside a path-limited `contents.read` makes the path limit
decorative. The enforcement report names the facet, the tool and the grant
responsible.
A single number would be marketing rather than measurement.

## Filtering is not refusing, and it changes what a denial looks like

The proxy enforces in two places, and they fail differently.

`tools/list` is **filtered**: the agent is only ever shown the tools the
mandate's operations reach. `tools/call` is **checked**: a call that gets past
the tool gate is decided against the rule's facets and refused with a clause.

Filtering is the half that does most of the work — an agent that is never shown
`merge_pull_request` mostly does not try to call it. But it means an
under-granted operation produces **no denial at all**, because the agent never
attempts a tool it cannot see. Measured across the benchmark's six mandated
runs: the proxy issued **zero denials** while the replay evaluator predicted
**seven under-granted calls**.

So R10's requirement that every pause names the clause it hit is satisfied, and
is *vacuous where there is no pause*. An under-grant surfaces instead as a
silent workaround or a silent failure:

- the agent finds another route and finishes anyway — five of the six benchmark
  tasks completed despite a blocked `issue_read`, because the task text already
  carried what the call would have fetched; or
- the agent has no route and stops without an error. The benchmark's triage
  task is the clean case: seven allowed reads, zero denials, and a failure,
  because the mandate granted no `issue.comment` and the agent had no way to
  report what it had found.

**The consequence for anyone reading a run.** A false-pause count of zero is not
evidence a mandate was the right size; it may only mean nothing was refused out
loud. Under-grant, scored by replaying the run against a trace of the same task
run unconstrained, is the measurement that sees this — and it needs that trace,
which is why `fixtures/bench/traces/` is committed.

## Widening, and what cannot be widened

R10 requires every pause to name the clause it hit and to offer a reviewable
request for more scope. The second half has a limit that is part of the design
rather than a gap: **not every denial is widenable.**

| Clause | Widenable | Why not |
| --- | --- | --- |
| `<action>.resources`, `.branches`, `.paths`, `.base`, `.max` | yes | a facet limit is exactly what a reviewer can reasonably extend |
| `<action>.denyPaths` | no | a deny path is the mandate's floor; relaxing it is a ceiling change |
| `mandate.grants` | no | the operation is not granted at all, so granting it is a new mandate |
| `mandate.expiry` | no | the answer to an expired mandate is a new one, not a wider one |
| `destinations.allow` | no | where data may go is a review of its own |
| `mandate.internal` | no | this is a Mandate bug, not a scope decision |

A one-click button next to "add `.github/workflows/**` to your paths" would make
the deny list decorative, and one next to an ungranted operation would make the
grant list decorative.

**The refusal list governs the act, not just the suggestion.** The proxy
declines to *offer* a widen for those clauses, and `mandate widen` refuses to
*apply* one — including for a pause record edited by hand to attach a request.
That is why the list and the pause-record format live in `@mandate-dev/schema`
rather than in the proxy: one definition, read by the layer that offers and the
layer that applies.

**A widen is a new mandate, proved from scratch.** `applyWiden` produces a
proposal and nothing else; `validate()` is the only thing that can authorize it,
and it runs the full two-layer containment proof, the user-authority check, the
destination check and the lints over the widened mandate. Nothing about a change
being a widen rather than a first draft gives it any standing. A widen can only
union patterns onto a grant it already has, can only raise a `max`, and has no
field at all for expiry, `denyPaths` or `enforcedBy`.

## One destination list, three readers

A mandate's `destinations.allow` is read by three layers, and they must agree
about it or the disagreement is either a false pause or an open channel:

| Layer | Reads it to | Requirement |
| --- | --- | --- |
| Validator | prove the list sits inside the organization's | R9, check 3 |
| MCP proxy | refuse a tool call whose destination-bearing field is outside it | R9a |
| Egress compiler | build the sandbox's allowlist | R9b |

So there is exactly one predicate, `destinationWithin` in
`@mandate-dev/schema`, and all three call it. It lives in `schema` for the same
reason `SENSITIVE_PATHS` does: packages on both sides of the trust boundary need
it, and a second copy is a chance to drift.

**Containment reduces to membership.** A destination denotes itself plus
everything beneath it, so proving a mandate's entry sits inside the ceiling is
the same question as asking whether the ceiling permits that entry's own string.
That is why the proof and the runtime check can share one function rather than
being two implementations that have to be kept in step.

**A bare host covers its subdomains; one with a path does not.** `github.com`
permits `gist.github.com`; `github.com/acme` does not. All three layers apply
that rule, including the squid ACL the egress compiler emits.

**The organization's list is authored beside the ceiling, not inside it.** Cedar
decides `(principal, action, resource)` questions and has no destination in its
model, so expressing this as a policy would mean inventing an entity for it.
`fixtures/ceilings/<id>.destinations` is a plain list with comments, and
`loadCeiling` takes it as a **required** input. An empty list permits nothing —
which is why it is required rather than optional: a ceiling that forgot the file
would otherwise silently permit every destination, and that is exactly the state
this closed.

## The sandbox, and why it is the layer that holds

Decision D3's reasoning is the whole justification for this component: an MCP
proxy sees MCP traffic and nothing else. An agent with a shell, a `git push` to
a remote it configures itself, or a `curl` never transits it. Until the sandbox
exists, destination enforcement is advisory — which is why R9a's field-based
check and this are two different rows in the table above.

`compileEgress` turns `destinations.allow` into a squid configuration, and
`sandbox/` is the container that runs it. Inside, the `agent` user has no route
to the network except the proxy on loopback, and the proxy tunnels only to an
allowed host on port 443.

**Subdomains follow the mandate, not the host.** A destination naming a host
*and a path* compiles to an exact `dstdomain`, so `github.com/acme/api` does
not permit `gist.github.com`. A destination naming a bare host compiles to a
`.host` entry and does cover subdomains. That is deliberately the same rule the
proxy's own `destinationAllowed` applies, because both layers read one
destination list and a disagreement between them would mean the mandate says
two different things.

**It refuses rather than degrading.** No `NET_ADMIN` capability, a squid config
squid will not load, or a proxy that never accepts a connection all exit
non-zero before the agent starts. Running an agent with egress open while this
page claims the layer holds would be worse than having no sandbox.

**What it does not close.** Data sent to an *allowed* destination is not
tracked: a public pull request body is a valid exfiltration channel, and the
bytes travel to GitHub either way. That is R14's taint tracking, which is P1 and
absent. The sandbox also does nothing at all if the agent is run outside it.

The container is verified against a real Docker daemon rather than reviewed as a
recipe — `MANDATE_SANDBOX=1 pnpm --filter @mandate-dev/compiler test sandbox` —
including negative controls that widen the ACL and strip the firewall rules to
confirm the checks can actually fail.

## What the action graph proves, and what it does not

Every decision the proxy makes is recorded as a node (R8), and that trace is
what the replay evaluator scores a mandate against. It is a record, not a
control: it bounds nothing. Three limits are worth stating.

**It sees what the proxy sees, and no more.** The trace has the same blind spot
as the proxy row above: a call that never transits MCP never appears. A trace
showing nothing untoward is not evidence that nothing untoward happened.

**It records how much data moved, not what the data was.** Outputs are stored
as a size in bytes and a truncated sha256 of the result, never as content. That
is deliberate — a trace file holding repository contents would be a second copy
of everything the agent read, with none of the repository's access control — but
it means the trace cannot answer "was this file's contents in the response". It
answers "did the same bytes come back as last time".

**Destinations in the trace are the fields R9a checks, not every URL seen.** A
URL inside an issue body or a file's `content` is not recorded as a destination,
for the same reason it is not enforced as one. The trace and the enforcer use
one extraction function, so a destination in the trace is exactly a destination
the proxy decided on.

## What Mandate does not attempt

- **Prompt-injection detection.** Mandate does not try to notice that an agent's
  context has been poisoned. It bounds what an injected agent can *do*. An
  injection that stays inside the mandate is out of scope by design.
- **Data-flow tracking.** Repository data sent to a destination the mandate
  allows is not tracked further. A public pull request body is a valid
  exfiltration channel. Taint tracking is a post-v0.1 requirement (R14).
- **Being a credential vault or an identity provider.** Mandate mints
  short-lived, task-scoped tokens from controls GitHub already has. It stores
  nothing long-lived.
