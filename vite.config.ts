import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * One id for this build, so the browser bundle and the Worker can tell they
 * match (src/domain/version.ts): the commit. Nothing that changes between
 * evaluations, because the build reads this file once for the bundle and
 * again for the Worker; a timestamp here made them never agree (COPL-25).
 * The same commit is the same code, so redeploying it asks nobody to reload.
 */
function buildVersion(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "nogit";
  }
}

/**
 * The Cloudflare plugin runs the real Worker (workerd) in dev, so /api and
 * /auth behave locally as they do deployed, with the same bindings. There is
 * no separate API server and no proxy config.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  /* Top-level, so it reaches every environment: the client and the Worker. */
  define: {
    __COPLAND_VERSION__: JSON.stringify(buildVersion()),
  },
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
