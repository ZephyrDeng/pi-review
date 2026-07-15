import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest config for the pi-review package.
 *
 * - node environment (CLI/extension unit tests, no DOM).
 * - Alias the package's own name to its TypeScript source so tests do not
 *   require a `tsc` build first (e.g. panel-tool.test.ts imports
 *   `@zephyrdeng/pi-review` → resolves to src/index.ts instead of dist).
 * - Tests live under src/ and extensions/.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "extensions/**/*.test.ts"],
    // node:test's `test()` is replaced by vitest's via import rewrite; keep
    // reporters lean for CI.
    reporters: ["default"],
    // The signal/abort timing tests in child-process.test.ts spawn real
    // subprocesses and are wall-clock sensitive; under parallel load the abort
    // grace margin can slip. Retry absorbs that flakiness without forcing the
    // whole suite to run serially (which would cost ~10s).
    retry: 2,
  },
  resolve: {
    alias: {
      "@zephyrdeng/pi-review": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
});
