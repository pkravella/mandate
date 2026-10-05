# Enforced where

A mandate says more than any single control can enforce. This page says which
control enforces which part, what each one does **not** bound, and what defeats
it. R7 requires documenting this; keeping it honest is the point.

**Status column:** Mandate is mid-build. A row marked *planned* describes a
control that does not exist yet, and nothing in the repository enforces it
today.

| Control | Bounds | Does **not** bound | Defeated by | Status |
| --- | --- | --- | --- | --- |
| Mandate schema + validator | What may be granted at all: the operation set, pattern decidability, the organization ceiling, the requester's own permission level | Anything at runtime — it decides before the agent starts | Nothing; it is deterministic and fails closed | **built** |
| GitHub App installation token | Repository set, permission set, one-hour lifetime | Branch, path, argument, call count | Nothing — but it is coarse by design, see below | **built** |
| Token revocation on run exit | Reuse of a leaked token, after a propagation delay | The ~4 s window measured below, and work already done | Using the token inside that window | **built** |
| MCP proxy | Tool set, branch, path, base, call count, destinations appearing in arguments | Anything not sent as an MCP call; 13 catalog operations no MCP tool reaches | An agent with a shell and another credential | **built** |
| Sandbox egress allowlist | All network egress from the agent user | Data sent to an **allowed** destination | Running the agent outside the sandbox | planned (Task 15) |
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
