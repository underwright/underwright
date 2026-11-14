import { configDefaults, defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    maxWorkers: 4,
    testTimeout: 15000,
    // Agent worktrees live under .claude/worktrees/<name>/ and carry their own
    // test/ trees; without this, the main checkout runs every branch's tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Hermetic default: never let tests read the repo's underwright.policy.json
    // (loadPolicy falls back to cwd). Points at a file that does not exist, so
    // DEFAULT_POLICY applies. Tests that need a policy set UNDERWRIGHT_POLICY.
    env: { UNDERWRIGHT_POLICY: join(tmpdir(), "uw-vitest-no-policy.json") },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage",
    },
  },
});
