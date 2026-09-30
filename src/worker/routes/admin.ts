/* ============================================================================
   Instance admin: users and invites.
   ----------------------------------------------------------------------------
   An invite is a link, /auth/invite/<code>, good for one new account within
   INVITE_DAYS. It may be locked to an email and may carry a board, which the
   new user joins as an editor. Only the code's hash is stored; the link is
   shown once, when it is made.

   Admins invite to the instance. A board owner inviting someone who is not
   here yet goes through routes/boards.ts, which makes an invite carrying the
   board; that path is open to any owner, not just admins, when SIGNUP is not
   "closed".
   ========================================================================== */

import type { CreatedInvite, Invite, User, Viewer } from "@/domain/types";
import { requireAdmin } from "../access";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, nowIso, randomToken, readJson, sha256Hex } from "../http";
import type { Changes } from "../live";
import { adminEmails, rowToUser, signupMode, type UserRow } from "../repo/users";

const INVITE_DAYS = 14;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteRow {
  id: string;
  email: string | null;
  board_id: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
}

function rowToInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    email: row.email,
    boardId: row.board_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedBy: row.used_by,
    usedAt: row.used_at,
  };
}

/** The admins' audience for admin-screen refreshes. */
async function adminIds(env: Env): Promise<string[]> {
  const admins = [...adminEmails(env)];
  const { results } = await env.DB.prepare(
    `SELECT id FROM users WHERE is_admin = 1 OR email IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(admins))
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function getUsers(env: Env, viewer: Viewer): Promise<Response> {
  requireAdmin(viewer);
  const { results } = await env.DB.prepare(`SELECT * FROM users ORDER BY created_at`).all<UserRow>();
  const admins = adminEmails(env);
  return json(
    results.map((row) => ({ ...rowToUser(row, admins), disabledAt: row.disabled_at })) satisfies (User & {
      disabledAt: string | null;
    })[],
  );
}

export async function getInvites(env: Env, viewer: Viewer): Promise<Response> {
  requireAdmin(viewer);
  const { results } = await env.DB.prepare(`SELECT * FROM invites ORDER BY created_at DESC`).all<InviteRow>();
  return json(results.map(rowToInvite));
}

/**
 * Make an invite link. Shared by the admin screen (no board) and a board
 * owner inviting a newcomer (with one; the caller has checked ownership).
 */
export async function createInvite(
  env: Env,
  viewer: Viewer,
  origin: string,
  input: { email: string | null; boardId: string | null },
): Promise<CreatedInvite> {
  if (signupMode(env) === "closed") throw forbidden("This instance is closed to new accounts");
  const code = randomToken();
  const row: InviteRow = {
    id: crypto.randomUUID(),
    email: input.email,
    board_id: input.boardId,
    created_by: viewer.user.id,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    used_by: null,
    used_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO invites (id, code_hash, email, board_id, created_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(row.id, await sha256Hex(code), row.email, row.board_id, row.created_by, row.created_at, row.expires_at)
    .run();
  return { invite: rowToInvite(row), url: `${origin}/auth/invite/${code}` };
}

export async function postInvite(
  request: Request,
  env: Env,
  viewer: Viewer,
  url: URL,
  changes: Changes,
): Promise<Response> {
  requireAdmin(viewer);
  const { email } = await readJson(request);
  const normalized = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  if (normalized !== null && !EMAIL.test(normalized)) throw badRequest("`email` is not an email address");
  const created = await createInvite(env, viewer, url.origin, { email: normalized, boardId: null });
  changes.notify(await adminIds(env), "admin");
  return json(created, { status: 201 });
}

export async function deleteInvite(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  requireAdmin(viewer);
  const result = await env.DB.prepare(`DELETE FROM invites WHERE id = ?1 AND used_at IS NULL`).bind(id).run();
  if (result.meta.changes === 0) throw notFound("No unused invite with that id");
  changes.notify(await adminIds(env), "admin");
  return json({ ok: true });
}

/** Disable or re-enable a user. Disabling ends their sessions at once. */
export async function patchUser(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  changes: Changes,
): Promise<Response> {
  requireAdmin(viewer);
  const { disabled } = await readJson(request);
  if (typeof disabled !== "boolean") throw badRequest("`disabled` must be a boolean");
  if (id === viewer.user.id) throw badRequest("You cannot disable yourself");
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET disabled_at = ?2 WHERE id = ?1`).bind(id, disabled ? nowIso() : null),
    ...(disabled ? [env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(id)] : []),
  ]);
  if (result[0].meta.changes === 0) throw notFound("No such user");
  changes.notify(await adminIds(env), "admin");
  return json({ ok: true });
}
