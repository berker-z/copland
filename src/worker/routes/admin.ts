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
import { boardAudience } from "../repo/boards";
import { claimedBoards, endRunsStatements } from "../repo/runs";
import { rowToUser, signupMode, type UserRow } from "../repo/users";

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
  const { results } = await env.DB.prepare(`SELECT id FROM users WHERE is_admin = 1`).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function getUsers(env: Env, viewer: Viewer): Promise<Response> {
  requireAdmin(viewer);
  const { results } = await env.DB.prepare(`SELECT * FROM users WHERE kind = 'person' ORDER BY created_at`).all<UserRow>();
  return json(
    results.map((row) => ({ ...rowToUser(row), disabledAt: row.disabled_at })) satisfies (User & {
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
  /* Agents' stand-in addresses live there (repo/users.ts agentEmail); nobody can sign in with one. */
  if (input.email?.endsWith(".invalid")) throw badRequest("That is not an address anyone can sign in with");
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

/**
 * Disable or re-enable a user (`disabled`), or make them an admin or not
 * (`admin`). Disabling ends their sessions at once. Nobody disables
 * themselves, and the last active admin cannot stop being one, so an
 * instance always has someone who can let people in.
 */
export async function patchUser(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  changes: Changes,
): Promise<Response> {
  requireAdmin(viewer);
  const { disabled, admin } = await readJson(request);
  if (disabled === undefined && admin === undefined) throw badRequest("Send `disabled` or `admin`");
  if (disabled !== undefined && typeof disabled !== "boolean") throw badRequest("`disabled` must be a boolean");
  if (admin !== undefined && typeof admin !== "boolean") throw badRequest("`admin` must be a boolean");
  if (disabled === true && id === viewer.user.id) throw badRequest("You cannot disable yourself");

  const target = await env.DB.prepare(`SELECT id FROM users WHERE id = ?1 AND kind = 'person'`).bind(id).first();
  if (!target) throw notFound("No such user");

  if (admin === false) {
    /* The check and the change in one statement, so two admins demoting
       each other at once cannot leave nobody. */
    const result = await env.DB.prepare(
      `UPDATE users SET is_admin = 0 WHERE id = ?1 AND EXISTS
         (SELECT 1 FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND id != ?1)`,
    )
      .bind(id)
      .run();
    if (result.meta.changes === 0) throw badRequest("Copland needs at least one admin");
  }
  if (admin === true) await env.DB.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?1`).bind(id).run();
  if (disabled !== undefined) {
    /* Their runs, and their agents', end with them: the boards they held claims on hear of it. */
    const claimed = disabled ? await claimedBoards(env.DB, id) : [];
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET disabled_at = ?2 WHERE id = ?1`).bind(id, disabled ? nowIso() : null),
      ...(disabled ? [env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(id), ...endRunsStatements(env.DB, id)] : []),
    ]);
    for (const boardId of claimed) changes.notify(await boardAudience(env.DB, boardId), "board");
  }

  /* The person too: their own /me says whether they are an admin. */
  changes.notify([...new Set([...(await adminIds(env)), id])], "admin");
  return json({ ok: true });
}
