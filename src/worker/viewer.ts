/* ============================================================================
   Viewer resolution: session cookie → user row.
   ========================================================================== */

import type { Viewer } from "@/domain/types";
import { sessionUser } from "./auth";
import type { Env } from "./env";
import { UnauthenticatedError } from "./http";
import { adminEmails, createUser, findUserByEmail, rowToUser, type UserRow } from "./repo/users";

export async function resolveViewer(request: Request, env: Env): Promise<Viewer> {
  const row = (await sessionUser(request, env)) ?? (await resolveForLocalDev(request, env));
  return { user: rowToUser(row, adminEmails(env)) };
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
