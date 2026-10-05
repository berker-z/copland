/* ============================================================================
   A board's notes and docs (COPL-27).
   ----------------------------------------------------------------------------
   Notes are the board's rules for working on it: up to MAX_BOARD_NOTES
   characters of markdown that owners and editors edit, and that the MCP
   guide quotes under the board for every assistant working there.

   Docs are reference files that belong to the board. They are attachments
   in everything but their owner: the bytes go up through POST /api/uploads
   (routes/attachments.ts) and come back through the same authenticated
   GET /api/attachments/<key>, which lets in whoever can read the board.
   A row here holds the key and what someone needs to know the doc exists
   without opening it: name, type, size, a description the uploader gave,
   and, for a text doc, an excerpt (its first heading, or how it opens).

   A text doc can also be written in place from JSON ({ name, text }): an
   assistant has no bytes to upload, and markdown is what it would write.
   Replacing a text doc's text writes a new object under a new key, so no
   cached copy of the old one is ever served as the new.

   Viewers read; editors add, change and remove. Docs never reach an
   assistant unasked: the guide lists their metadata, read_doc fetches one.
   ========================================================================== */

import { MAX_BOARD_NOTES, type BoardDocContent, type Viewer } from "@/domain/types";
import { requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, conflict, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience } from "../repo/boards";
import { findDoc } from "../repo/docs";
import { eventStatement } from "../repo/tasks";
import { claimUpload, PREFIX } from "./attachments";

const MAX_DOCS = 50;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 200;
const EXCERPT = 200;
/** How much of a text doc GET returns: enough for any brief, short of a book. */
const MAX_TEXT_BYTES = 256 * 1024;
/** A text doc written from JSON. */
const MAX_WRITTEN_BYTES = 1024 * 1024;

const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv"];
const isText = (mime: string) => TEXT_TYPES.includes(mime.split(";")[0].trim().toLowerCase());

function docName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("`name` must be a non-empty string");
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length > MAX_NAME) throw badRequest(`\`name\` is longer than ${MAX_NAME} characters`);
  if (/[/\\]/.test(name)) throw badRequest("`name` cannot contain slashes");
  return name;
}

function description(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw badRequest("`description` must be a string");
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length > MAX_DESCRIPTION) throw badRequest(`\`description\` is longer than ${MAX_DESCRIPTION} characters`);
  return text;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * What a text doc is about, from its opening: its title when the first
 * line is a markdown heading, otherwise its first EXCERPT characters with
 * whitespace folded. Only ever the opening, so the guide never carries
 * more of a doc than this.
 */
export function excerptOf(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  const heading = lines.length ? /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[0]) : null;
  if (heading?.[1]) return clip(heading[1], EXCERPT);
  return clip(lines.join(" ").slice(0, EXCERPT * 2).replace(/\s+/g, " ").trim(), EXCERPT);
}

/** The opening of an R2 text object, decoded; a character cut in half at the end is dropped. */
async function readText(env: Env, key: string, bytes: number): Promise<{ text: string; size: number } | null> {
  const object = await env.FILES.get(key, { range: { offset: 0, length: bytes } });
  if (!object) return null;
  const text = new TextDecoder().decode(await object.arrayBuffer()).replace(/�+$/, "");
  return { text, size: object.size };
}

/** A name for a doc written as text: a markdown file unless it already says what it is. */
function textDocName(raw: unknown): { name: string; mime: string } {
  const name = docName(raw);
  if (/\.(txt|text)$/i.test(name)) return { name, mime: "text/plain" };
  if (/\.csv$/i.test(name)) return { name, mime: "text/csv" };
  return { name: /\.(md|markdown)$/i.test(name) ? name : `${name}.md`, mime: "text/markdown" };
}

function docText(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("`text` must be a string");
  if (!raw.trim()) throw badRequest("`text` is empty");
  if (new TextEncoder().encode(raw).length > MAX_WRITTEN_BYTES) {
    throw badRequest(`\`text\` is over ${MAX_WRITTEN_BYTES / 1024 / 1024} MB; upload it as a file instead`);
  }
  return raw;
}

