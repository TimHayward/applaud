import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/src/**/*.test.ts", "shared/src/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      include: ["server/src/**/*.ts", "shared/src/**/*.ts", "web/src/**/*.ts"],
      // index.ts exclusions are entry/barrel files only; route modules are still counted.
      exclude: ["**/*.test.ts", "**/dist/**", "**/index.ts"],
      reportsDirectory: "coverage",
      // Ratchet: set just below current coverage (2026-07: ~38% stmts / 64% branches /
      // 59% funcs) so regressions fail CI. Raise these as coverage grows.
      thresholds: {
        statements: 35,
        branches: 60,
        functions: 55,
        lines: 35,
      },
    },
  },
});
