# Exporting to GitHub Agentic Workflows

`mandate export gh-aw` turns a validated mandate into the frontmatter of a
[GitHub Agentic Workflows](https://github.github.com/gh-aw/) (gh-aw) workflow.
In gh-aw the agent runs read-only and asks for writes through `safe-outputs`.
A separate job, holding its own token, carries those writes out, inside the
limits the workflow sets. The export writes those limits from the mandate.

It is R12's first backend. It refuses anything it cannot express exactly
rather than guess, and every gh-aw default that would write something the
mandate does not grant is switched off.

## Using it

```bash
node packages/cli/dist/index.js export gh-aw --mandate mandate.yaml \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema  fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --repo acme/api > .github/workflows/fix-issue.md
```

The mandate is validated first, exactly as `serve` and `run` validate it.
stdout is the workflow block and nothing else. Put the agent's instructions
below the closing `---`, commit it to the repository the mandate names, and run
`gh aw compile`. Exit 0 means exported. Exit 1 means refused, either by the
validator or because gh-aw cannot hold the mandate, with the reasons. Exit 2
means bad input.

The file says where it came from: the mandate and its sha256, the ceiling and
its sha256, whether the requester's level was verified or asserted, the gh-aw
version it was written for, where it is narrower than the mandate, and what it
carries that the mandate does not grant.

## One workflow per kind of task, not per task

gh-aw compiles these limits into the workflow's lock file when the workflow is
authored. `allowed-files` cannot be set when the workflow runs. So the export
is a template you commit once for a kind of task, and every run of it gets the
same limits. That is weaker than Mandate's own loop, where each task gets its
own mandate.

One consequence: because branch patterns are refused (below), the template
names one branch. gh-aw will not overwrite an existing branch
(`recreate-ref: false`), so the template opens one pull request until that
branch is deleted.

## What maps to what

| Mandate | gh-aw |
| --- | --- |
| The one repository every grant names | Where the workflow lives; `tools.github.allowed-repos` |
| Read grants (`repo.read`, `contents.read`, `issue.read`, …) | `tools.github.allowed`: those operations' MCP tools; `read-only: true`; `permissions:` at `read` |
| `branch.create` + `contents.write` + `pull_request.create` | One `create-pull-request` |
| `pull_request.create` `max` | `max` |
| The branch the grants name | `allowed-branches`, with `preserve-branch-name: true` |
| `pull_request.create` `base` | `base-branch`; the agent cannot override it (no `allowed-base-branches`, `stacked: false`) |
| `contents.write` `paths` | `allowed-files` (the same glob language: `*` stops at `/`, `**` does not) |
| `contents.write` `denyPaths` | `excluded-files`, which drops them from the patch (see below) |
| `issue.comment` / `pull_request.comment` | `add-comment`: `target: "*"`, `max` the sum of both grants, and `issues` / `pull-requests` as granted with `discussions: false`. Those three only set the write job's token permissions, which is why the token is pinned (below) |
| (none: how the limits bind) | `github-token: ${{ secrets.GITHUB_TOKEN }}` on the agent's GitHub tools and on safe-outputs |
| `expiresInMinutes` | `timeout-minutes` |

Switched off, because each one writes something the mandate does not grant:

| gh-aw option | What its default would do |
| --- | --- |
| `fallback-as-issue: false` | Open an issue holding the patch when the pull request fails |
| `auto-close-issue: false` | Add "Fixes #N", which closes the issue when someone merges |
| `auto-merge: false`, `close-older-pull-requests: false` | Merge, or close other pull requests |
| `activation-comments: false` | Comment on the triggering issue or PR when the run starts and ends |
| `report-failed-jobs`, `report-failure-as-issue`, `report-incomplete`, `missing-tool`, `missing-data` | File issues about the run |

## What it refuses, and why

| Refused | Why |
| --- | --- |
| More than one repository, or a repository pattern | A gh-aw workflow acts on the repository it lives in |
| A branch pattern | gh-aw checks the name the agent gives, then normalises it before pushing: `agent/42-!!` matches `agent/42-*` and is pushed as `agent/42`, outside it. Shown with gh-aw's own code in the conformance test |
| A branch name gh-aw would change | The same normalisation: `agent/fix#42` would be pushed as `agent/fix-42` |
| A base given as a pattern | gh-aw takes one base branch |
| A read limited by path or branch | gh-aw allows a tool or not; it cannot limit what the tool reads |
| `contents.write` or `branch.create` without `pull_request.create` | gh-aw writes code only through a pull request |
| `pull_request.create` without `contents.write` or `branch.create` | gh-aw's pull request commits whatever the agent changed, on a new branch. Without `contents.write` there is no file limit at all. Found in review: an earlier version exported it |
| Any other write (`issue.create`, `issue.label`, …) | Not mapped yet. Refused, not dropped |
| A mandate that writes nothing | gh-aw adds a `create-issue` output to any workflow without a write output. The published triage mandate (`repo.read` alone) is one |
| A destination outside GitHub | gh-aw's network setting is the agent's own egress, not a destination for repository data |
| A side effect with no `max` | gh-aw needs a count |

## Where it is narrower, and what it adds

**Narrower:**
- A change to a deny path is dropped from the patch, and the pull request
  opens without it. A mandate would refuse the call instead. Either way the
  change never reaches GitHub. gh-aw drops files using git's own path
  matching, where `*` also crosses `/`, so it drops at least what the deny
  path names.
- `protected-files: blocked` refuses changes to package manifests, agent
  instruction files and `.github/`, even where the mandate's paths allow them.
- `github-token-for-extra-empty-commit: none`: a pull request opened with the
  workflow token does not start CI by itself. Otherwise a CI-trigger token, if
  the repository has one, would push an extra commit to the branch.

**Not from the mandate:** `network: defaults` is gh-aw's infrastructure egress
for the agent, and gh-aw adds its engine's API host. It is the operator's
choice, like `--agent-egress`, and not a destination the mandate grants.

The trigger is `workflow_dispatch`, which only people with write access can
fire. A trigger an outsider can fire, such as `issues` or `issue_comment`, puts
their text in front of the agent ([threat-model.md](threat-model.md) §5).
Change it deliberately.

## What enforces it, and what that rests on

gh-aw enforces it, not Mandate.

**The tokens are pinned, and that is what makes the permissions mean
anything.** Left to its defaults, gh-aw gives the agent's GitHub tools a PAT
from `GH_AW_GITHUB_MCP_SERVER_TOKEN` or `GH_AW_GITHUB_TOKEN`, and the write jobs
one from `GH_AW_GITHUB_TOKEN`, whenever the repository has those secrets. A PAT
ignores the workflow's `permissions:`. The export sets `github-token` to the
workflow's own `GITHUB_TOKEN` in both places, so the agent's tools carry only
the read permissions listed, and the write job carries only what gh-aw computes
from the safe outputs.

That job's permissions are merged across outputs. A mandate granting
`issue.comment` alongside a pull request therefore gets a token that can also
comment on pull requests. That matches Mandate's own proxy, which cannot tell
the two apart either (one tool, combined allowance). `discussions: false` holds
because the token has no discussions permission.

The agent itself gets a shell and file edits inside gh-aw's sandbox, which is
gh-aw's default. The credentials in its job are the pinned workflow token at
read permissions and a checkout that keeps no credentials.

Read in gh-aw's handlers at v0.89.21:
- `allowed-files`, the base branch and both counts are checked in the job that
  performs the write.
- `allowed-branches` is checked only in gh-aw's safe-outputs MCP server, while
  the agent's request is recorded. That holds because the agent's container
  mounts the request file read-only, and gh-aw's own steps copy and ingest it
  only after the agent has exited. It is gh-aw's boundary, not Mandate's.

Once committed, the workflow file is the policy. Editing it afterwards changes
what is enforced, and nothing re-checks it against the mandate.

## How it is tested

Against gh-aw v0.89.21, the version pinned in the export. The conformance test
does not trust a description of gh-aw. It runs gh-aw's own matchers, copied
unmodified with their licence and blob hashes in
[fixtures/gh-aw/v0.89.21](../fixtures/gh-aw/v0.89.21/README.md), over generated
paths and branch names. For each published benchmark mandate and several made
by hand, it checks that every file gh-aw would commit and every branch it would
push is one the mandate allows. It also checks every key the export writes
against gh-aw's schema at that tag, which rejects unknown keys.

Not done: a live gh-aw run. That needs a real agent, which costs money.
