/* ============================================================================
   OAuth 2.1 for AI assistants: the "Connect" button in claude.ai.
   ----------------------------------------------------------------------------
   The MCP authorization flow, and only as much of OAuth as it needs:

     /.well-known/oauth-protected-resource[/mcp]   RFC 9728: /mcp is guarded
                                                   by this server
     /.well-known/oauth-authorization-server       RFC 8414: where to go
     POST /oauth/register                          RFC 7591: an app registers
                                                   itself (grants nothing)
     GET  /oauth/authorize                         sign in with Google if
                                                   needed, then a consent page
     POST /oauth/authorize                         the person's answer
     POST /oauth/token                             code → tokens (PKCE S256),
                                                   refresh → new tokens

   Public clients only (no client secrets): every client is an app on
   someone's machine or its maker's servers, and PKCE is what binds the code
   to the app that asked. Redirects must match a registered URI exactly.
   The consent page is where the person sees which app, where it will send
   them afterwards, and chooses read-only or read and write.
   ========================================================================== */

import type { ApiTokenScope } from "@/domain/types";
import type { Env } from "./env";
import { HttpError, nowIso, randomToken, sha256Base64url, sha256Hex } from "./http";
import { issueOAuthTokens, refreshOAuthTokens } from "./tokens";
import { browserUser } from "./viewer";

const CODE_TTL_MS = 10 * 60 * 1000;
/* Real registrations are a few hundred bytes: ten 500-character redirects
   and an 80-character name fit comfortably. Token requests are smaller. */
const REGISTER_MAX_BYTES = 8 * 1024;
const TOKEN_MAX_BYTES = 8 * 1024;

/** Anyone may read the metadata and call the token endpoint; no cookies are involved. */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS, ...extra },
  });
}

const oauthError = (error: string, description: string, status = 400) =>
  jsonResponse({ error, error_description: description }, status);

export function protectedResourceMetadata(origin: string): Response {
  return jsonResponse({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
    resource_name: "Copland",
  });
}

export function authorizationServerMetadata(origin: string): Response {
  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
    authorization_response_iss_parameter_supported: true,
  });
}

/* ---------------------------------------------------------- registration --- */

/**
 * Where an app may send a person back to: https anywhere, http only to this
 * machine (Claude Code and friends listen on localhost), or an app's own
 * scheme (cursor://). Never a script or data URL.
 */
function acceptableRedirect(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return !["javascript:", "data:", "file:", "blob:", "vbscript:"].includes(url.protocol);
}

/**
 * A request body, read as text up to a limit. Registration and the token
 * endpoint are open to anyone, so neither buffers more than a real client
 * would ever send. Null when the body is over the limit.
 */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  const text = await request.text();
  return text.length > limit ? null : text;
}

/** POST /oauth/register { redirect_uris, client_name? } */
export async function register(request: Request, env: Env): Promise<Response> {
  const text = await boundedText(request, REGISTER_MAX_BYTES);
  if (text === null) return oauthError("invalid_client_metadata", "Registration body is too large");
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return oauthError("invalid_client_metadata", "Body must be a JSON object");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(acceptableRedirect)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https, http://localhost, or an app scheme");
  }
  const name =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 80)
      : "Unnamed app";
  const clientId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?1, ?2, ?3)`)
    .bind(clientId, name, JSON.stringify(uris))
    .run();
  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

async function findClient(env: Env, clientId: string | null): Promise<Client | null> {
  if (!clientId) return null;
  const row = await env.DB.prepare(`SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?1`)
    .bind(clientId)
    .first<{ client_id: string; client_name: string; redirect_uris: string }>();
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

/* ------------------------------------------------------------- authorize --- */

interface AuthRequest {
  client: Client;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: ApiTokenScope;
}

/**
 * The parts of an authorization request that decide whether it is safe to
 * redirect at all. A bad client or redirect is shown as a page, never
 * bounced to the (unverified) redirect URI.
 */
async function readAuthRequest(env: Env, params: URLSearchParams): Promise<AuthRequest | string> {
  const client = await findClient(env, params.get("client_id"));
  if (!client) return "This app is not registered here. Start the connection again from the app.";
  const redirectUri = params.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!client.redirect_uris.includes(redirectUri)) return "The app's return address does not match the one it registered.";
  if (params.get("response_type") !== "code") return "Unsupported response_type; only code is.";
  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge || params.get("code_challenge_method") !== "S256") {
    return "The app did not use PKCE (S256), which is required.";
  }
  /* "read" alone asks for read-only; anything else, or nothing, is read and write. */
  const asked = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const scope: ApiTokenScope = asked.length === 0 || asked.includes("write") ? "write" : "read";
  return { client, redirectUri, state: params.get("state"), codeChallenge, scope };
}

function redirectTo(target: string, params: Record<string, string | null>): Response {
  const url = new URL(target);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
}

/** GET and POST /oauth/authorize. The caller (index.ts) has refused a cross-site POST. */
export async function authorize(request: Request, env: Env, url: URL): Promise<Response> {
  const params = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams;
  const parsed = await readAuthRequest(env, params);
  if (typeof parsed === "string") return page("can't connect", `<p>${esc(parsed)}</p>`, 400);

  const user = await browserUser(request, env);
  if (!user) {
    if (request.method === "POST") throw new HttpError(401, "Not signed in");
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, { status: 302, headers: { location: `/auth/google?next=${next}` } });
  }

  if (request.method === "GET") return consentPage(parsed, user.name, user.email, url);

  if (params.get("decision") !== "allow") {
    return redirectTo(parsed.redirectUri, { error: "access_denied", state: parsed.state, iss: url.origin });
  }
  const scope: ApiTokenScope = params.get("access") === "read" ? "read" : "write";
  const code = randomToken();
  await env.DB.batch([
    /* Housekeeping on the way in, as createSession does for sessions: a code
       nobody redeemed is never deleted by anything else. */
    env.DB.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?1`).bind(nowIso()),
    env.DB.prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      await sha256Hex(code),
      parsed.client.client_id,
      user.id,
      parsed.redirectUri,
      parsed.codeChallenge,
      scope,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
    ),
  ]);
  return redirectTo(parsed.redirectUri, { code, state: parsed.state, iss: url.origin });
}

