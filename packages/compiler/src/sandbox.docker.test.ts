import { execFileSync } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { MandateSchema, markValidated, type ValidatedMandate } from "@mandate-dev/schema";
import { compileEgress } from "./egress.js";

/**
 * The sandbox, verified against a real container (R9b, Decision D3).
 *
 * D3 calls this layer "the control that actually holds", and
 * `docs/enforced-where.md` says so to a reader. A container recipe that is
 * never run cannot support that claim — and the first version of this one did
 * not start at all: `iptables` was missing from the image, and the generated
 * squid config was fatal to squid twice over.
 *
 * Needs Docker and a network, so it is gated. It spends no money:
 *
 *   MANDATE_SANDBOX=1 pnpm --filter @mandate-dev/compiler test sandbox
 */
const enabled = process.env["MANDATE_SANDBOX"] === "1";

const SANDBOX_DIR = fileURLToPath(new URL("../../../sandbox", import.meta.url));
const IMAGE = "mandate-sandbox-test";

const mandate = (allow: string[]): ValidatedMandate => markValidated(MandateSchema.parse({
  mandate: "fix-issue-42", task: "t", requestedBy: "user:a", expiresInMinutes: 60,
  ceiling: "c@v1",
  grants: [{ action: "repo.read", enforcedBy: "token", resources: ["acme/api"] }],
  destinations: { allow },
}), {
  ceilingId: "c@v1", userLevel: "push",
  checkedAt: "2026-10-03T00:00:00.000Z", grantProofs: [],
});

interface Run {
  readonly status: number;
  readonly output: string;
  readonly checks: Readonly<Record<string, string>>;
}

/** Runs the sandbox's own verification script and parses its `name=result` lines. */
function runSandbox(opts: {
  squidConf: string;
  capNetAdmin?: boolean;
  allowedIp?: string;
  entrypoint?: string;
}): Run {
  const args = ["run", "--rm"];
  if (opts.capNetAdmin !== false) args.push("--cap-add=NET_ADMIN");
  args.push("-e", `MANDATE_SQUID_CONF=${opts.squidConf}`);
  if (opts.allowedIp !== undefined) {
    args.push("-e", `MANDATE_VERIFY_ALLOWED_IP=${opts.allowedIp}`);
  }
  if (opts.entrypoint !== undefined) {
    args.push("-v", `${opts.entrypoint}:/usr/local/bin/entrypoint.sh:ro`);
  }
  args.push(IMAGE, "node", "/usr/local/lib/mandate-verify.mjs");

  let status = 0;
  let output = "";
  try {
    output = execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? 1;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }

  const checks: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = /^((?:proxy|direct)\.[a-z-]+)=(.+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) checks[m[1]] = m[2];
  }
  return { status, output, checks };
}

describe.skipIf(!enabled)("the agent sandbox, against a real container", () => {
  const conf = compileEgress(mandate(["github.com/acme/api"])).squidConf;
  let allowedIp = "";

  beforeAll(async () => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, SANDBOX_DIR], { stdio: "pipe" });
    // Resolved on the host, because the agent has no DNS of its own.
    allowedIp = (await resolve4("github.com"))[0] ?? "";
  }, 600_000);

  it("tunnels to a host the mandate allows", () => {
    expect(runSandbox({ squidConf: conf }).checks["proxy.allowed"]).toBe("200");
  });

  it("refuses a host the mandate never named", () => {
    expect(runSandbox({ squidConf: conf }).checks["proxy.unlisted"]).toBe("403");
  });

  // The plan compiled each host into a `.${host}` ACL. That form matches every
  // subdomain, so a mandate naming github.com/acme/api would have reached
  // gist.github.com — a channel it never named, and one the proxy's own
  // destinationAllowed refuses for the same destination.
  it("refuses a subdomain of an allowed host", () => {
    expect(runSandbox({ squidConf: conf }).checks["proxy.subdomain-of-allowed"]).toBe("403");
  });

  it("refuses an allowed host on a port other than 443", () => {
    expect(runSandbox({ squidConf: conf }).checks["proxy.allowed-host-other-port"]).toBe("403");
  });

  it("blocks direct egress, so the proxy is the only route out", () => {
    const { checks } = runSandbox({ squidConf: conf, allowedIp });
    expect(checks["direct.unlisted-ip"]).toMatch(/^blocked:/);
    // Even an allowed host: the allowlist lives at the proxy, and the proxy is
    // the only way to reach anything at all.
    expect(checks["direct.allowed-host-ip"]).toMatch(/^blocked:/);
  });

  it("gives the agent no resolver of its own", () => {
    expect(runSandbox({ squidConf: conf }).checks["direct.dns"]).toMatch(/^blocked:/);
  });

  // Without NET_ADMIN the rules cannot load. Starting the agent anyway would
  // run it with egress wide open while the docs claim this layer holds.
  it("refuses to start the agent when it cannot install the firewall rules", () => {
    const run = runSandbox({ squidConf: conf, capNetAdmin: false });
    expect(run.status).not.toBe(0);
    expect(run.checks).toEqual({});
    expect(run.output).toMatch(/iptables/);
  });

  it("refuses to start on a squid config squid will not load", () => {
    const broken = conf.replace(
      /^acl mandate_allowed dstdomain .*$/m,
      "acl mandate_allowed dstdomain .api.github.com .github.com",
    );
    const run = runSandbox({ squidConf: broken });
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/subdomain of/);
  });
});

// Negative controls. Without these the checks above could be passing because
// the agent has no network at all rather than because the rules work.
describe.skipIf(!enabled)("the sandbox checks discriminate", () => {
  const conf = compileEgress(mandate(["github.com/acme/api"])).squidConf;

  beforeAll(() => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, SANDBOX_DIR], { stdio: "pipe" });
  }, 600_000);

  it("allows the subdomain once the ACL is widened to a leading dot", () => {
    const wide = conf.replace(
      /^acl mandate_allowed dstdomain .*$/m,
      "acl mandate_allowed dstdomain .github.com",
    );
    const { checks } = runSandbox({ squidConf: wide });
    expect(checks["proxy.allowed"]).toBe("200");
    expect(checks["proxy.subdomain-of-allowed"]).toBe("200");
  });

  it("leaks direct egress once the firewall rules are removed", () => {
    const stripped = readFileSync(join(SANDBOX_DIR, "entrypoint.sh"), "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("iptables "))
      .join("\n");
    // The real entrypoint minus its rules, so the only difference between this
    // run and the one above is the firewall.
    expect(stripped).not.toContain("iptables -A");
    const path = join(tmpdir(), "mandate-noiptables-entrypoint.sh");
    writeFileSync(path, stripped, "utf8");
    chmodSync(path, 0o755);
    const { checks } = runSandbox({ squidConf: conf, entrypoint: path });
    expect(checks["direct.unlisted-ip"]).toBe("LEAKED");
    expect(checks["direct.dns"]).toBe("LEAKED");
  });
});
