# The agent sandbox (R9b, Decision D3).
#
# An MCP proxy sees MCP traffic and nothing else: an agent with a shell, a
# `git push` to a remote it configures itself, or a `curl` never transits it.
# This container is the layer that actually closes egress, so the mandate's
# destination list means something for traffic the proxy never sees.
#
# Build and run from the repository root:
#
#   docker build -t mandate-sandbox sandbox
#   docker run --rm --cap-add=NET_ADMIN \
#     -e MANDATE_SQUID_CONF="$(mandate egress --mandate m.yaml)" \
#     mandate-sandbox <command>
#
# --cap-add=NET_ADMIN is required. Without it the iptables rules cannot be
# loaded, and the entrypoint exits rather than running the agent with egress
# wide open.
FROM node:22-bookworm-slim

# iptables is what actually closes egress. squidclient is deliberately absent:
# the readiness check is a TCP connect, so it cannot quietly degrade into a
# sleep that looks like a check when the package is missing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      squid iptables ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# The agent runs unprivileged, so it cannot rewrite the proxy config or the
# firewall rules that bound it.
RUN useradd --create-home --shell /bin/bash agent

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY verify.mjs /usr/local/lib/mandate-verify.mjs
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Belt: a well-behaved tool honours these. Braces: the iptables rules reject
# everything else from the agent uid, so a tool that ignores them fails at the
# network layer instead of reaching the internet.
ENV HTTP_PROXY=http://127.0.0.1:3128 \
    HTTPS_PROXY=http://127.0.0.1:3128 \
    http_proxy=http://127.0.0.1:3128 \
    https_proxy=http://127.0.0.1:3128 \
    NO_PROXY=127.0.0.1,localhost \
    no_proxy=127.0.0.1,localhost

# Root to install the rules; the entrypoint drops to `agent` with setpriv.
USER root
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
