#!/usr/bin/env bash
# Installs the published LeastPilot CLI for both Actions (Task 9.1 step 5).
#
# The Actions used to build LeastPilot from source with pnpm's frozen
# lockfile, which pinned every dependency. An exact `@leastpilot/cli@x.y.z`
# alone would not: the CLI's third-party dependencies are ranges, resolved
# fresh on every install. So this installs from action-install/'s committed
# npm lockfile with `npm ci`, which checks every tarball against its
# integrity hash, runs no install scripts, and then checks the registry's
# signatures and provenance attestations for everything it installed.
#
# Installs into a fresh temporary directory, never the Action's checkout, and
# writes the binary's path to $GITHUB_OUTPUT as `bin` (or prints it).
set -euo pipefail
src="$(cd "$(dirname "$0")/../action-install" && pwd)"
dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/leastpilot-cli.XXXXXX")"
cp "$src/package.json" "$src/package-lock.json" "$dir/"
cd "$dir"
npm ci --ignore-scripts --no-audit --no-fund
npm audit signatures
bin="$dir/node_modules/.bin/leastpilot"
want="$(node -p 'require("./package.json").dependencies["@leastpilot/cli"]')"
got="$("$bin" --version)"
if [ "$got" != "$want" ]; then
  echo "::error::installed leastpilot reports $got, but action-install pins $want" >&2
  exit 1
fi
echo "LeastPilot $got installed at $bin"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "bin=$bin" >> "$GITHUB_OUTPUT"
fi
