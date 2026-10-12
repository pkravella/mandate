# The audit log

A signed, append-only record of one session: the mandate that was authorised,
every call the proxy sent to GitHub, and every decision it made. It is written
as things happen, so a session that is killed leaves a record up to the kill. It
checks with a public key alone, so whoever audits it does not need the key that
wrote it. This is R16.

The trace (`--trace`) and the audit log are different things. The trace is the
action graph replay reads, written once when the session ends. The audit log is
evidence: signed, chained, and readable after a kill. `leastpilot audit verify`
gives back the same action graph from it.

## Turning it on

Make a signing key once:

```bash
node packages/cli/dist/index.js audit keygen --out ~/.mandate/audit.pem
```

That writes the private key at mode 600 and its public half to
`~/.mandate/audit.pem.pub`, and prints the key's id. Give the `.pub` file to
whoever checks logs. This is **not** the GitHub App's key and should not be
stored with it: the App key mints installation tokens and signs nothing else.
LeastPilot refuses an RSA key here for that reason, and refuses any key file other
users can open. `openssl genpkey -algorithm ed25519 -out key.pem` makes an
acceptable key too.

Then pass `--audit-log` to `serve` or `run`, with the key in the environment:

```bash
export LEASTPILOT_AUDIT_KEY_PATH=~/.mandate/audit.pem
node packages/cli/dist/index.js run --mandate mandate.yaml ... \
  --sandbox ... --audit-log session-42.audit.jsonl -- claude ...
```

Before anything is minted, LeastPilot checks that the key exists and is an Ed25519
key only its owner can read, and that the log file does not already exist. An
audit log is never overwritten. If any of those fails, nothing runs.

One log is one session. Without `--sandbox` the agent starts serve itself, and
if it restarts its MCP server (a crash, or a manual reconnect) the new serve
finds the log already there and refuses to start, so the agent loses its tools
for the rest of the run. Start a new run with a new log name instead. With
`--sandbox` serve takes one connection and only the operator can start another.

## Checking a log

```bash
node packages/cli/dist/index.js audit verify session-42.audit.jsonl \
  --public-key ~/.mandate/audit.pem.pub
```

For a session killed while a write was with GitHub, it printed:

```
Intact: 5 event(s), signed by key 0a9a06ec2b0f5b71f214f15648d50eff399beca1f74161e97f0e2dfad11ab657.
Mandate fix-issue-42 (sha256 a67c1b5a85b1446b5dd2f94ab5883797dab686983cb43b2631469c8e35262fe7), requested by user:alice.
Proved against ceiling org-policy-v12.cedar (sha256 c07d000000000000000000000000000000000000000000000000000000000000).
2 decision(s): 1 allowed, 1 denied.
1 call(s) were sent to GitHub and never completed; whether they took effect is not recorded:
  call 2 at 2026-10-11T21:09:39.369Z: create_or_update_file acme/api agent/42-fix src/retry.js
Not sealed: the session was killed, or the end of the log was cut off. Nothing in the file can tell which, so events after the last one here may be missing.
```

A sealed log ends with one of two lines. `Sealed: the session served and then
closed` means the agent was served and the session ended: the agent left, a
signal arrived, or the mandate expired. `Sealed: the session never opened`
means the mint or the upstream failed and nothing was served. A seal says the
log is complete, not that the task succeeded.

Exit 0 means intact and sealed. Exit 1 means either that a line does not verify,
in which case the line is named, or that the log has no seal. Exit 2 means a
file could not be read or the key is not an Ed25519 public key. Given the
private key by mistake, it refuses and says so: whoever holds that file can
sign any log.

**A log with no seal** comes from one of two things: the session was killed, or
someone cut lines off the end. Nothing in the file can tell those apart, and the
verifier says so rather than guess. Telling them apart needs a witness outside
the file, such as a hosted service that receives each event's hash as it is
written.

**Calls sent and never completed** are listed by name. An allowed call is logged
once when it is sent to GitHub and again when the answer comes back, so a call
in flight at a kill appears as sent, with its outcome unknown. That is the one
an auditor most needs, and recording only completed calls loses it. At a clean
shutdown, closing the upstream fails a pending call, and it is logged as an
upstream failure before the seal.

## What the signature proves, and what it does not

A valid log was written by someone holding the audit key and has not been edited
since. Whether that rules out the agent depends on where the key was:

| | The agent can read the key | The agent can write the log |
| --- | --- | --- |
| `run --sandbox` | No. The key path stays on the host, and `--pass-env` refuses every `MANDATE_*` name. | No. serve writes it on the host. |
| `run` without `--sandbox`, or `serve` spawned by an agent | **Yes.** It runs as your user, and serve's environment is its environment. | **Yes.** |
| The GitHub Action | `--audit-log` is not wired into the Action, for this reason: the agent runs on the runner beside the key. | |

So without the sandbox the log is a record of what happened, not evidence
against an agent that wanted to rewrite it, which is the same limit
[threat-model.md](threat-model.md) §3.1 states for the App key. In every mode
the log is tamper evidence once it is stored somewhere the key is not.

The operator is out of scope here as everywhere: whoever holds the key can
write any log they like.

## The format: `mandate-audit/1`

One JSON object per line:

```json
{"e":"{\"seq\":2,\"prev\":\"9b1f…\",\"type\":\"forwarded\",\"call\":1,…}","sig":"q8Vn…"}
```

- `e` is the event, serialised as a JSON **string**. `sig` is Ed25519, in
  base64, over the UTF-8 bytes of `mandate-audit/1\n` followed by `e` exactly as
  it appears. A verifier checks the bytes it has, never a re-serialisation, so
  it can be written in any language.
- Every event has `seq` (1, 2, …, equal to its line number) and `prev`: the
  sha256, hex, of the whole previous line, or `null` on the first. Removing,
  reordering or moving a line between logs breaks the chain.

The events:

| `type` | When | Carries |
| --- | --- | --- |
| `open` | First, before the token is minted | `format`, `at`, `keyId` (sha256 of the public key's SPKI DER), a random `session`, `mandateId`, `mandateHash`, `ceiling` (`label`, `sha256`), the `mandate` itself, and with `--approval` the `approval` found (`issue`, `comment`, `by`, `at`, `digest`) |
| `forwarded` | An allowed call, as it is sent upstream | `call` (1, 2, …) and what the call named, as a trace node names it: `at`, `tool`, `action`, `resource`, `branch`, `paths`, `base`, `destinations`, `unreadableDestinations`, `method` |
| `node` | A decision, as it completes | `node` (an action-graph node, held to the trace's rules) and, on an allowed call, the `call` it finishes |
| `seal` | After the session closed and the token was revoked | `at`, and `reason`: `closed` (it served) or `never-opened` |

The verifier also recomputes the mandate's hash from the embedded mandate,
requires one `open` event and nothing after the `seal`, requires every allowed
node to finish a call that was forwarded and finished only once, and requires a
denied node to finish none. It accepts a last line cut off mid-write, before any
seal, as unsealed rather than broken.

Events are appended with a synchronous write as they happen, so they survive the
process being killed, which was probed with SIGKILL. They are not fsynced, so a
power cut can lose what the OS had not yet flushed.

If a write fails, for example a full disk, LeastPilot says so once on stderr and
writes nothing more, and the log ends unsealed. The call itself is not refused,
because audit is not authorisation. Turning a logging outage into refused calls
would make the logger an enforcement point whose rules nothing validated.
