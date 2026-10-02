/* ============================================================================
   Your inbox: what needs your attention (migrations/0008_inbox.sql).
   ----------------------------------------------------------------------------
     GET  /api/inbox          { unread, items, next }: one page, newest first
            ?unread=true        only what has not been marked read
            ?limit=N            items per page, 1 to 200 (default 50)
            ?cursor=…           the page after the one that gave this `next`
     POST /api/inbox/read     { ids? }: mark these read, or all of them
     POST /api/inbox/dismiss  { ids }: remove these for good
   Both writes answer with the first page, as a plain GET would.

   Items come newest first by created_at, ties broken by id, both
   descending, so the order is total and a page boundary never splits or
   repeats an item. `next` is an opaque cursor (the last item's created_at
   and id, base64url), null on the last page. It is a position, not an
   offset: items marked read, dismissed or arriving while someone pages
   neither shift nor repeat what comes after it. So a reader can page
   ?unread=true, mark what it has dealt with, and always drain everything
   unread. `unread` is the total unread count, whatever the page.

   Marking read is retry-safe: ids already read, dismissed, or not the
   viewer's are skipped without an error.

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
import { badRequest, base64url, fromBase64url, json, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { avatarUrl } from "../repo/users";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** What GET /api/inbox was asked for. */
export interface InboxQuery {
  unread?: boolean;
  limit?: number;
  cursor?: string | null;
}

interface Position {
  createdAt: string;
  id: string;
}

const encodeCursor = (p: Position) => base64url(new TextEncoder().encode(`${p.createdAt}|${p.id}`));

function decodeCursor(cursor: string): Position {
  const refused = () => badRequest("`cursor` is not one this inbox gave out");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64url(cursor));
  } catch {
    throw refused();
  }
  const bar = text.indexOf("|");
  const createdAt = text.slice(0, bar);
  const id = text.slice(bar + 1);
  if (bar < 0 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(createdAt) || !id) throw refused();
  return { createdAt, id };
}

/** ?unread, ?limit and ?cursor, checked. */
export function inboxQuery(url: URL): InboxQuery {
  const unread = url.searchParams.get("unread");
  if (unread !== null && unread !== "true" && unread !== "false") throw badRequest("`unread` must be true or false");
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`\`limit\` must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const cursor = url.searchParams.get("cursor") || null;
  if (cursor) decodeCursor(cursor);
  return { unread: unread === "true", limit, cursor };
}

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

export async function readInbox(env: Env, viewer: Viewer, query: InboxQuery = {}): Promise<Inbox> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const boards = await boardsFor(env.DB, viewer);
  if (boards.length === 0) return { unread: 0, items: [], next: null };
  const ids = boards.map((b) => b.id);
  /* ?1 the viewer, ?2 and ?3 the cursor's position, then the boards. */
  const visible = `i.board_id IN (${ids.map((_, n) => `?${n + 4}`).join(",")})`;
  const page = [
    query.unread ? " AND i.read_at IS NULL" : "",
    after ? " AND (i.created_at < ?2 OR (i.created_at = ?2 AND i.id < ?3))" : "",
  ].join("");
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT i.id, i.kind, i.task_id, t.number, t.title, b.id AS board_id, b.key AS board_key, b.name AS board_name,
              u.handle AS actor_handle, u.avatar_key AS actor_avatar, i.via, c.text AS comment, i.created_at, i.read_at
         FROM inbox_items i
         JOIN tasks t ON t.id = i.task_id AND t.deleted_at IS NULL
         JOIN boards b ON b.id = i.board_id
         JOIN users u ON u.id = i.actor_id
         LEFT JOIN comments c ON c.id = i.comment_id
        WHERE i.user_id = ?1 AND ${visible}${page}
        ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit + 1}`,
    )
      .bind(viewer.user.id, after?.createdAt ?? null, after?.id ?? null, ...ids)
      .all<Row>(),
    env.DB.prepare(
      `SELECT count(*) AS n FROM inbox_items i JOIN tasks t ON t.id = i.task_id AND t.deleted_at IS NULL
        WHERE i.user_id = ?1 AND i.read_at IS NULL AND ${visible}`,
    )
      .bind(viewer.user.id, null, null, ...ids)
      .first<{ n: number }>(),
  ]);
  /* One more than asked for says whether there is a next page. */
  const more = rows.results.length > limit;
  const shown = more ? rows.results.slice(0, limit) : rows.results;
  const last = shown.at(-1);
  const items: InboxItem[] = shown.map((r) => ({
    id: r.id,
    kind: r.kind,
    task: { id: r.task_id, key: `${r.board_key}-${r.number}`, title: r.title, boardId: r.board_id, boardName: r.board_name },
    actor: { handle: r.actor_handle, avatar: avatarUrl(r.actor_avatar) },
    via: r.via,
    comment: r.comment,
    createdAt: r.created_at,
    readAt: r.read_at,
  }));
  return {
    unread: count?.n ?? 0,
    items,
    next: more && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

export async function getInbox(env: Env, viewer: Viewer, url: URL): Promise<Response> {
  return json(await readInbox(env, viewer, inboxQuery(url)));
}

/** POST /api/inbox/read { ids? }: these, or with no ids everything unread. Ids already read are skipped. */
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
