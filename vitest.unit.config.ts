import { defineConfig } from "vitest/config";

// Pure game-rule tests in src/, plus the co-op server's own pure room logic in
// server/. Kept apart from vitest.config.ts, whose spec/ suite needs a running app.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
});
