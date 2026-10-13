# Claude Code in the LeastPilot sandbox. The image the live run used, 2026-10-09.
#
#   leastpilot sandbox build
#   docker build -t mandate-agent-claude packages/cli/sandbox/examples/claude-code
#
# Then run it with `leastpilot run --sandbox`; see docs/quickstart.md §5.
FROM mandate-sandbox

# Pinned, never "latest": the sandbox is verified against a version, not a tag.
RUN npm install -g @anthropic-ai/claude-code@2.1.232 && npm cache clean --force
