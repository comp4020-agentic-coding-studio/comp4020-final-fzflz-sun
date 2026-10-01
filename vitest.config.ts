import { defineConfig } from "vitest/config";

// Every test in spec/ runs against the running app, which spec/global-setup.ts
// finds. Only spec/ runs: a test anywhere else needs adding to `include`.
// src/**/*.test.ts are the game-rule tests (turns, cards, formation, saves);
// they don't need the app but run under `pnpm check` with everything else.
export default defineConfig({
  test: {
    include: ["spec/**/*.test.ts", "src/**/*.test.ts"],
    globalSetup: ["./spec/global-setup.ts"],
  },
});
