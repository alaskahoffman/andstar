// Second build target: the whole player as one self-contained IIFE
// (dist/standalone.js), used by the editor's itch.io export.
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/standalone/main.ts"),
      name: "AndstarStandalone",
      formats: ["iife"],
      fileName: () => "standalone.js",
    },
  },
});
