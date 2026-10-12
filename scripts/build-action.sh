#!/usr/bin/env bash
# Builds LeastPilot inside the Action's own checkout.
#
# dist/ is never committed, so `uses: pkravella/mandate@<sha>` from another
# repository arrives with no CLI to run. Both Actions call this first. It
# builds from the lockfile, and does nothing when the CLI is already built --
# the case of `uses: ./` in this repository after its own build.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f packages/cli/dist/index.js ]; then
  echo "LeastPilot is already built."
  exit 0
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install --frozen-lockfile
corepack pnpm build
