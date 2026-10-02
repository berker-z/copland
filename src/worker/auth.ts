/* ============================================================================
   Sign-in: Google OIDC, then a session of our own.
   ----------------------------------------------------------------------------
     GET  /auth/google?next=/b/x        send the browser to Google
     GET  /auth/invite/<code>           the same, carrying an invite
     GET  /auth/calendar                 connect Google Calendar (signed in only)
     GET  /auth/callback?code&state     Google sends it back; verify, sign in
                                        (or save the calendar connection)
     POST /auth/logout                  drop the session

     sessionUser(request, env)          the user behind the cookie, if any

   The authorization code flow with PKCE, done by the Worker: /auth/google
   makes a random state and code verifier, keeps both (and the invite, if any)
   in a short-lived cookie, and redirects. The callback checks the state,
   trades the code for tokens over the back channel with the client secret,
   and verifies the ID token against Google's published keys. Whether that
   person may have an account here is repo/users.ts's call.

   Sessions are a 32-byte random token in an HttpOnly cookie, stored hashed in
   D1. Thirty days from sign-in, not sliding. A deleted row is an ended
   session, which a signed cookie could not give.

   Google identity only proves who someone is. Calendar access is a separate
   grant with its own consent, connected later from settings.
   ========================================================================== */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import {
  base64url,
  fromBase64url,
  nowIso,
  randomToken,
  sha256Base64url,
  sha256Hex,
} from "./http";
import { CALENDAR_SCOPES } from "./calendar/google";
import { findUserById, signIn, SignInRefused, type GoogleProfile, type UserRow } from "./repo/users";
import { saveGoogleAccount } from "./routes/calendar";

const SESSION_COOKIE = "copland_session";
const LOGIN_COOKIE = "copland_login";

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
/** How stale last_seen_at may get before a request refreshes it. */
const TOUCH_MS = 24 * 60 * 60 * 1000;
const LOGIN_MAX_AGE_S = 10 * 60;

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
/** Google has issued both spellings over the years; its docs say accept both. */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/* -------------------------------------------------------------- routes ----- */

/** GET /auth/google and GET /auth/invite/<code>: remember, then off to Google. */
export async function startLogin(request: Request, env: Env, inviteCode: string | null): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const state = randomToken();
  const verifier = randomToken();
  const invite = inviteCode ? await sha256Hex(inviteCode) : null;

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(url),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await sha256Base64url(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${GOOGLE_AUTH}?${params}`,
      "set-cookie": cookie(LOGIN_COOKIE, encodeState({ state, verifier, next, invite, calendarFor: null }), {
        path: "/auth",
        maxAge: LOGIN_MAX_AGE_S,
        secure: url.protocol === "https:",
      }),
    },
  });
}

/**
 * GET /auth/calendar: connect a Google account's calendars. A second consent,
 * separate from sign-in, asking for calendar access and a refresh token
 * (access_type=offline, prompt=consent so Google sends one every time). Only
 * for someone already signed in; the callback checks it is still them.
 */
export async function startCalendarConnect(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const user = await sessionUser(request, env);
  if (!user) return redirect(`/auth/google?next=${encodeURIComponent("/")}`, []);
  const state = randomToken();
  const verifier = randomToken();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(url),
    response_type: "code",
    scope: ["openid", "email", ...CALENDAR_SCOPES].join(" "),
    state,
    code_challenge: await sha256Base64url(verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `${GOOGLE_AUTH}?${params}`,
      "set-cookie": cookie(LOGIN_COOKIE, encodeState({ state, verifier, next: "/", invite: null, calendarFor: user.id }), {
        path: "/auth",
        maxAge: LOGIN_MAX_AGE_S,
        secure: url.protocol === "https:",
      }),
    },
  });
}

/**
 * GET /auth/callback: Google's answer. Every failure lands on the login
 * screen with a short reason in the query string rather than a JSON error,
 * because what reads this response is a person in a browser.
 */
export async function finishLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const login = decodeState(readCookie(request, LOGIN_COOKIE));
  const clearLogin = cookie(LOGIN_COOKIE, "", { path: "/auth", maxAge: 0, secure });
  const fail = (reason: string) => redirect(`/?login=${reason}`, [clearLogin]);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!login || !code || !state || state !== login.state) return fail("failed");
  if (login.calendarFor) return finishCalendarConnect(request, env, login.calendarFor, code, login.verifier, clearLogin);

  let profile: GoogleProfile;
  try {
    const { idToken } = await exchangeCode(env, code, login.verifier, callbackUrl(url));
    profile = await verifyIdToken(env, idToken);
  } catch (error) {
    console.error("Google sign-in failed:", error);
    return fail("failed");
  }

  let user: UserRow;
  try {
    user = await signIn(env, profile, login.invite);
  } catch (error) {
    if (error instanceof SignInRefused) return fail(error.reason);
    throw error;
  }

  const token = await createSession(env, user.id);
  return redirect(login.next, [
    clearLogin,
    cookie(SESSION_COOKIE, token, { path: "/", maxAge: SESSION_DAYS * 24 * 60 * 60, secure }),
  ]);
}

/** The calendar half of the callback. Lands on the dashboard with ?calendar=. */
async function finishCalendarConnect(
  request: Request,
  env: Env,
  userId: string,
  code: string,
  verifier: string,
  clearLogin: string,
): Promise<Response> {
  const done = (result: string) => redirect(`/?calendar=${result}`, [clearLogin]);
  /* Whoever started the connection must be who finishes it. */
  const user = await sessionUser(request, env);
  if (!user || user.id !== userId) return done("failed");
  try {
    const { idToken, refreshToken } = await exchangeCode(env, code, verifier, callbackUrl(new URL(request.url)));
    if (!refreshToken) return done("no_refresh");
    const profile = await verifyIdToken(env, idToken);
    await saveGoogleAccount(env, user.id, profile.email, refreshToken);
    return done("connected");
  } catch (error) {
    console.error("Calendar connect failed:", error);
    return done("failed");
  }
}

/** POST /auth/logout: forget the session on both sides. */
export async function logout(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256Hex(token)).run();
  }
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": cookie(SESSION_COOKIE, "", {
        path: "/",
        maxAge: 0,
        secure: new URL(request.url).protocol === "https:",
      }),
    },
  });
}

/* ------------------------------------------------------------ sessions ----- */

/**
 * The signed-in user, or null when there is no live session. One indexed
 * read; the join drops disabled users and expired rows in the same statement.
 */
export async function sessionUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const hash = await sha256Hex(token);
  const now = new Date();
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.disabled_at IS NULL`,
  )
    .bind(hash, now.toISOString())
    .first<{ user_id: string; last_seen_at: string }>();
  if (!row) return null;

  if (now.getTime() - Date.parse(row.last_seen_at) > TOUCH_MS) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1`)
      .bind(hash, now.toISOString())
      .run();
  }
  return findUserById(env.DB, row.user_id);
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const now = new Date();
  await env.DB.batch([
    /* Housekeeping on the way in: nothing else deletes expired rows. */
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(nowIso()),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)`).bind(
      await sha256Hex(token),
      userId,
      new Date(now.getTime() + SESSION_MS).toISOString(),
    ),
  ]);
  return token;
}

