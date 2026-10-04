import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 removed `vitest.workspace.ts` and the `workspace` option;
    // monorepo projects are declared here instead.
    projects: ["packages/*"],
    // Defensive: build output must never be collected as a test, even if a
    // tsconfig change starts emitting tests again.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
