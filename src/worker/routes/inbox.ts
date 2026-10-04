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
   never shows a title its reader is no longer allowed to read. A message
   that points at no task (routes/messages.ts) is always shown.

   A message item says which run is handling it right now (message.claim,
   POST /api/messages/:id/claim in routes/runs.ts), so a daemon skips one
   another run holds. Marking it read or dismissing it releases that claim.
   ========================================================================== */

import { shortRunId, type RunKind } from "@/domain/runs";
import { clientLabel } from "@/domain/clients";
import type { Inbox, InboxItem, Viewer } from "@/domain/types";
import { boardsFor } from "../access";
import type { Env } from "../env";
import { badRequest, base64url, fromBase64url, json, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { releaseReadMessagesStatement } from "../repo/runs";
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
  task_id: string | null;
  number: number | null;
  title: string | null;
  board_id: string | null;
  board_key: string | null;
  board_name: string | null;
  actor_id: string;
  actor_handle: string;
  actor_avatar: string | null;
  via: string | null;
  comment: string | null;
  message_id: string | null;
  message: string | null;
  trusted: number | null;
  claim_user: string | null;
  claim_run: string | null;
  claim_until: string | null;
  claim_kind: RunKind | null;
  claim_client: string | null;
  created_at: string;
  read_at: string | null;
}

export async function readInbox(env: Env, viewer: Viewer, query: InboxQuery = {}): Promise<Inbox> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const ids = (await boardsFor(env.DB, viewer)).map((b) => b.id);
  /* ?1 the viewer, ?2 and ?3 the cursor's position, ?4 the boards (a JSON
     list, so the count of bindings never depends on how many). A task-less
     message needs no board; any other item a live task on one. */
  const visible = `(i.task_id IS NULL OR (t.id IS NOT NULL AND i.board_id IN (SELECT value FROM json_each(?4))))`;
  const page = [
    query.unread ? " AND i.read_at IS NULL" : "",
    after ? " AND (i.created_at < ?2 OR (i.created_at = ?2 AND i.id < ?3))" : "",
  ].join("");
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT i.id, i.kind, i.task_id, t.number, t.title, b.id AS board_id, b.key AS board_key, b.name AS board_name,
              i.actor_id, u.handle AS actor_handle, u.avatar_key AS actor_avatar, i.via, c.text AS comment,
              m.id AS message_id, m.text AS message, (u.owner_id = i.user_id OR me.owner_id = u.id) AS trusted,
              mc.user_id AS claim_user, mr.id AS claim_run,
              mc.claimed_until AS claim_until, mr.kind AS claim_kind, mr.client AS claim_client,
              i.created_at, i.read_at
         FROM inbox_items i
         LEFT JOIN tasks t ON t.id = i.task_id AND t.deleted_at IS NULL
         LEFT JOIN boards b ON b.id = i.board_id
         JOIN users u ON u.id = i.actor_id
         JOIN users me ON me.id = i.user_id
         LEFT JOIN comments c ON c.id = i.comment_id
         LEFT JOIN messages m ON m.id = i.message_id
         LEFT JOIN message_claims mc ON mc.message_id = i.message_id AND mc.claimed_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         LEFT JOIN runs mr ON mr.id = mc.run_id AND mr.status = 'running'
        WHERE i.user_id = ?1 AND ${visible}${page}
        ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit + 1}`,
    )
      .bind(viewer.user.id, after?.createdAt ?? null, after?.id ?? null, JSON.stringify(ids))
      .all<Row>(),
    env.DB.prepare(
      `SELECT count(*) AS n FROM inbox_items i LEFT JOIN tasks t ON t.id = i.task_id AND t.deleted_at IS NULL
        WHERE i.user_id = ?1 AND i.read_at IS NULL AND ${visible}`,
    )
      .bind(viewer.user.id, null, null, JSON.stringify(ids))
      .first<{ n: number }>(),
  ]);
  /* One more than asked for says whether there is a next page. */
  const more = rows.results.length > limit;
  const shown = more ? rows.results.slice(0, limit) : rows.results;
  const last = shown.at(-1);
  const items: InboxItem[] = shown.map((r) => ({
    id: r.id,
    kind: r.kind,
    task:
      r.task_id && r.board_id
        ? { id: r.task_id, key: `${r.board_key}-${r.number}`, title: r.title ?? "", boardId: r.board_id, boardName: r.board_name ?? "" }
        : null,
    actor: { id: r.actor_id, handle: r.actor_handle, avatar: avatarUrl(r.actor_avatar) },
    via: r.via,
    comment: r.comment,
    message: r.message_id
      ? {
          id: r.message_id,
          text: r.message ?? "",
          trusted: r.trusted === 1,
          /* A claim is live while it has not lapsed and its run is running: both joins matched. */
          claim:
            r.claim_run && r.claim_user && r.claim_until && r.claim_kind
              ? {
                  userId: r.claim_user,
                  runId: r.claim_run,
                  run: shortRunId(r.claim_run),
                  kind: r.claim_kind,
                  client: r.claim_client ? clientLabel(r.claim_client) : null,
                  until: r.claim_until,
                }
              : null,
        }
      : null,
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

/**
 * POST /api/inbox/read { ids? }: these, or with no ids everything unread.
 * Ids already read are skipped. A message read is dealt with, so its claim
 * goes with it.
 */
export async function postInboxRead(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  const now = nowIso();
  const release = releaseReadMessagesStatement(env.DB, viewer.user.id);
  if (body.ids === undefined) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE inbox_items SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL`).bind(viewer.user.id, now),
      release,
    ]);
  } else {
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string") || body.ids.length > 200) {
      throw badRequest("`ids` must be a list of inbox item ids");
    }
    const ids = body.ids as string[];
    if (ids.length) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE inbox_items SET read_at = ?2
            WHERE user_id = ?1 AND read_at IS NULL AND id IN (${ids.map((_, n) => `?${n + 3}`).join(",")})`,
        ).bind(viewer.user.id, now, ...ids),
        release,
      ]);
    }
  }
  changes.notify([viewer.user.id], "inbox");
  return json(await readInbox(env, viewer));
}

/** POST /api/inbox/dismiss { ids }: out of the inbox for good, read or not. Only your own; a message's claim goes too. */
export async function postInboxDismiss(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string") || body.ids.length > 200) {
    throw badRequest("`ids` must be a list of inbox item ids");
  }
  const ids = body.ids as string[];
  if (ids.length) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM inbox_items WHERE user_id = ?1 AND id IN (${ids.map((_, n) => `?${n + 2}`).join(",")})`).bind(
        viewer.user.id,
        ...ids,
      ),
      releaseReadMessagesStatement(env.DB, viewer.user.id),
    ]);
  }
  changes.notify([viewer.user.id], "inbox");
  return json(await readInbox(env, viewer));
}
