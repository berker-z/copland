import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * One id for this build, read once here so the browser bundle and the Worker
 * get the same value (src/domain/version.ts). The time is in it because a
 * deploy is not always a new commit; `npm run dev` gets a new id per start.
 */
function buildVersion(): string {
  let commit = "nogit";
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* not a checkout; the time alone still tells builds apart */
  }
  return `${commit}-${Date.now().toString(36)}`;
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