/* -------------------------------------------------------------- google ----- */

async function exchangeCode(
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<{ idToken: string; refreshToken: string | null }> {
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const body = (await response.json()) as { id_token?: string; refresh_token?: string; error?: string };
  if (!response.ok || !body.id_token) {
    throw new Error(`token exchange: ${body.error ?? `HTTP ${response.status}`}`);
  }
  return { idToken: body.id_token, refreshToken: body.refresh_token ?? null };
}

/** Signature, issuer, audience and expiry are jose's job; a verified email is ours. */
async function verifyIdToken(env: Env, idToken: string): Promise<GoogleProfile> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: GOOGLE_ISSUERS,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email || payload.email_verified !== true || typeof payload.sub !== "string") {
    throw new Error("ID token without a verified email");
  }
  return { sub: payload.sub, email, name: typeof payload.name === "string" ? payload.name : null };
}

/* ------------------------------------------------------------- helpers ----- */

function callbackUrl(url: URL): string {
  return `${url.origin}/auth/callback`;
}

/**
 * Only a path on this site is a valid place to return to. Anything else (an
 * absolute URL, a protocol-relative "//evil") becomes the home page, so the
 * login link cannot bounce people elsewhere. Whitespace and control
 * characters are refused outright: browsers strip tabs and newlines from a
 * URL, so "/<tab>/evil" would otherwise arrive as "//evil".
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000- \u007f]/.test(raw)) {
    return "/";
  }
  return raw;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

interface LoginState {
  state: string;
  verifier: string;
  next: string;
  /** sha-256 hex of the invite code, when the browser came through a link. */
  invite: string | null;
  /** Set when this round trip connects a calendar for that user instead of signing in. */
  calendarFor: string | null;
}

function encodeState(s: LoginState): string {
  return base64url(new TextEncoder().encode(JSON.stringify(s)));
}

function decodeState(raw: string | null): LoginState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(raw))) as Partial<LoginState>;
    if (typeof parsed.state !== "string" || typeof parsed.verifier !== "string") return null;
    return {
      state: parsed.state,
      verifier: parsed.verifier,
      next: safeNext(parsed.next ?? null),
      invite: typeof parsed.invite === "string" ? parsed.invite : null,
      calendarFor: typeof parsed.calendarFor === "string" ? parsed.calendarFor : null,
    };
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * HttpOnly always: nothing in the page reads either cookie. Lax lets Google's
 * redirect back carry the login cookie (a top-level GET) while a form POST
 * from another site does not carry the session.
 */
function cookie(name: string, value: string, opts: { path: string; maxAge: number; secure: boolean }): string {
  const parts = [`${name}=${value}`, `Path=${opts.path}`, `Max-Age=${opts.maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
