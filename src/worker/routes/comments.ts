/* ============================================================================
   Comments on a task, and the task's history.
   ----------------------------------------------------------------------------
   Anyone on the board can read and comment, viewers included: a viewer is
   someone you want to hear from but not have moving cards. Only the author
   edits or deletes a comment; a board owner may also delete one.

   "@handle" or "@owner/agent" in the text mentions a member of the board:
   kept by id in comment_mentions, and put in their inbox (repo/inbox.ts).

   History is the board's event log filtered to the task, with the actor's
   handle joined in, newest first.
   ========================================================================== */

import type { Comment, TaskEvent, Viewer } from "@/domain/types";
import { requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience, listMembers } from "../repo/boards";
import { inboxAudience, inboxStatements, mentionedIn, type NewInboxItem } from "../repo/inbox";
import { eventStatement } from "../repo/tasks";
import { avatarUrl } from "../repo/users";

const TEXT_MAX = 5000;

function parseText(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("`text` must be a non-empty string");
  if (raw.length > TEXT_MAX) throw badRequest(`\`text\` is longer than ${TEXT_MAX} characters`);
  return raw.trim();
}

/** The task's board, for a member; not a member reads as no such task. */
async function boardOfTask(db: D1Database, viewer: Viewer, taskId: string) {
  const row = await db
    .prepare(`SELECT board_id FROM tasks WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(taskId)
    .first<{ board_id: string }>();
  if (!row) throw notFound("No such task");
  try {
    return await requireBoard(db, viewer, row.board_id, "viewer");
  } catch {
    throw notFound("No such task");
  }
}

async function listComments(db: D1Database, taskId: string): Promise<Comment[]> {
  const [comments, mentions] = await Promise.all([
    db
      .prepare(
        `SELECT c.id, c.task_id, c.author_id, u.handle AS author_handle, u.avatar_key AS author_avatar, c.text, c.created_at, c.edited_at
           FROM comments c JOIN users u ON u.id = c.author_id
          WHERE c.task_id = ?1 ORDER BY c.created_at`,
      )
      .bind(taskId)
      .all<{
        id: string;
        task_id: string;
        author_id: string;
        author_handle: string;
        author_avatar: string | null;
        text: string;
        created_at: string;
        edited_at: string | null;
      }>(),
    db
      .prepare(
        `SELECT m.comment_id, u.id, u.handle FROM comment_mentions m
           JOIN comments c ON c.id = m.comment_id
           JOIN users u ON u.id = m.user_id
          WHERE c.task_id = ?1`,
      )
      .bind(taskId)
      .all<{ comment_id: string; id: string; handle: string }>(),
  ]);
  return comments.results.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id,
    authorHandle: r.author_handle,
    authorAvatar: avatarUrl(r.author_avatar),
    text: r.text,
    mentions: mentions.results.filter((m) => m.comment_id === r.id).map((m) => ({ id: m.id, handle: m.handle })),
    createdAt: r.created_at,
    editedAt: r.edited_at,
  }));
}

export async function getComments(env: Env, viewer: Viewer, taskId: string) {
  await boardOfTask(env.DB, viewer, taskId);
  return json(await listComments(env.DB, taskId));
}

/** The statements that record a comment's mentions and tell whoever is newly named. */
function mentionStatements(db: D1Database, viewer: Viewer, boardId: string, taskId: string, commentId: string, newly: string[]) {
  const items: NewInboxItem[] = newly.map((userId) => ({
    userId,
    kind: "mentioned",
    boardId,
    taskId,
    commentId,
    actorId: viewer.user.id,
  }));
  return {
    statements: [
      ...newly.map((uid) => db.prepare(`INSERT INTO comment_mentions (comment_id, user_id) VALUES (?1, ?2)`).bind(commentId, uid)),
      ...inboxStatements(db, items),
    ],
    audience: inboxAudience(items),
  };
}

export async function postComment(request: Request, env: Env, viewer: Viewer, taskId: string, changes: Changes) {
  const db = env.DB;
  const board = await boardOfTask(db, viewer, taskId);
  const text = parseText((await readJson(request)).text);
  const id = crypto.randomUUID();
  const mentions = mentionStatements(db, viewer, board.id, taskId, id, mentionedIn(text, await listMembers(db, board.id)));
  await db.batch([
    db.prepare(`INSERT INTO comments (id, task_id, author_id, text) VALUES (?1, ?2, ?3, ?4)`).bind(id, taskId, viewer.user.id, text),
    ...mentions.statements,
    eventStatement(db, { boardId: board.id, taskId, actorId: viewer.user.id, kind: "comment.added" }),
  ]);
  changes.notify(await boardAudience(db, board.id), "board");
  changes.notify(mentions.audience, "inbox");
  return json(await listComments(db, taskId), { status: 201 });
}

async function commentFor(db: D1Database, viewer: Viewer, id: string) {
  const row = await db
    .prepare(`SELECT id, task_id, author_id FROM comments WHERE id = ?1`)
    .bind(id)
    .first<{ id: string; task_id: string; author_id: string }>();
  if (!row) throw notFound("No such comment");
  const board = await boardOfTask(db, viewer, row.task_id);
  return { row, board };
}

/**
 * PATCH /api/comments/:id { text }. Mentions follow the new text: a name
 * taken out is no longer mentioned, and only a name newly added hears about
 * it, so fixing a typo never pings everyone again.
 */
export async function patchComment(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const { row, board } = await commentFor(db, viewer, id);
  if (row.author_id !== viewer.user.id) throw forbidden("Only the author can edit a comment");
  const text = parseText((await readJson(request)).text);
  const { results: before } = await db
    .prepare(`SELECT user_id FROM comment_mentions WHERE comment_id = ?1`)
    .bind(id)
    .all<{ user_id: string }>();
  const now = mentionedIn(text, await listMembers(db, board.id));
  const kept = new Set(before.map((b) => b.user_id));
  const mentions = mentionStatements(db, viewer, board.id, row.task_id, id, now.filter((uid) => !kept.has(uid)));
  const dropped = [...kept].filter((uid) => !now.includes(uid));
  await db.batch([
    db.prepare(`UPDATE comments SET text = ?2, edited_at = ?3 WHERE id = ?1`).bind(id, text, nowIso()),
    ...dropped.map((uid) => db.prepare(`DELETE FROM comment_mentions WHERE comment_id = ?1 AND user_id = ?2`).bind(id, uid)),
    ...mentions.statements,
  ]);
  changes.notify(await boardAudience(db, board.id), "board");
  changes.notify(mentions.audience, "inbox");
  return json(await listComments(db, row.task_id));
}

export async function deleteComment(env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const { row, board } = await commentFor(db, viewer, id);
  if (row.author_id !== viewer.user.id && board.role !== "owner") {
    throw forbidden("Only the author or a board owner can delete a comment");
  }
  await db.prepare(`DELETE FROM comments WHERE id = ?1`).bind(id).run();
  changes.notify(await boardAudience(db, board.id), "board");
  return json(await listComments(db, row.task_id));
}

export async function getTaskEvents(env: Env, viewer: Viewer, taskId: string) {
  await boardOfTask(env.DB, viewer, taskId);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.kind, u.handle AS actor_handle, e.before, e.after, e.via, e.created_at
       FROM events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.task_id = ?1 ORDER BY e.created_at DESC LIMIT 100`,
  )
    .bind(taskId)
    .all<{
      id: string;
      kind: string;
      actor_handle: string | null;
      before: string | null;
      after: string | null;
      via: string | null;
      created_at: string;
    }>();
  const events: TaskEvent[] = results.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorHandle: r.actor_handle,
    before: r.before ? (JSON.parse(r.before) as Record<string, unknown>) : null,
    after: r.after ? (JSON.parse(r.after) as Record<string, unknown>) : null,
    via: r.via,
    createdAt: r.created_at,
  }));
  return json(events);
}