/** Write text as a new R2 object, the way POST /api/uploads would have. */
async function putText(env: Env, viewer: Viewer, name: string, mime: string, text: string): Promise<{ key: string; size: number }> {
  const key = `${PREFIX}${crypto.randomUUID()}`;
  const object = await env.FILES.put(key, text, {
    httpMetadata: { contentType: `${mime}; charset=utf-8` },
    customMetadata: { name, uploadedBy: viewer.user.id },
  });
  if (!object) throw new Error("R2 put returned no object");
  return { key, size: object.size };
}

async function nameTaken(db: D1Database, boardId: string, name: string, except = ""): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM board_docs WHERE board_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3`)
    .bind(boardId, name, except)
    .first();
  return row !== null;
}

/* ---------------------------------------------------------------- notes -- */

/** PUT /api/boards/:id/notes { notes }: owners and editors. '' clears them. */
export async function putBoardNotes(request: Request, env: Env, viewer: Viewer, boardId: string, changes: Changes) {
  await requireBoard(env.DB, viewer, boardId, "editor");
  const body = await readJson(request);
  if (typeof body.notes !== "string") throw badRequest("`notes` must be a string ('' clears them)");
  const notes = body.notes.replace(/\r\n/g, "\n").trim();
  if (notes.length > MAX_BOARD_NOTES) {
    throw badRequest(`Board notes are at most ${MAX_BOARD_NOTES} characters (these are ${notes.length})`);
  }
  const before = await env.DB.prepare(`SELECT notes FROM boards WHERE id = ?1`).bind(boardId).first<{ notes: string }>();
  if (before?.notes === notes) return json({ notes });
  await env.DB.batch([
    env.DB.prepare(`UPDATE boards SET notes = ?2 WHERE id = ?1`).bind(boardId, notes),
    eventStatement(env.DB, { boardId, taskId: null, actorId: viewer.user.id, kind: "board.notes", before: before?.notes ?? "", after: notes }),
  ]);
  changes.board(await boardAudience(env.DB, boardId), { board: boardId });
  return json({ notes });
}

/* ----------------------------------------------------------------- docs -- */

/**
 * POST /api/boards/:id/docs: editors. Either an upload, { key, name?,
 * description? } with the key from POST /api/uploads, or a text doc written
 * in place, { name, text, description? } (markdown unless the name ends in
 * .txt or .csv). Names are unique on the board, ignoring case.
 */
export async function postBoardDoc(request: Request, env: Env, viewer: Viewer, boardId: string, changes: Changes) {
  await requireBoard(env.DB, viewer, boardId, "editor");
  const body = await readJson(request);
  const count = await env.DB.prepare(`SELECT count(*) AS n FROM board_docs WHERE board_id = ?1`).bind(boardId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_DOCS) throw badRequest(`A board can have at most ${MAX_DOCS} docs`);
  const about = description(body.description);

  let name: string;
  let mime: string;
  let key: string;
  let size: number;
  let excerpt = "";
  if (body.text !== undefined) {
    if (body.key !== undefined) throw badRequest("Pass `key` (an upload) or `text`, not both");
    const text = docText(body.text);
    ({ name, mime } = textDocName(body.name));
    if (await nameTaken(env.DB, boardId, name)) throw conflict(`This board already has a doc called ${name}`);
    ({ key, size } = await putText(env, viewer, name, mime, text));
    excerpt = excerptOf(text);
  } else {
    const upload = await claimUpload(env, viewer, body.key);
    name = docName(body.name ?? upload.name ?? "file");
    mime = upload.mime.split(";")[0].trim();
    key = upload.key;
    size = upload.size;
    if (await nameTaken(env.DB, boardId, name)) throw conflict(`This board already has a doc called ${name}`);
    if (isText(mime)) excerpt = excerptOf((await readText(env, key, 16 * 1024))?.text ?? "");
  }

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_docs (id, board_id, name, mime, size, key, description, excerpt, added_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(id, boardId, name, mime, size, key, about, excerpt, viewer.user.id),
    eventStatement(env.DB, { boardId, taskId: null, actorId: viewer.user.id, kind: "doc.added", after: { name, type: mime } }),
  ]);
  changes.board(await boardAudience(env.DB, boardId), { board: boardId });
  return json({ doc: await findDoc(env.DB, boardId, id) }, { status: 201 });
}

/**
 * GET /api/boards/:id/docs/:docId: anyone on the board. The doc's metadata,
 * and its text when it is a text doc (the first MAX_TEXT_BYTES of it).
 * Anything else is fetched as bytes from /api/attachments/<key>.
 */
export async function getBoardDoc(env: Env, viewer: Viewer, boardId: string, docId: string) {
  await requireBoard(env.DB, viewer, boardId);
  const doc = await findDoc(env.DB, boardId, docId);
  if (!doc) throw notFound("No such doc on this board");
  let content: BoardDocContent = { doc, text: null, truncated: false };
  if (isText(doc.type)) {
    const read = await readText(env, doc.key, MAX_TEXT_BYTES);
    if (!read) throw notFound("That doc's file is missing");
    content = { doc, text: read.text, truncated: read.size > MAX_TEXT_BYTES };
  }
  return json(content);
}

/**
 * PATCH /api/boards/:id/docs/:docId { name?, description?, text? }: editors.
 * text replaces a text doc's contents (a new object; the old one goes).
 */
export async function patchBoardDoc(request: Request, env: Env, viewer: Viewer, boardId: string, docId: string, changes: Changes) {
  await requireBoard(env.DB, viewer, boardId, "editor");
  const doc = await findDoc(env.DB, boardId, docId);
  if (!doc) throw notFound("No such doc on this board");
  const body = await readJson(request);
  const name = body.name !== undefined ? docName(body.name) : doc.name;
  if (body.name !== undefined && (await nameTaken(env.DB, boardId, name, docId))) {
    throw conflict(`This board already has a doc called ${name}`);
  }
  const about = body.description !== undefined ? description(body.description) : doc.description;
  let key = doc.key;
  let size = doc.size;
  let excerpt = doc.excerpt;
  if (body.text !== undefined) {
    if (!isText(doc.type)) throw badRequest(`${doc.name} is not a text doc (it is ${doc.type}); only text docs can be rewritten. Upload a new one instead.`);
    const text = docText(body.text);
    ({ key, size } = await putText(env, viewer, name, doc.type, text));
    excerpt = excerptOf(text);
  }
  if (name === doc.name && about === doc.description && key === doc.key) return json({ doc });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_docs SET name = ?3, description = ?4, key = ?5, size = ?6, excerpt = ?7, updated_at = ?8
        WHERE id = ?1 AND board_id = ?2`,
    ).bind(docId, boardId, name, about, key, size, excerpt, nowIso()),
    eventStatement(env.DB, {
      boardId,
      taskId: null,
      actorId: viewer.user.id,
      kind: "doc.changed",
      before: { name: doc.name },
      after: { name, ...(key !== doc.key ? { text: true } : {}) },
    }),
  ]);
  if (key !== doc.key) await env.FILES.delete(doc.key);
  changes.board(await boardAudience(env.DB, boardId), { board: boardId });
  return json({ doc: await findDoc(env.DB, boardId, docId) });
}

/** DELETE /api/boards/:id/docs/:docId: editors. The row and its R2 object both go. */
export async function deleteBoardDoc(env: Env, viewer: Viewer, boardId: string, docId: string, changes: Changes) {
  await requireBoard(env.DB, viewer, boardId, "editor");
  const doc = await findDoc(env.DB, boardId, docId);
  if (!doc) throw notFound("No such doc on this board");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM board_docs WHERE id = ?1`).bind(docId),
    eventStatement(env.DB, { boardId, taskId: null, actorId: viewer.user.id, kind: "doc.removed", before: { name: doc.name } }),
  ]);
  await env.FILES.delete(doc.key);
  changes.board(await boardAudience(env.DB, boardId), { board: boardId });
  return json({ ok: true, id: docId });
}
