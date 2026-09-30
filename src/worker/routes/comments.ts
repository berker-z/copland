/* ============================================================================
   Comments on a task, and the task's history.
   ----------------------------------------------------------------------------
   Anyone on the board can read and comment, viewers included: a viewer is
   someone you want to hear from but not have moving cards. Only the author
   edits or deletes a comment; a board owner may also delete one.

   History is the board's event log filtered to the task, with the actor's
   name joined in, newest first.
   ========================================================================== */

import type { Comment, TaskEvent, Viewer } from "@/domain/types";
import { requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience } from "../repo/boards";
import { eventStatement } from "../repo/tasks";

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
  const { results } = await db
    .prepare(
      `SELECT c.id, c.task_id, c.author_id, u.name AS author_name, c.text, c.created_at, c.edited_at
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.task_id = ?1 ORDER BY c.created_at`,
    )
    .bind(taskId)
    .all<{
      id: string;
      task_id: string;
      author_id: string;
      author_name: string;
      text: string;
      created_at: string;
      edited_at: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id,
    authorName: r.author_name,
    text: r.text,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  }));
}

export async function getComments(env: Env, viewer: Viewer, taskId: string) {
  await boardOfTask(env.DB, viewer, taskId);
  return json(await listComments(env.DB, taskId));
}

export async function postComment(request: Request, env: Env, viewer: Viewer, taskId: string, changes: Changes) {
  const db = env.DB;
  const board = await boardOfTask(db, viewer, taskId);
  const text = parseText((await readJson(request)).text);
  await db.batch([
    db
      .prepare(`INSERT INTO comments (id, task_id, author_id, text) VALUES (?1, ?2, ?3, ?4)`)
      .bind(crypto.randomUUID(), taskId, viewer.user.id, text),
    eventStatement(db, { boardId: board.id, taskId, actorId: viewer.user.id, kind: "comment.added" }),
  ]);
  changes.notify(await boardAudience(db, board.id), "board");
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

export async function patchComment(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const { row, board } = await commentFor(db, viewer, id);
  if (row.author_id !== viewer.user.id) throw forbidden("Only the author can edit a comment");
  const text = parseText((await readJson(request)).text);
  await db.prepare(`UPDATE comments SET text = ?2, edited_at = ?3 WHERE id = ?1`).bind(id, text, nowIso()).run();
  changes.notify(await boardAudience(db, board.id), "board");
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
    `SELECT e.id, e.kind, u.name AS actor_name, e.before, e.after, e.via, e.created_at
       FROM events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.task_id = ?1 ORDER BY e.created_at DESC LIMIT 100`,
  )
    .bind(taskId)
    .all<{
      id: string;
      kind: string;
      actor_name: string | null;
      before: string | null;
      after: string | null;
      via: string | null;
      created_at: string;
    }>();
  const events: TaskEvent[] = results.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorName: r.actor_name,
    before: r.before ? (JSON.parse(r.before) as Record<string, unknown>) : null,
    after: r.after ? (JSON.parse(r.after) as Record<string, unknown>) : null,
    via: r.via,
    createdAt: r.created_at,
  }));
  return json(events);
}
