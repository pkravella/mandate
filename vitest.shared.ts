import { fileURLToPath } from "node:url";

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Workspace packages resolve to their TypeScript source during tests, not to
 * their built `dist`.
 *
 * Without this, `@mandate-dev/catalog` resolves through node_modules to
 * dist/index.js, so editing the catalog and running the validator's tests
 * silently reads a stale build. That can make a test pass that should fail,
 * which is the worst possible failure mode for a test suite. Each package's
 * own vitest.config.ts applies this, because a root-level `resolve.alias` does
 * not propagate into Vitest projects.
 */
export const workspaceAlias: Readonly<Record<string, string>> = {
  "@mandate-dev/catalog": src("catalog"),
  "@mandate-dev/schema": src("schema"),
  "@mandate-dev/validator": src("validator"),
  "@mandate-dev/writer": src("writer"),
};
