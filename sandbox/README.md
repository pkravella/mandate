# The agent sandbox

R9b, Decision D3. The layer that actually closes egress.

The MCP proxy bounds the destinations that appear in tool *arguments* (R9a).
This bounds the network, because an agent with a shell, a `git push` to a remote
it configures itself, or a `curl` never transits the proxy at all. Until this
container exists, destination enforcement is advisory —
[`docs/enforced-where.md`](../docs/enforced-where.md) says so.

## Running it

```bash
docker build -t mandate-sandbox sandbox
docker run --rm --cap-add=NET_ADMIN \
  -e MANDATE_SQUID_CONF="$(node -e '...compileEgress(m).squidConf...')" \
  mandate-sandbox <command>
```

`--cap-add=NET_ADMIN` is required: without it the firewall rules cannot be
loaded, and the entrypoint exits rather than running the agent with egress open.

`MANDATE_SQUID_CONF` is `compileEgress(mandate).squidConf` from
`@mandate-dev/compiler`. It is passed as an environment variable rather than
mounted so that nothing has to be written to a shared filesystem.

## What it does

- `squid` on `127.0.0.1:3128`, tunnelling only to a host the mandate allows, on
  port 443, by `CONNECT` only.
- `iptables` and `ip6tables` rules that reject every other outbound packet from
  the `agent` uid, DNS included — with `HTTPS_PROXY` set the proxy resolves
  names, so the agent never needs a resolver, and a direct one would be a
  channel of its own. The IPv6 rules were missing until Phase 5: on a Docker
  network with IPv6 enabled the agent connected straight out over v6 while every
  IPv4 check said blocked. They are skipped only when the kernel has no IPv6 at
  all, and otherwise must load or the container exits.
- The agent runs unprivileged, so it cannot rewrite the proxy config or the
  rules.
- The squid access log is tailed to the container's stdout. Every allowed and
  denied egress attempt lands there, which is the audit record for traffic the
  action graph (R8) cannot see.

## Checking it yourself

`verify.mjs` runs inside the sandbox as `agent` and prints one line per check:

```bash
docker run --rm --cap-add=NET_ADMIN -e MANDATE_SQUID_CONF="..." \
  mandate-sandbox node /usr/local/lib/mandate-verify.mjs
```

Against a mandate allowing `github.com/acme/api`:

```
proxy.allowed=200
proxy.subdomain-of-allowed=403
proxy.unlisted=403
proxy.allowed-host-other-port=403
direct.unlisted-ip=blocked:ECONNREFUSED
direct.allowed-host-ip=blocked:ECONNREFUSED
direct.dns=blocked:ECONNREFUSED
```

With `MANDATE_VERIFY_V6_TARGET="<addr> <port>"` naming a listener reachable over
IPv6, it also prints `direct.ipv6=blocked:…`. There is no public IPv6 target
every network can reach, so the gated test stands one up on an IPv6-enabled
Docker network of its own.

`direct.allowed-host-ip` is the one worth reading twice: even a host the mandate
allows is unreachable directly, because the allowlist lives at the proxy and the
proxy is the only route.

The same checks run as a gated test, with negative controls that widen the ACL
and strip the firewall rules — IPv4 and IPv6 separately — to confirm they can
actually fail:

```bash
MANDATE_SANDBOX=1 pnpm --filter @mandate-dev/compiler test sandbox
```

## What it does not close

Data sent to an **allowed** destination is not tracked. A public pull request
body is a valid exfiltration channel, and the bytes travel to GitHub either way.
That is R14's taint tracking, which is P1 and absent. The sandbox also does
nothing at all if the agent is run outside it.
