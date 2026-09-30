/* ============================================================================
   Notes: the notepad pane. Personal, so every query is scoped by the
   viewer's id and a note that is someone else's reads as not found, the same
   as one that does not exist.

   Saves are whole-field and the last one wins. The notepad saves while you
   type and another device only takes a newer copy when its own draft is
   clean (features/notepad), so two devices overwriting each other needs both
   to be typing in the same note at once.
   ========================================================================== */

import { NOTE_CONTENT_MAX, NOTE_NAME_MAX, type Note } from "@/domain/panes";
import type { Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";

interface NoteRow {
  id: string;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

const rowToNote = (row: NoteRow): Note => ({
  id: row.id,
  name: row.name,
  content: row.content,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function noteName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("`name` must be a non-empty string");
  const name = raw.trim();
  if (name.length > NOTE_NAME_MAX) throw badRequest(`\`name\` is longer than ${NOTE_NAME_MAX} characters`);
  return name;
}

function noteContent(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("`content` must be a string");
  if (raw.length > NOTE_CONTENT_MAX) throw badRequest(`\`content\` is longer than ${NOTE_CONTENT_MAX} characters`);
  return raw;
}

async function noteFor(db: D1Database, userId: string, id: string): Promise<Note> {
  const row = await db
    .prepare(`SELECT id, name, content, created_at, updated_at FROM notes WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<NoteRow>();
  if (!row) throw notFound("No such note");
  return rowToNote(row);
}

/** GET /api/notes: newest first, with content. A notepad's worth is small. */
export async function getNotes(env: Env, viewer: Viewer): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, content, created_at, updated_at FROM notes WHERE user_id = ?1 ORDER BY updated_at DESC`,
  )
    .bind(viewer.user.id)
    .all<NoteRow>();
  return json(results.map(rowToNote));
}

/** POST /api/notes { name?, content? } */
export async function postNote(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  const name = body.name === undefined ? "untitled" : noteName(body.name);
  const content = body.content === undefined ? "" : noteContent(body.content);
  const now = nowIso();
  const row: NoteRow = { id: crypto.randomUUID(), name, content, created_at: now, updated_at: now };
  await env.DB.prepare(
    `INSERT INTO notes (id, user_id, name, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(row.id, viewer.user.id, row.name, row.content, row.created_at, row.updated_at)
    .run();
  changes.notify([viewer.user.id], "notes");
  return json(rowToNote(row), { status: 201 });
}

/** PATCH /api/notes/:id { name?, content? } */
export async function patchNote(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  changes: Changes,
): Promise<Response> {
  const body = await readJson(request);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    sets.push(`name = ?${values.length + 3}`);
    values.push(noteName(body.name));
  }
  if (body.content !== undefined) {
    sets.push(`content = ?${values.length + 3}`);
    values.push(noteContent(body.content));
  }
  if (sets.length === 0) throw badRequest("Nothing to update");
  sets.push(`updated_at = ?${values.length + 3}`);
  values.push(nowIso());
  const result = await env.DB.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?1 AND user_id = ?2`)
    .bind(id, viewer.user.id, ...values)
    .run();
  if (result.meta.changes === 0) throw notFound("No such note");
  changes.notify([viewer.user.id], "notes");
  return json(await noteFor(env.DB, viewer.user.id, id));
}

export async function deleteNote(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  const result = await env.DB.prepare(`DELETE FROM notes WHERE id = ?1 AND user_id = ?2`)
    .bind(id, viewer.user.id)
    .run();
  if (result.meta.changes === 0) throw notFound("No such note");
  changes.notify([viewer.user.id], "notes");
  return json({ ok: true });
}
