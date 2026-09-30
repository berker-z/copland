/* ============================================================================
   The Worker's bindings and vars, in one place. Keep in step with
   wrangler.jsonc: every route receives this typed.
   ========================================================================== */

export interface Env {
  /* --- bindings --- */
  DB: D1Database;
  /** The built SPA, served for anything not under /api or /auth. */
  ASSETS: Fetcher;
  /** Live-update hubs, one per user (worker/live.ts). */
  LIVE: DurableObjectNamespace<import("./live").LiveHub>;
  /** R2: task attachments. Served back through the Worker, never public. */
  FILES: R2Bucket;

  /* --- vars (public identifiers, not secrets) --- */
  /** The OAuth client id from Google Cloud ("….apps.googleusercontent.com"). */
  GOOGLE_CLIENT_ID: string;
  /**
   * Comma-separated emails that are always admins, resolved without the
   * database. On a fresh instance this is the only way in, since nobody can
   * have been invited yet.
   */
  ADMIN_EMAILS: string;
  /** "invite" | "open" | "closed". Anything else reads as "invite". */
  SIGNUP: string;

  /* --- secrets (`wrangler secret put`; .dev.vars locally) --- */
  GOOGLE_CLIENT_SECRET: string;
  /** 32 random bytes, base64: the AES-GCM key for the vault (worker/vault.ts). */
  VAULT_KEY: string;

  /**
   * LOCAL DEVELOPMENT ONLY. With no session, act as this email, created as an
   * admin on first use. Honoured only for requests to localhost, so it is
   * inert in any deployment even if set there by mistake. See viewer.ts.
   */
  DEV_USER_EMAIL?: string;
}
