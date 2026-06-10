import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

// In production the Express server rewrites /play/:id and /create to their
// HTML pages. This mirrors that behavior in the Vite dev server.
function pageRoutes(): Plugin {
  return {
    name: "page-routes",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/play\/[A-Za-z0-9_-]+/.test(req.url)) {
          req.url = "/play.html";
        } else if (req.url && /^\/create\/?(\?|$)/.test(req.url)) {
          req.url = "/create.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [pageRoutes()],
  build: {
    rollupOptions: {
      input: {
        home: resolve(__dirname, "index.html"),
        create: resolve(__dirname, "create.html"),
        play: resolve(__dirname, "play.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
