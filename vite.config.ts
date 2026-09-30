import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The Cloudflare plugin runs the real Worker (workerd) in dev, so /api and
 * /auth behave locally as they do deployed, with the same bindings. There is
 * no separate API server and no proxy config.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    /* outDir is left to the Cloudflare plugin: it emits dist/client (the SPA)
       next to the Worker bundle, and wrangler.jsonc points at dist/client. */
    sourcemap: true,
  },
});
