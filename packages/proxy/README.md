# @leastpilot/proxy

An MCP server facing the agent and an MCP client facing `github-mcp-server`. Filters `tools/list`, checks every call's repository, branch, base, paths, destinations and count, records every decision as an action graph, and turns a denial into the clause it hit and a reviewable widen request. Writes and verifies the signed audit log.

Part of [LeastPilot](https://github.com/pkravella/mandate#readme), task-scoped authority for AI coding
agents. Most people want the command-line tool,
[`@leastpilot/cli`](https://www.npmjs.com/package/@leastpilot/cli); this
package is published because the CLI depends on it at the same exact version.

What LeastPilot defends against, and what defeats it, is in the
[threat model](https://github.com/pkravella/mandate/blob/main/docs/threat-model.md).

Apache-2.0.
