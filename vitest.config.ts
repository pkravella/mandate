import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 removed `vitest.workspace.ts` and the `workspace` option;
    // monorepo projects are declared here instead. Each package carries its own
    // vitest.config.ts, which is where the source aliases live -- a root-level
    // resolve.alias does not propagate into projects.
    projects: ["packages/*"],
    // Defensive: build output must never be collected as a test, even if a
    // tsconfig change starts emitting tests again.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
