import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_FORMAT } from "@leastpilot/proxy";
import { APPROVAL_FORMAT, APPROVE_COMMAND } from "@leastpilot/schema";
import { REVIEW_MARKER } from "./commands/review.js";
import { refusedPassEnv } from "./sandbox.js";

/**
 * Task 7.4: the product is LeastPilot; "mandate" stays the name of the
 * artifact it writes. A rename that misses one place does not fail on its own:
 * an alias for an old package name silently resolves to a stale build, a lint
 * rule naming an old package silently matches nothing, and a filter on an old
 * prefix silently selects nothing. So the product's names are pinned here, and
 * the old ones are searched for across every tracked file.
 */
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const json = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(root(p), "utf8")) as Record<string, unknown>;

describe("the product's names", () => {
  it("publishes every package under @leastpilot, named for its directory", () => {
    expect(json("package.json")["name"]).toBe("leastpilot");
    const dirs = readdirSync(root("packages"));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect(json(`packages/${dir}/package.json`)["name"]).toBe(`@leastpilot/${dir}`);
    }
  });

  it("installs the binary as leastpilot, and only that", () => {
    expect(json("packages/cli/package.json")["bin"]).toEqual({ leastpilot: "./dist/index.js" });
  });

  it("answers /leastpilot approve, and marks its review comment as its own", () => {
    expect(APPROVE_COMMAND).toBe("/leastpilot approve");
    expect(REVIEW_MARKER).toBe("<!-- leastpilot-review");
  });

  // These name the artifact, not the product, and the approval format is
  // inside every digest: renaming it would void every approval already given.
  it("keeps the versioned formats, which name the mandate", () => {
    expect(AUDIT_FORMAT).toBe("mandate-audit/1");
    expect(APPROVAL_FORMAT).toBe("mandate-approval/1");
  });

  // The sandbox's own internals kept the old prefix (MANDATE_RELAY_SECRET),
  // and the operator-facing variables moved to the new one. Both are refused.
  it.each(["LEASTPILOT_APP_KEY_PATH", "LEASTPILOT_AUDIT_KEY_PATH", "MANDATE_RELAY_SECRET", "MANDATE_APP_KEY_PATH"])(
    "refuses to pass %s into the sandbox", (name) => {
      expect(refusedPassEnv(name)).toBeDefined();
    },
  );
});

describe("no product name left over from Mandate", () => {
  // Recorded data keeps the names it was recorded under, and the sandbox
  // repository is still called mandate-sandbox.
  const exempt = (f: string): boolean =>
    (f.startsWith("fixtures/") && !f.endsWith("README.md"))
    || /^docs\/[^/]+\.json$/.test(f) || f === "packages/cli/src/naming.test.ts";
  const files = execFileSync("git", ["ls-files"], { cwd: root("."), encoding: "utf8" })
    .split("\n").filter((f) => f.length > 0 && !exempt(f));

  const hits = (re: RegExp): string[] =>
    files.flatMap((f) => {
      let text: string;
      try {
        text = readFileSync(root(f), "utf8");
      } catch {
        return []; // a deleted-but-staged file
      }
      return text.split("\n").flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []));
    });

  it("searches the repository, not an empty list", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("README.md");
  });

  it("imports no @mandate-dev package", () => {
    expect(hits(/@mandate-dev\b/)).toEqual([]);
  });

  it("reads no operator-facing MANDATE_ variable", () => {
    expect(hits(/\bMANDATE_(APP_|AUDIT_KEY|INSTALLATION_ID|TEST_REPO|LIVE|SANDBOX|SEED|GROUND_TRUTH|BENCH|WRITER_|MCP_CONFIG)/))
      .toEqual([]);
  });

  it("documents no mandate command and no /mandate comment", () => {
    const commands = "validate|widen|serve|run|review|reviewed|export|audit|help|--help|--version";
    expect(hits(new RegExp(`\\bmandate (${commands})\\b`))).toEqual([]);
    expect(hits(/\/mandate (approve|<|\{|')|'\/mandate |#\/mandate |<!-- mandate-review/)).toEqual([]);
  });

  // Found by the final review: prose naming the binary, a security claim
  // citing only the old prefix, and a pointer to a workflow file this rename
  // moved -- none of them a command or a variable the checks above can see.
  it("names the binary leastpilot in prose", () => {
    expect(hits(/(binary|CLI)[^`.]*`mandate`(?![\w-])|`mandate` (entry point|binary)/)).toEqual([]);
  });

  it("never cites the MANDATE_ prefix without the LEASTPILOT_ one", () => {
    expect(hits(/`MANDATE_\*`/).filter((h) => !h.includes("LEASTPILOT_"))).toEqual([]);
  });

  it("points at the workflow files by their new names", () => {
    expect(hits(/(^|[^-\w])mandate\.yml\b|\bmandate-review\.yml\b/)).toEqual([]);
  });
});
