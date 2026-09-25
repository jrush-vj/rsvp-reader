import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Browser development proxies the Flask API. In packaged Tauri builds the
// client resolves its loopback API address from the Rust host.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:5000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // Flask serves this directory, so keep the asset names predictable and the
    // sourcemaps out of the shipped bundle.
    sourcemap: false,
    /*
     * Framework code in its own chunks.
     * -----------------------------------------------------------------------
     * Vite's default is to put every module reached by more than one entry into
     * a single shared chunk, and to leave the rest where they landed. With the
     * pages split by route, that already keeps the reader out of the first
     * load; these groups go one step further and separate the three things that
     * change on completely different schedules:
     *
     *   vendor-react     React, the router — republished on a major release
     *   vendor-motion    framer-motion — republished on its own cadence
     *   app              our code, republished on every deploy
     *
     * The point is cache life, not first-load size: `react` is currently in the
     * entry chunk, and a one-line change to a component invalidates the whole
     * file. Split this way, an app-only deploy leaves both vendor chunks — the
     * large majority of the JavaScript — untouched in every visitor's cache.
     * The `immutable` header Flask sends for `/assets/` is what makes that
     * hold; without it the browser would revalidate anyway.
     *
     * The groups are matched by module path rather than by package name so that
     * `react` does not also capture `react-dom`, `react-router-dom` and every
     * `/react`-prefixed path in the tree — the order of these checks is the
     * whole implementation.
     *
     * One caveat worth stating: over-splitting is a real cost. Each chunk is a
     * separate request and a separate parse, and a chunk graph with a cycle
     * between vendors will fetch them in sequence rather than in parallel. Three
     * groups is a deliberate stopping point — enough to isolate what is stable,
     * not so many that the waterfall is the bottleneck.
     */
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react-router")) return "vendor-react";
          if (id.includes("/react-dom/") || id.includes("/react/")) return "vendor-react";
          if (id.includes("/scheduler/")) return "vendor-react";
          if (id.includes("/framer-motion/") || id.includes("/motion-")) return "vendor-motion";
          return undefined;
        },
      },
    },
  },
});
