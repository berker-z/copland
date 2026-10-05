/* ============================================================================
   Comments on a task, and the task's history.
   ----------------------------------------------------------------------------
   Anyone on the board can read and comment, viewers included: a viewer is
   someone you want to hear from but not have moving cards. Only the author
   edits or deletes a comment; a board owner may also delete one.

   "@handle" or "@owner/agent" in the text mentions a member of the board:
   kept by id in comment_mentions, and put in their inbox (repo/inbox.ts).
   A new comment also reaches the task's other participants as "commented";
   editing one reaches only whoever it newly names.

   A new comment can carry images (attachments: [key], COPL-117): uploads
   claimed like a task attachment's, written in the same batch as the
   comment, so it goes in with all of them or not at all. They are rows of
   the attachments table with the comment's id, read through the same GET
   and the same board check, and not in the task's own list. An edit leaves
   them alone; deleting the comment deletes them and their R2 objects.

   History is the board's event log filtered to the task, with the actor's
   handle joined in, newest first.
   ========================================================================== */

import { isCommentImage, parseCommentImages } from "@/domain/commentImages";
import { shortRunId } from "@/domain/runs";
import type { Comment, CommentAttachment, TaskEvent, Viewer } from "@/domain/types";
import { requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience, bumped, taskChange, listMembers } from "../repo/boards";
import { claimUpload, PREFIX } from "./attachments";
import { inboxAudience, inboxStatements, mentionedIn, participantsOf, type NewInboxItem } from "../repo/inbox";
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
  const [comments, mentions, images] = await Promise.all([
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
    db
      .prepare(
        `SELECT id, comment_id, name, mime, size, key FROM attachments
          WHERE task_id = ?1 AND comment_id IS NOT NULL AND key IS NOT NULL ORDER BY created_at`,
      )
      .bind(taskId)
      .all<{ id: string; comment_id: string; name: string; mime: string; size: number; key: string }>(),
  ]);
  const imagesOf = new Map<string, CommentAttachment[]>();
  for (const r of images.results) {
    const list = imagesOf.get(r.comment_id) ?? [];
    list.push({ id: r.id, name: r.name, type: r.mime, size: r.size, url: `/api/attachments/${r.key}` });
    imagesOf.set(r.comment_id, list);
  }
  return comments.results.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id,
    authorHandle: r.author_handle,
    authorAvatar: avatarUrl(r.author_avatar),
    text: r.text,
    mentions: mentions.results.filter((m) => m.comment_id === r.id).map((m) => ({ id: m.id, handle: m.handle })),
    attachments: imagesOf.get(r.id) ?? [],
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

/**
 * A new comment's images: each key the caller's own unattached upload, and
 * an image a browser shows inline. Claimed here, written with the comment.
 */
async function claimImages(env: Env, viewer: Viewer, raw: unknown) {
  const parsed = parseCommentImages(raw);
  if (!parsed.ok) throw badRequest(parsed.reason);
  return Promise.all(
    parsed.keys.map(async (key) => {
      const upload = await claimUpload(env, viewer, key);
      if (!isCommentImage(upload.mime)) throw badRequest(`Only PNG, JPEG, GIF and WebP images go on a comment, not ${upload.mime}`);
      return { id: crypto.randomUUID(), name: upload.name ?? "image", mime: upload.mime, size: upload.size, key: upload.key };
    }),
  );
}

/** POST /api/tasks/:id/comments { text, attachments?: [key] } */
export async function postComment(request: Request, env: Env, viewer: Viewer, taskId: string, changes: Changes) {
  const db = env.DB;
  const board = await boardOfTask(db, viewer, taskId);
  const body = await readJson(request);
  const text = parseText(body.text);
  const images = await claimImages(env, viewer, body.attachments);
  const id = crypto.randomUUID();
  const named = mentionedIn(text, await listMembers(db, board.id));
  const mentions = mentionStatements(db, viewer, board.id, taskId, id, named);
  // Everyone else taking part hears about it too, once: a mention outranks it.
  const commented: NewInboxItem[] = (await participantsOf(db, taskId))
    .filter((uid) => !named.includes(uid))
    .map((userId) => ({ userId, kind: "commented", boardId: board.id, taskId, commentId: id, actorId: viewer.user.id }));
  const version = await bumped(db, board.id, [
    db.prepare(`INSERT INTO comments (id, task_id, author_id, text) VALUES (?1, ?2, ?3, ?4)`).bind(id, taskId, viewer.user.id, text),
    /* A key claimed twice at once loses here, on attachments.key UNIQUE, and takes its comment with it. */
    ...images.map((f) =>
      db
        .prepare(
          `INSERT INTO attachments (id, task_id, comment_id, name, mime, size, kind, key, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'image', ?7, ?8)`,
        )
        .bind(f.id, taskId, id, f.name, f.mime, f.size, f.key, viewer.user.id),
    ),
    ...mentions.statements,
    ...inboxStatements(db, commented),
    eventStatement(db, { boardId: board.id, taskId, actorId: viewer.user.id, kind: "comment.added" }),
  ]);
  /* The task's comment count changed, and whoever has it open reads its thread. */
  changes.board(await boardAudience(db, board.id), await taskChange(db, board.id, version, [taskId]));
  changes.notify([...mentions.audience, ...inboxAudience(commented)], "inbox");
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
  const version = await bumped(db, board.id, [
    db.prepare(`UPDATE comments SET text = ?2, edited_at = ?3 WHERE id = ?1`).bind(id, text, nowIso()),
    ...dropped.map((uid) => db.prepare(`DELETE FROM comment_mentions WHERE comment_id = ?1 AND user_id = ?2`).bind(id, uid)),
    ...mentions.statements,
  ]);
  changes.board(await boardAudience(db, board.id), await taskChange(db, board.id, version, [row.task_id]));
  changes.notify(mentions.audience, "inbox");
  return json(await listComments(db, row.task_id));
}

export async function deleteComment(env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const { row, board } = await commentFor(db, viewer, id);
  if (row.author_id !== viewer.user.id && board.role !== "owner") {
    throw forbidden("Only the author or a board owner can delete a comment");
  }
  const { results: images } = await db
    .prepare(`SELECT key FROM attachments WHERE comment_id = ?1 AND key IS NOT NULL`)
    .bind(id)
    .all<{ key: string }>();
  const version = await bumped(db, board.id, [
    db.prepare(`DELETE FROM attachments WHERE comment_id = ?1`).bind(id),
    db.prepare(`DELETE FROM comments WHERE id = ?1`).bind(id),
  ]);
  /* After the rows: an object without a row is unreachable, a row without its object is a broken image. */
  if (images.length) await env.FILES.delete(images.map((i) => i.key).filter((k) => k.startsWith(PREFIX)));
  changes.board(await boardAudience(db, board.id), await taskChange(db, board.id, version, [row.task_id]));
  return json(await listComments(db, row.task_id));
}

export async function getTaskEvents(env: Env, viewer: Viewer, taskId: string) {
  await boardOfTask(env.DB, viewer, taskId);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.kind, u.handle AS actor_handle, e.before, e.after, e.via, e.run_id, e.created_at
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
      run_id: string | null;
      created_at: string;
    }>();
  const events: TaskEvent[] = results.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorHandle: r.actor_handle,
    before: r.before ? (JSON.parse(r.before) as Record<string, unknown>) : null,
    after: r.after ? (JSON.parse(r.after) as Record<string, unknown>) : null,
    via: r.via,
    run: r.run_id ? shortRunId(r.run_id) : null,
    createdAt: r.created_at,
  }));
  return json(events);
}
