/* ============================================================================
   Which build this is.
   ----------------------------------------------------------------------------
   A single-page app keeps running the code it loaded until a reload, so an
   open tab can be older than the Worker answering it. The build stamps one id
   (vite.config.ts) into both the browser bundle and the Worker; the Worker
   sends its id on every /api response and the tab compares it with its own.

   Shared by both sides so the header name cannot disagree.
   ========================================================================== */

/* Replaced at build time by vite.config.ts's `define`. */
declare const __COPLAND_VERSION__: string;

/** This build's id: the commit it was built from. */
export const VERSION: string = typeof __COPLAND_VERSION__ === "string" ? __COPLAND_VERSION__ : "unstamped";

/** The response header the Worker reports its version in. */
export const VERSION_HEADER = "x-copland-version";
