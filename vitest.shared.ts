import { fileURLToPath } from "node:url";

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Workspace packages resolve to their TypeScript source during tests, not to
 * their built `dist`.
 *
 * Without this, `@leastpilot/catalog` resolves through node_modules to
 * dist/index.js, so editing the catalog and running the validator's tests
 * silently reads a stale build. That can make a test pass that should fail,
 * which is the worst possible failure mode for a test suite. Each package's
 * own vitest.config.ts applies this, because a root-level `resolve.alias` does
 * not propagate into Vitest projects.
 */
export const workspaceAlias: Readonly<Record<string, string>> = {
  "@leastpilot/bench": src("bench"),
  "@leastpilot/catalog": src("catalog"),
  "@leastpilot/cli": src("cli"),
  "@leastpilot/compiler": src("compiler"),
  "@leastpilot/proxy": src("proxy"),
  "@leastpilot/replay": src("replay"),
  "@leastpilot/schema": src("schema"),
  "@leastpilot/validator": src("validator"),
  "@leastpilot/writer": src("writer"),
};
