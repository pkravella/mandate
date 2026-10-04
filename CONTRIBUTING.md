# Contributing to Mandate

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Conduct
concerns go to pranithravella@gmail.com; security vulnerabilities go through
GitHub's private reporting instead, never by email — see [SECURITY.md](SECURITY.md).

## Licensing and provenance

This project is Apache-2.0. Contributions are accepted under the same licence,
by the inbound-equals-outbound terms of Apache-2.0 section 5 — there is no CLA.

Every commit must carry a Developer Certificate of Origin sign-off:

```bash
git commit -s -m "feat: ..."
```

That appends `Signed-off-by: Your Name <you@example.com>`, which certifies you
wrote the patch or otherwise have the right to submit it under Apache-2.0. CI
rejects unsigned commits.

## The one rule that is not negotiable

**No enforcement decision may depend on a model's judgment.** The writer
proposes; the validator decides. A pull request that lets model output reach the
compiler without passing `validate()`, or that makes a deny path fall through to
allow, will be rejected regardless of how well it tests.

Concretely:

- `ProposedMandate` may only be imported by `writer` and `validator`. A
  `no-restricted-imports` rule enforces this.
- `ValidatedMandate` may only be constructed by `markValidated`, which requires
  a `ContainmentProof`. Do not add an escape hatch.

  The brand alone is **not** sufficient, and it is worth knowing why. It blocks
  accidental *assignment* of a plain mandate, but TypeScript permits a
  narrowing cast to an intersection type — `m as ValidatedMandate` compiles,
  and so does `m as unknown as ValidatedMandate`. A `no-restricted-syntax`
  rule bans those casts everywhere except the single file that defines
  `markValidated`, so even the validator must go through that function.
- Every decision path ends in a default deny. An exception, a timeout, or an
  unparseable pattern is a rejection, never a pass.
- Do not loosen the glob parser to make a test pass. An undecidable pattern is
  supposed to be rejected.

## Development

```bash
pnpm install
pnpm typecheck   # solution build, then typecheck the test files
pnpm lint        # includes the trust-boundary rules below
pnpm test
pnpm build
```

`typecheck` runs two passes: `tsc --build` emits library code, then
`tsc -p tsconfig.test.json` typechecks the test files that the build
deliberately excludes. Tests are excluded from the build so they are never
published, and typechecked separately so they are never unchecked.

Workspace packages resolve to their TypeScript **source** during tests, via
the alias map in `vitest.shared.ts` applied from each package's own
`vitest.config.ts`. Without that, editing one package and testing another
reads a stale `dist` — which can make a test pass that should fail. A
root-level `resolve.alias` does not propagate into Vitest projects, so a new
package needs its own `vitest.config.ts`.

Tests come first. Every change to validation or enforcement needs a test that
fails before the change and passes after it. For a bug fix, the test should be
the reproducing case from the issue.

If you add a GitHub operation to the catalog, you must also give it a risk
class, the GitHub App permission it needs, its minimum user permission level,
and its prerequisites. An operation with the wrong risk class is a security
defect, not a typo.

## Commits and pull requests

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Keep a pull
request to one reviewable change. Say in the description what an attacker could
do if your change were wrong — if the answer is "nothing", say that too.

## Scope of the open-source project

The contract format and the engine are open so they can become a shared
standard: the mandate schema, the operation catalog, the writer, the validator,
the GitHub compiler, the MCP proxy, and the replay evaluator all live here and
stay Apache-2.0.

A hosted broker, org-ceiling management UI, approval workflows in chat, and
compliance exports are a separate commercial product and are out of scope for
this repository. Proposals that would require the open core to depend on hosted
infrastructure will be declined. If you are unsure which side of that line your
idea falls on, open a discussion before writing code.
