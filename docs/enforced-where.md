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
| GitHub App installation token | Repository set, permission set | Branch, path, argument, call count | Nothing — but it is coarse by design, see below | planned (Task 10) |
| MCP proxy | Tool set, branch, path, base, call count, destinations appearing in arguments | Anything not sent as an MCP call | An agent with a shell and another credential | planned (Tasks 12–13) |
| Sandbox egress allowlist | All network egress from the agent user | Data sent to an **allowed** destination | Running the agent outside the sandbox | planned (Task 15) |
| Mandate expiry | Call acceptance after `expiresAt` | Work already done | Nothing | planned (Task 12) |
| GitHub rulesets (backstop) | Pushes to protected branches, required reviews | Anything outside branch rules | An admin token | planned (Task 11) |

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
A single number would be marketing rather than measurement.

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
