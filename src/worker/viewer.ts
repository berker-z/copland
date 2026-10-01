/* ============================================================================
   Viewer resolution: API token or session cookie → user row.
   ========================================================================== */

import type { Viewer } from "@/domain/types";
import { sessionUser } from "./auth";
import type { Env } from "./env";
import { UnauthenticatedError } from "./http";
import { createUser, findUserByEmail, rowToUser, type UserRow } from "./repo/users";
import { bearerFrom, tokenAccess } from "./tokens";

/**
 * A request with an Authorization header is judged by its token alone: a
 * bad token is a 401 even if a session cookie came along too, and it never
 * falls back to the local dev user, so a script never silently acts as
 * whoever's browser (or dev server) it ran against.
 */
export async function resolveViewer(request: Request, env: Env): Promise<Viewer> {
  const secret = bearerFrom(request);
  if (secret !== null || request.headers.has("authorization")) {
    const viaToken = secret ? await tokenAccess(env.DB, secret) : null;
    if (!viaToken) throw new UnauthenticatedError("Invalid, expired or revoked token");
    return { user: rowToUser(viaToken.user), access: viaToken.access };
  }
  const row = await browserUser(request, env);
  if (!row) throw new UnauthenticatedError();
  return { user: rowToUser(row) };
}

/**
 * The person at the browser: the session, or the local dev user. Never a
 * token. The OAuth consent page uses this directly, since approving an app
 * is something only a signed-in person does.
 */
export async function browserUser(request: Request, env: Env): Promise<UserRow | null> {
  const session = await sessionUser(request, env);
  if (session) return session;
  try {
    return await resolveForLocalDev(request, env);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return null;
    throw error;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local development only: with no session, act as DEV_USER_EMAIL, creating
 * that user as an admin the first time.
 *
 * Two gates. The var comes from .dev.vars, which is gitignored and never
 * uploaded; and it is honoured only for requests to localhost, so even a var
 * that somehow reached a deployment would do nothing there.
 */
async function resolveForLocalDev(request: Request, env: Env): Promise<UserRow> {
  const host = new URL(request.url).hostname;
  const email = env.DEV_USER_EMAIL?.trim().toLowerCase();
  if (!email || !LOCAL_HOSTS.has(host)) throw new UnauthenticatedError();

  const existing = await findUserByEmail(env.DB, email);
  if (existing) return existing;
  return createUser(env, {
    email,
    googleSub: null,
    name: email.split("@")[0],
    picture: null,
    isAdmin: true,
    invite: null,
  });
}
