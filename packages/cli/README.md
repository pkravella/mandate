# @leastpilot/cli

Task-scoped authority for AI coding agents.

LeastPilot gives each agent task its own authority and enforces it. For a task
like *"Fix issue #42 and open a PR"* it writes a **mandate**: the repositories,
actions, branches, paths and data destinations the task needs, and when it all
expires. A deterministic validator proves the mandate grants nothing beyond
what the requester and the organization's ceiling already allow. Then it mints
a GitHub App token scoped to one repository and runs the agent behind an MCP
proxy that checks every call against the mandate.

Anything not granted is denied.

## Install

```bash
npm install -g @leastpilot/cli
leastpilot --help
```

Pin an exact version wherever it runs unattended, and check the registry
signatures and provenance after installing:

```bash
npm audit signatures
```

Node 22.12 or later.

## Validate a mandate

```bash
leastpilot validate mandate.yaml \
  --ceiling org-policy.cedar \
  --schema schema.cedarschema \
  --ceiling-destinations org-policy.destinations \
  --as alice --repo acme/api
```

Exit 0 prints the permission diff, 1 the rejection with the ceiling clause and
a counterexample, 2 means the input could not be read. `--repo` reads the
requester's real permission from GitHub and needs the App's credentials
(`LEASTPILOT_APP_ID`, `LEASTPILOT_INSTALLATION_ID`, `LEASTPILOT_APP_KEY_PATH`);
`--level` asserts it instead, and the output says so every time.

Writing a ceiling: [ceiling-authoring.md](https://github.com/pkravella/mandate/blob/main/docs/ceiling-authoring.md).
Example ceilings: [fixtures/ceilings](https://github.com/pkravella/mandate/tree/main/fixtures/ceilings).

## Run an agent in the sandbox

Without the sandbox, destination enforcement is advisory and the agent can
read the App's key: the [threat model](https://github.com/pkravella/mandate/blob/main/docs/threat-model.md)
§3.1 explains why. Use `--sandbox`.

The sandbox image's source ships in this package. Build it, then build your
agent's image on top of it:

```bash
leastpilot sandbox build          # docker build -t mandate-sandbox <this package>/sandbox
```

```dockerfile
FROM mandate-sandbox
RUN npm install -g @anthropic-ai/claude-code@2.1.232 && npm cache clean --force
```

```bash
docker build -t my-agent .
leastpilot run --mandate mandate.yaml ... \
  --sandbox --image my-agent --agent-egress api.anthropic.com \
  --pass-env ANTHROPIC_API_KEY -- claude -p "..." --mcp-config '{mcpConfig}'
```

macOS with Docker Desktop only for now; `--sandbox` refuses elsewhere.

## More

- [Quickstart](https://github.com/pkravella/mandate/blob/main/docs/quickstart.md)
- [Mandate format](https://github.com/pkravella/mandate/blob/main/docs/mandate-format.md)
- [What is enforced where](https://github.com/pkravella/mandate/blob/main/docs/enforced-where.md)
- [Threat model](https://github.com/pkravella/mandate/blob/main/docs/threat-model.md)

Apache-2.0.
