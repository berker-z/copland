/* ============================================================================
   Your inbox: what needs your attention (migrations/0008_inbox.sql).
   ----------------------------------------------------------------------------
     GET  /api/inbox          { unread, items }: the newest 50, unread or not
     POST /api/inbox/read     { ids? }: mark these read, or all of them
     POST /api/inbox/dismiss  { ids }: remove these for good

   Every principal has their own, an agent included: an agent's inbox is the
   agent's, not its owner's, so these are not mine(grant) routes. The viewer
   is whoever asks.

   An item shows only while its task is on a board the viewer can still see.
   Taken off a board, or the task deleted, and it quietly drops out: an inbox
   never shows a title its reader is no longer allowed to read.
   ========================================================================== */

import type { Inbox, InboxItem, Viewer } from "@/domain/types";
import { boardsFor } from "../access";
import type { Env } from "../env";
import { badRequest, json, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { avatarUrl } from "../repo/users";

const LIMIT = 50;

interface Row {
  id: string;
  kind: InboxItem["kind"];
  task_id: string;
  number: number;
  title: string;
  board_id: string;
  board_key: string;
  board_name: string;
  actor_handle: string;
  actor_avatar: string | null;
  via: string | null;
  comment: string | null;
  created_at: string;
  read_at: string | null;
}

export async function readInbox(env: Env, viewer: Viewer): Promise<Inbox> {
  const boards = await boardsFor(env.DB, viewer);
  if (boards.length === 0) return { unread: 0, items: [] };
  const ids = boards.map((b) => b.id);
  const visible = `i.board_id IN (${ids.map((_, n) => `?${n + 2}`).join(",")})`;
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT i.id, i.kind, i.task_id, t.number, t.title, b.id AS board_id, b.key AS board_key, b.name AS board_name,
              u.handle AS actor_handle, u.avatar_key AS actor_avatar, i.via, c.text AS comment, i.created_at, i.read_at
         FROM inbox_items i
         JOIN tasks t ON t.id = i.task_id AND t.deleted_at IS NULL
         JOIN boards b ON b.id = i.board_id
         JOIN users u ON u.id = i.actor_id
         LEFT JOIN comments c ON c.id = i.comment_id
        WHERE i.user_id = ?1 AND ${visible}
        ORDER BY i.created_at DESC LIMIT ${LIMIT}`,
    )
      .bind(viewer.user.id, ...ids)
      .all<Row>(),
    env.DB.prepare(
      `SELECT count(*) AS n FROM inbox_items i JOIN tasks t ON t.id = i.task_id AND t.deleted_at IS NULL
        WHERE i.user_id = ?1 AND i.read_at IS NULL AND ${visible}`,
    )
      .bind(viewer.user.id, ...ids)
      .first<{ n: number }>(),
  ]);
  const items: InboxItem[] = rows.results.map((r) => ({
    id: r.id,
    kind: r.kind,
    task: { id: r.task_id, key: `${r.board_key}-${r.number}`, title: r.title, boardId: r.board_id, boardName: r.board_name },
    actor: { handle: r.actor_handle, avatar: avatarUrl(r.actor_avatar) },
    via: r.via,
    comment: r.comment,
    createdAt: r.created_at,
    readAt: r.read_at,
  }));
  return { unread: count?.n ?? 0, items };
}

export async function getInbox(env: Env, viewer: Viewer): Promise<Response> {
  return json(await readInbox(env, viewer));
}

/** POST /api/inbox/read { ids? }: these, or with no ids everything unread. */
export async function postInboxRead(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  const now = nowIso();
  if (body.ids === undefined) {
    await env.DB.prepare(`UPDATE inbox_items SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL`)
      .bind(viewer.user.id, now)
      .run();
  } else {
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string") || body.ids.length > 200) {
      throw badRequest("`ids` must be a list of inbox item ids");
    }
    const ids = body.ids as string[];
    if (ids.length) {
      await env.DB.prepare(
        `UPDATE inbox_items SET read_at = ?2
          WHERE user_id = ?1 AND read_at IS NULL AND id IN (${ids.map((_, n) => `?${n + 3}`).join(",")})`,
      )
        .bind(viewer.user.id, now, ...ids)
        .run();
    }
  }
  changes.notify([viewer.user.id], "inbox");
  return json(await readInbox(env, viewer));
}

/** POST /api/inbox/dismiss { ids }: out of the inbox for good, read or not. Only your own. */
export async function postInboxDismiss(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string") || body.ids.length > 200) {
    throw badRequest("`ids` must be a list of inbox item ids");
  }
  const ids = body.ids as string[];
  if (ids.length) {
    await env.DB.prepare(
      `DELETE FROM inbox_items WHERE user_id = ?1 AND id IN (${ids.map((_, n) => `?${n + 2}`).join(",")})`,
    )
      .bind(viewer.user.id, ...ids)
      .run();
  }
  changes.notify([viewer.user.id], "inbox");
  return json(await readInbox(env, viewer));
}
