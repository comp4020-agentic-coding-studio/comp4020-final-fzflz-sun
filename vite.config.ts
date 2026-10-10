import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two pages: the single-player game (index.html) and the co-op client
// (coop.html). Vite's dev server serves any .html file by path without this,
// but `vite build` only bundles index.html unless every entry is listed here.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        coop: resolve(import.meta.dirname, "coop.html"),
      },
    },
  },
});
