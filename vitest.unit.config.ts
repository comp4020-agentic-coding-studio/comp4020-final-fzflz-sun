import { defineConfig } from "vitest/config";

// Pure game-rule tests in src/. Kept apart from vitest.config.ts, whose spec/
// suite needs a running app.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
