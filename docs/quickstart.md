# Quickstart

Validate a mandate, then run an agent that can only reach GitHub through it.

Everything in §1–§3 is offline and free. §4 needs a GitHub App and spends model
tokens.

```bash
pnpm install && pnpm build
```

Node 22 or later. The CLI binary is `mandate`; the examples below call
`packages/cli/dist/index.js` directly so they work in a checkout without a
global install.

---

## 1. Write a mandate by hand

A mandate is one task's authority. Save this as `mandate.yaml`:

```yaml
mandate: fix-issue-42
task: "Fix issue #42 and open a PR"
requestedBy: user:alice
expiresInMinutes: 30
ceiling: org-policy@v12
grants:
  - action: repo.read
    enforcedBy: token
    resources: ["acme/api"]
  - action: branch.create
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
  - action: contents.write
    enforcedBy: proxy
    resources: ["acme/api"]
    branches: ["agent/42-*"]
    paths: ["src/**", "test/**"]
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

Field by field: [mandate-format.md](mandate-format.md).

Two things to notice. `expiresInMinutes` caps at 60, because a GitHub
installation token expires one hour from creation and cannot be extended — the
PRD's example `expires_in: 2h` is not mintable as a single token. And every
grant carries `enforcedBy`, which is a required field so the audit log stays
honest about which control actually refuses the call.

## 2. Validate it

```bash
node packages/cli/dist/index.js validate mandate.yaml \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --level push --repositories 20
```

Exit `0` prints the permission diff, `1` prints the refusal with the ceiling
clause and a counterexample, `2` means something could not be read.

`--level push` **asserts** that alice has push access, and every line of output
that reports it says so. To make the result an authorisation record, read the
real permission instead:

```bash
export MANDATE_APP_ID=... MANDATE_INSTALLATION_ID=... MANDATE_APP_KEY_PATH=~/.mandate/app.pem

node packages/cli/dist/index.js validate mandate.yaml \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --repo acme/api
```

Pass one or the other, never both. There is no default: a run that has not said
where the requester's authority came from has not been asked the question.

### A refusal

Change `branches` to `["feature/42-*"]` and the ceiling refuses it:

```
Mandate rejected.

  [not-contained] in grant #0 (contents.write) grant contents.write is wider
    than ceiling clause allow-agent-branch-writes: it would permit "feature/42-"
      ceiling clause: allow-agent-branch-writes
      counterexample: feature/42-

Nothing was minted. Narrow the mandate, or request a ceiling change.
```

The counterexample is a real string the mandate would have permitted and the
ceiling does not. It comes out of the containment check itself rather than being
guessed afterwards, which is why there always is one.

## 3. Run an agent under it

`mandate serve` is an MCP server that enforces one mandate. `mandate run`
validates, writes a config pointing at it, and launches the command you give it:

```bash
node packages/cli/dist/index.js run \
  --mandate mandate.yaml \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --repo acme/api \
  --trace run.jsonl --diff \
  -- claude --mcp-config '{mcpConfig}' -p "Fix issue #42 and open a PR"
```

`{mcpConfig}` is replaced with the config path, and `MANDATE_MCP_CONFIG` is set
in the agent's environment, so an agent that takes a flag and one that reads the
environment both work. Mandate does not drive a particular agent: every MCP
client already knows how to start a server from a config, so being that server
is the whole integration.

Nothing is minted and no agent is launched until the mandate validates.

**The config carries no credential.** `mandate serve` mints its own token in its
own process, so the file the agent reads — and it is handed the path — names the
mandate and the ceiling and nothing else.

To see what an agent would be offered without running one:

```bash
node packages/cli/dist/index.js run ... -- node -e \
  'console.log(require("fs").readFileSync(process.argv[1],"utf8"))' '{mcpConfig}'
```

### The trace

`--trace run.jsonl` writes the action graph: every call, its decision, and the
clause behind every refusal. It is the audit record for the run, and
`parseJsonl` reads it back strictly — an unknown line type, a denial with no
clause, or a gap in the sequence is a rejection rather than a dropped row.

## 4. Widen, when a mandate was too small

A refused call produces a pause record naming the clause it hit. If the task
genuinely needs that operation, re-validate with the widen applied:

```bash
node packages/cli/dist/index.js widen mandate.yaml pause.json \
  --ceiling fixtures/ceilings/org-policy-v12.cedar \
  --schema fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations fixtures/ceilings/org-policy-v12.destinations \
  --as alice --repo acme/api
```

The whole mandate is re-validated from scratch, so the agent can never grant
itself anything. Not every denial is widenable, and the refusal list is the
contract: a deny path, an expired mandate, an ungranted operation and a
disallowed destination are refused with the reason instead. A one-click "add
`.github/workflows/**` to your paths" would make the deny list decorative.

## 5. Run it in the sandbox

Everything above bounds the authority Mandate mints. An agent that has another
credential — a PAT in its environment, something in `.git/config`, a logged-in
`gh` — does not transit the proxy at all.

`sandbox/` is a container whose only credential is the minted token and whose
only egress is an allowlist compiled from `destinations.allow`. It verifies
itself over raw sockets, with negative controls that widen the ACL and strip the
firewall rules to confirm the checks can fail.

```bash
MANDATE_SANDBOX=1 pnpm vitest run packages/compiler/src/sandbox.docker.test.ts
```

Free, needs Docker. Until the agent runs in there, destination enforcement at
the proxy is **advisory** — see [threat-model.md](threat-model.md) §3.1 and
[enforced-where.md](enforced-where.md).

---

## Where to go next

| | |
| --- | --- |
| What a mandate may say | [mandate-format.md](mandate-format.md) |
| Writing an org ceiling in Cedar | [ceiling-authoring.md](ceiling-authoring.md) |
| Which control enforces what | [enforced-where.md](enforced-where.md) |
| What breaks it | [threat-model.md](threat-model.md) |
| Measured completion, authority cut, over-grant | [benchmark-report.md](benchmark-report.md) |