/* ----------------------------------------------------------------- token --- */

/**
 * The token request's parameters. OAuth says form-encoded; some clients send
 * JSON, which is accepted if it is a flat object. Null for anything else, so
 * a malformed body is the client's error (invalid_request), not a 500.
 */
function tokenParams(type: string, text: string): URLSearchParams | null {
  if (!type.includes("application/json")) return new URLSearchParams(text);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") params.set(k, v);
    else if (typeof v === "number" || typeof v === "boolean") params.set(k, String(v));
    else if (v !== null) return null;
  }
  return params;
}

/**
 * POST /oauth/token. Answers with the tokens and, for a fresh grant, the
 * user it was issued to, so index.ts can tell their settings tab.
 */
export async function token(request: Request, env: Env): Promise<{ response: Response; userId: string | null }> {
  const text = await boundedText(request, TOKEN_MAX_BYTES);
  const fail = (error: string, description: string, status = 400) => ({
    response: oauthError(error, description, status),
    userId: null,
  });
  if (text === null) return fail("invalid_request", "Request body is too large");
  const params = tokenParams(request.headers.get("content-type") ?? "", text);
  if (!params) return fail("invalid_request", "Body must be form-encoded, or a flat JSON object");
  const client = await findClient(env, params.get("client_id"));
  if (!client) return fail("invalid_client", "Unknown client_id", 401);

  const grant = params.get("grant_type");
  if (grant === "refresh_token") {
    const refreshed = await refreshOAuthTokens(env.DB, params.get("refresh_token") ?? "", client.client_id);
    return refreshed
      ? { response: jsonResponse(refreshed), userId: null }
      : fail("invalid_grant", "Refresh token is invalid or expired");
  }
  if (grant !== "authorization_code") return fail("unsupported_grant_type", "Unsupported grant_type");

  const code = params.get("code") ?? "";
  const verifier = params.get("code_verifier") ?? "";
  /* Single use: the row is deleted whether or not the rest checks out. */
  const row = await env.DB.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?1 RETURNING *`)
    .bind(await sha256Hex(code))
    .first<{
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: ApiTokenScope;
      expires_at: string;
    }>();
  if (
    !row ||
    row.client_id !== client.client_id ||
    row.expires_at < nowIso() ||
    (params.get("redirect_uri") !== null && params.get("redirect_uri") !== row.redirect_uri) ||
    !verifier ||
    (await sha256Base64url(verifier)) !== row.code_challenge
  ) {
    return fail("invalid_grant", "Authorization code is invalid, expired, or does not match");
  }
  const issued = await issueOAuthTokens(env.DB, {
    userId: row.user_id,
    clientId: client.client_id,
    clientName: client.client_name,
    scope: row.scope,
  });
  return { response: jsonResponse(issued), userId: row.user_id };
}

/* ------------------------------------------------------------------ pages --- */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * A plain server-rendered page in the Splits look: one square pane with a
 * hairline border on the terminal ground. It is served by the Worker, not
 * the SPA, so it cannot use the app's stylesheet; the role colours are the
 * default (nord) theme's values from src/styles/themes.css, named by role.
 * Its own CSP: inline style, no script at all, and a form that may only post
 * here and then redirect to the app's registered address.
 */
function page(title: string, body: string, status = 200, formTargets: string[] = []): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · copland</title>
<style>
  :root { color-scheme: dark;
    --surface: 38 43 53; --raised: 49 56 71; --bar: 30 42 58; --divider: 23 28 38;
    --ink: 216 222 233; --bright: 236 239 244; --muted: 97 110 136; --faint: 76 86 106;
    --accent: 136 192 208; --blue: 129 161 193; --yellow: 235 203 139; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px;
         background: rgb(var(--divider)); color: rgb(var(--ink));
         font: 14px/1.6 "JetBrains Mono", ui-monospace, monospace; }
  main { width:100%; max-width:480px; background: rgb(var(--surface)); border: 1px solid rgb(var(--faint)); }
  header { padding: 10px 20px; border-bottom: 1px solid rgb(var(--divider)); color: rgb(var(--blue)); letter-spacing: 0.08em; }
  section { padding: 16px 20px; }
  p { margin: 0 0 12px; color: rgb(var(--muted)); }
  strong { color: rgb(var(--bright)); font-weight: 400; }
  code { color: rgb(var(--yellow)); word-break: break-all; }
  fieldset { border: 1px solid rgb(var(--divider)); margin: 0 0 12px; padding: 4px 12px; }
  label { display:flex; gap:10px; align-items:flex-start; padding:8px 0; cursor:pointer; }
  label small { display:block; color: rgb(var(--muted)); }
  input[type=radio] { accent-color: rgb(var(--accent)); margin-top: 5px; }
  footer { display:flex; gap:12px; justify-content:flex-end; padding: 12px 20px;
           border-top: 1px solid rgb(var(--divider)); background: rgb(var(--bar) / 0.6); }
  button { font: inherit; padding: 6px 12px; cursor: pointer; border: 1px solid rgb(var(--faint));
           background: rgb(var(--raised)); color: rgb(var(--ink)); }
  button:hover, button:focus-visible { border-color: rgb(var(--accent)); color: rgb(var(--accent)); outline: none; }
  button.primary { background: rgb(var(--blue)); border-color: rgb(var(--blue)); color: rgb(var(--surface)); }
  button.primary:hover, button.primary:focus-visible { background: rgb(var(--accent)); border-color: rgb(var(--accent)); color: rgb(var(--surface)); }
</style></head>
<body><main><header>${esc(title)}</header>${body}</main></body></html>`;
  const formAction = ["'self'", ...formTargets].join(" ");
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

function consentPage(req: AuthRequest, name: string, email: string, url: URL): Response {
  const target = new URL(req.redirectUri);
  const web = target.protocol === "https:" || target.protocol === "http:";
  const where = web ? target.host : target.protocol;
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope", "resource"]
    .map((k) => {
      const v = url.searchParams.get(k);
      return v === null ? "" : `<input type="hidden" name="${k}" value="${esc(v)}">`;
    })
    .join("");
  const body = `
<form method="post" action="/oauth/authorize">
${hidden}
<section>
  <p><strong>${esc(req.client.client_name)}</strong> wants to use copland as <strong>${esc(name)}</strong> (${esc(email)}).</p>
  <p>It will see the boards and tasks you can see${
    req.scope === "write" ? " and, if you allow it, change them as you" : ""
  }. Its changes show in a task's history as “via ${esc(req.client.client_name)}”.</p>
  <fieldset>
    <label><input type="radio" name="access" value="write"${req.scope === "write" ? " checked" : ""}>
      <span><strong>read and write</strong><small>create, edit, move and comment on tasks</small></span></label>
    <label><input type="radio" name="access" value="read"${req.scope === "read" ? " checked" : ""}>
      <span><strong>read only</strong><small>can't change anything</small></span></label>
  </fieldset>
  <p>Afterwards you go back to <code>${esc(where)}</code>. Disconnect any time in settings › integrations.</p>
</section>
<footer>
  <button type="submit" name="decision" value="deny">[ deny ]</button>
  <button type="submit" name="decision" value="allow" class="primary">allow</button>
</footer>
</form>`;
  return page("connect an app", body, 200, [web ? target.origin : target.protocol]);
}
