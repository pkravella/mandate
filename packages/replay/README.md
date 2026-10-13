# @leastpilot/replay

Scores a mandate by replaying a recorded action graph through the production argument enforcer, reporting over-grant, under-grant, and which operations a task needed that the mandate lacked.

Part of [LeastPilot](https://github.com/pkravella/mandate#readme), task-scoped authority for AI coding
agents. Most people want the command-line tool,
[`@leastpilot/cli`](https://www.npmjs.com/package/@leastpilot/cli); this
package is the evaluation library behind LeastPilot's benchmark, published
for anyone scoring their own mandates against recorded runs.

What LeastPilot defends against, and what defeats it, is in the
[threat model](https://github.com/pkravella/mandate/blob/main/docs/threat-model.md).

Apache-2.0.
