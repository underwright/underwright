import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    testTimeout: 15000,
    exclude: ["**/node_modules/**", "**/.claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage",
    },
  },
});
