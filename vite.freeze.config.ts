// Freeze build: the play page alone, under a versioned base, into the committed
// frozen/<version>/ folder (the server maps the /v/<version>/ URL to it). Run once
// per release (`npm run freeze`) and commit the result. The server then serves a
// published game from the frozen player matching the version it was stamped with,
// so updating the engine never changes how an already-published game looks or runs.
// Output lives outside public/ so Vite's publicDir copy doesn't recurse into it.
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;

export default defineConfig({
  base: `/v/${version}/`,
  build: {
    outDir: `frozen/${version}`,
    emptyOutDir: true,
    rollupOptions: {
      input: { play: resolve(__dirname, "play.html") },
    },
  },
});
