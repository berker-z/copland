/* ============================================================================
   The instance's GitHub App (COPL-73; docs/GITHUB.md).
   ----------------------------------------------------------------------------
   An admin makes it with GitHub's manifest flow: the app posts a manifest
   (name, URLs, read-only permissions, the four events we use) to GitHub, the
   admin confirms on github.com, and GitHub redirects back to
   /auth/github/callback with a code we trade for the App's id, private key
   and webhook secret. Those are kept sealed under VAULT_KEY in github_app.

   The App reads and never writes. Copland calls GitHub for one thing so far:
   the repos the App is installed on, which is what a board can be connected
   to. That takes a JWT signed with the App's key, traded for an installation
   token per installation (both short-lived, never stored).

   GitHub hands out the key as PKCS#1, which WebCrypto can't import, so it
   is wrapped into PKCS#8 once, when stored (pem.ts).
   ========================================================================== */

import type { GithubApp } from "@/domain/types";
import type { Env } from "./env";
import { base64url, fromBase64, HttpError, nowIso } from "./http";
import { pkcs8FromPem } from "./pem";
import { seal, unseal } from "./vault";

const API = "https://api.github.com";
const SEAL_CONTEXT = "github_app";

interface AppRow {
  app_id: number;
  slug: string;
  html_url: string;
  owner_login: string;
  iv: string;
  ciphertext: string;
  created_at: string;
}

/** What is sealed: the key as PKCS#8 (base64 DER) and the webhook secret. */
interface AppSecrets {
  key: string;
  webhookSecret: string;
}

async function appRow(db: D1Database): Promise<AppRow | null> {
  return db.prepare(`SELECT app_id, slug, html_url, owner_login, iv, ciphertext, created_at FROM github_app WHERE id = 1`).first<AppRow>();
}

/** The App as admins and board settings see it, or null when this instance has none. */
export async function githubApp(db: D1Database): Promise<GithubApp | null> {
  const row = await appRow(db);
  return row
    ? { slug: row.slug, htmlUrl: row.html_url, owner: row.owner_login, installUrl: `${row.html_url}/installations/new`, createdAt: row.created_at }
    : null;
}

async function secrets(env: Env): Promise<(AppSecrets & { appId: number }) | null> {
  const row = await appRow(env.DB);
  if (!row) return null;
  return { appId: row.app_id, ...(JSON.parse(await unseal(env, SEAL_CONTEXT, row)) as AppSecrets) };
}

/** The App's webhook secret, or null when there is no App. */
export async function webhookSecret(env: Env): Promise<string | null> {
  return (await secrets(env))?.webhookSecret ?? null;
}

/* --------------------------------------------------------- manifest ---- */

/**
 * What GitHub registers. Read-only permissions; push, pull_request,
 * check_suite and status are all the webhook reads (routes/github.ts).
 * App names are unique across GitHub, so the name carries the host; the
 * admin can still change it on GitHub's page.
 */
export function manifest(origin: string) {
  const host = new URL(origin).host;
  return {
    name: `Copland ${host}`.slice(0, 34),
    url: origin,
    hook_attributes: { url: `${origin}/api/github`, active: true },
    redirect_url: `${origin}/auth/github/callback`,
    setup_url: `${origin}/?github=installed`,
    public: false,
    default_permissions: { metadata: "read", contents: "read", pull_requests: "read", checks: "read", statuses: "read" },
    default_events: ["push", "pull_request", "check_suite", "status"],
  };
}

/** Trade the manifest flow's code for the App, and keep it. Replaces an App made before. */
export async function finishManifest(env: Env, code: string, userId: string): Promise<{ installUrl: string }> {
  const r = await github(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
  const app = (await r.json()) as { id: number; slug: string; html_url: string; owner?: { login?: string }; pem: string; webhook_secret: string };
  const sealed = await seal(env, SEAL_CONTEXT, JSON.stringify({ key: pkcs8FromPem(app.pem), webhookSecret: app.webhook_secret } satisfies AppSecrets));
  await env.DB.prepare(
    `INSERT INTO github_app (id, app_id, slug, html_url, owner_login, iv, ciphertext, created_by, created_at)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (id) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug, html_url = excluded.html_url,
       owner_login = excluded.owner_login, iv = excluded.iv, ciphertext = excluded.ciphertext,
       created_by = excluded.created_by, created_at = excluded.created_at`,
  )
    .bind(app.id, app.slug, app.html_url, app.owner?.login ?? "", sealed.iv, sealed.ciphertext, userId, nowIso())
    .run();
  return { installUrl: `${app.html_url}/installations/new` };
}

/* ------------------------------------------------------------- calls ---- */

async function github(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", "2022-11-28");
  headers.set("user-agent", "copland");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { ...init, headers });
  } catch {
    throw new HttpError(502, "GitHub could not be reached");
  }
  if (!r.ok) throw new HttpError(502, `GitHub answered ${r.status} to ${path.split("?")[0]}`);
  return r;
}

/** The repos the App is installed on, "owner/name" lowercased, across all its installations. */
export async function installedRepos(env: Env): Promise<string[]> {
  const app = await secrets(env);
  if (!app) return [];
  const jwt = await appJwt(app.appId, app.key);
  const installations = (await (await github(`/app/installations?per_page=100`, { token: jwt })).json()) as Array<{ id: number }>;
  const repos = new Set<string>();
  for (const inst of installations) {
    const { token } = (await (await github(`/app/installations/${inst.id}/access_tokens`, { method: "POST", token: jwt })).json()) as { token: string };
    /* Ten pages of a hundred is far more than one person's boards need. */
    for (let page = 1; page <= 10; page++) {
      const body = (await (await github(`/installation/repositories?per_page=100&page=${page}`, { token })).json()) as {
        repositories: Array<{ full_name: string }>;
      };
      for (const r of body.repositories) repos.add(r.full_name.toLowerCase());
      if (body.repositories.length < 100) break;
    }
  }
  return [...repos].sort();
}

/** A ten-minute JWT as the App (RS256), back-dated a minute for clock drift, as GitHub suggests. */
async function appJwt(appId: number, pkcs8: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const part = (o: unknown) => base64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const key = await crypto.subtle.importKey("pkcs8", fromBase64(pkcs8), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}
