# Claude Code in the Mandate sandbox. The image the live run used, 2026-10-09.
#
#   docker build -t mandate-sandbox sandbox
#   docker build -t mandate-agent-claude sandbox/examples/claude-code
#
# Then run it with `mandate run --sandbox`; see docs/quickstart.md §5.
FROM mandate-sandbox

# Pinned, never "latest": the sandbox is verified against a version, not a tag.
RUN npm install -g @anthropic-ai/claude-code@2.1.232 && npm cache clean --force
