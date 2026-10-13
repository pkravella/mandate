# @leastpilot/compiler

Mints a repository-scoped GitHub App token and revokes it, and compiles the mandate into proxy rules (capped to end before the token does), the sandbox's egress policy, the token-versus-proxy enforcement report, and the gh-aw export.

Part of [LeastPilot](https://github.com/pkravella/mandate#readme), task-scoped authority for AI coding
agents. Most people want the command-line tool,
[`@leastpilot/cli`](https://www.npmjs.com/package/@leastpilot/cli); this
package is published because the CLI depends on it at the same exact version.

What LeastPilot defends against, and what defeats it, is in the
[threat model](https://github.com/pkravella/mandate/blob/main/docs/threat-model.md).

Apache-2.0.
