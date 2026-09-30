/* ============================================================================
   Attachments: files, images and links on a task.
   ----------------------------------------------------------------------------
   Ported from the work tracker. Two steps for a file, on purpose:

     1. POST /api/uploads                   bytes → R2, returns a key
     2. POST /api/tasks/:id/attachments     { key } or { url, name? }

   Why not one multipart request: `request.formData()` buffers the whole body
   and an isolate has 128 MB, so a big file in a form is a crash rather than
   an upload. Here the body is one raw file streamed straight into R2. The
   ceiling is the account plan's request body limit (100 MB on Free);
   MAX_UPLOAD_BYTES sits just under it.

   Reading a file back goes through the Worker, never a public bucket URL, and
   is allowed to whoever can read the task's board. That check is new here:
   the work tracker was one company where everyone saw everything. A file
   uploaded but not yet attached (the new-task form holds keys until the task
   exists) is readable only by its uploader.

   An upload that is never attached leaves an R2 object with no row: cheap,
   unreachable except by its uploader, and sweepable by prefix and age.
   ========================================================================== */

import type { Attachment, UploadedFile, Viewer } from "@/domain/types";
import { requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, HttpError, json, notFound, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience } from "../repo/boards";
import { eventStatement, findTask } from "../repo/tasks";

/** Just under the 100 MB Free-plan request body cap. */
export const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
const PREFIX = "attachments/";
const MAX_LINK_NAME = 120;
const MAX_URL = 2000;
const MAX_PER_TASK = 50;

/** Types people actually share. Anything else is refused by name. */
const ALLOWED_MIME = [
  /^image\//,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/vnd\.ms-/,
  /^application\/msword$/,
  /* Not text/*: text/html is a web page, and served from here it would run
     as whoever opened it. */
  /^text\/(plain|csv|markdown)$/,
  /^application\/zip$/,
  /^video\/(mp4|quicktime|webm)$/,
];

const isAllowed = (mime: string) => ALLOWED_MIME.some((p) => p.test(mime));
const megabytes = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

/**
 * POST /api/uploads
 *   content-type: the file's own type
 *   x-file-name: the original filename, URI-encoded
 *   body: the raw bytes
 */
export async function postUpload(request: Request, env: Env, viewer: Viewer): Promise<Response> {
  const mime = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!mime) throw badRequest("content-type is required");
  if (!isAllowed(mime)) throw badRequest(`That file type is not supported: ${mime}`);

  const rawName = request.headers.get("x-file-name");
  if (!rawName) throw badRequest("x-file-name is required");
  let name: string;
  try {
    name = decodeURIComponent(rawName).trim();
  } catch {
    throw badRequest("x-file-name must be URI-encoded");
  }
  if (!name) throw badRequest("x-file-name is empty");

  /* Content-Length is advisory, so it only rejects early; R2's byte count
     after the write is the one enforced. */
  if (Number(request.headers.get("content-length") ?? "0") > MAX_UPLOAD_BYTES) {
    throw badRequest(`That file is too big (the limit is ${megabytes} MB)`);
  }
  if (!request.body) throw badRequest("Body is empty");

  const key = `${PREFIX}${crypto.randomUUID()}`;
  const object = await env.FILES.put(key, request.body, {
    httpMetadata: { contentType: mime },
    /* On the object itself, so the bucket stays legible without the
       database, and so an unattached upload knows whose it is. */
    customMetadata: { name, uploadedBy: viewer.user.id },
  });
  if (!object) throw new Error("R2 put returned no object");
  if (object.size > MAX_UPLOAD_BYTES) {
    await env.FILES.delete(key);
    throw badRequest(`That file is too big (the limit is ${megabytes} MB)`);
  }

  const file: UploadedFile = {
    key,
    name,
    type: mime,
    size: object.size,
    kind: mime.startsWith("image/") ? "image" : "file",
  };
  return json({ file }, { status: 201 });
}

/**
 * Shown in the page when opened. Everything else downloads: an SVG or HTML
 * file opened as a page on this origin could run script as whoever clicked.
 * An <img> still renders an SVG; only navigating to it downloads.
 */
const INLINE_TYPES = [/^image\/(png|jpeg|gif|webp|avif|bmp)$/, /^video\/(mp4|quicktime|webm)$/, /^application\/pdf$/];

/** GET /api/attachments/attachments/:id */
export async function getAttachment(env: Env, viewer: Viewer, key: string, download: boolean): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT t.board_id FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.key = ?1`,
  )
    .bind(key)
    .first<{ board_id: string }>();

  const object = await env.FILES.get(key);
  if (!object) throw notFound();
  if (row) {
    /* Someone not on the board gets the same 404 as a key that never existed. */
    await requireBoard(env.DB, viewer, row.board_id).catch(() => {
      throw notFound();
    });
  } else if (object.customMetadata?.uploadedBy !== viewer.user.id) {
    throw notFound();
  }

  const name = object.customMetadata?.name ?? "file";
  const mime = (object.httpMetadata?.contentType ?? "").split(";")[0].trim().toLowerCase();
  const inline = !download && INLINE_TYPES.some((p) => p.test(mime));
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  /* Whatever the browser renders gets no script, no forms and no
     same-origin access. Chrome's PDF viewer does not run under `sandbox`,
     so a PDF gets the same lockdown without it. */
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    mime === "application/pdf"
      ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'",
  );
  /* The task modal previews PDFs in an <object> on this origin. */
  headers.set("x-frame-options", "SAMEORIGIN");
  /* Per-identity: a shared cache must never hold one. */
  headers.set("cache-control", "private, max-age=3600");
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
  return new Response(object.body, { headers });
}

/* ------------------------------------------------------ on a task ------- */

async function editableTask(env: Env, viewer: Viewer, taskId: string) {
  const task = await findTask(env.DB, taskId);
  if (!task) throw notFound("No such task");
  const board = await requireBoard(env.DB, viewer, task.boardId, "editor").catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 404 ? notFound("No such task") : error;
  });
  return { task, board };
}

type NewAttachment = Omit<Attachment, "createdAt">;

function parseLink(body: Record<string, unknown>): NewAttachment {
  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (!raw || raw.length > MAX_URL) throw badRequest("A valid link is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("A valid link is required");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("Links must be http or https");
  /* No title fetching: the interesting links (Drive, Figma) answer anyone
     who is not the person with a login page. The name is what they typed,
     or the host. */
  const typed = typeof body.name === "string" ? body.name.trim() : "";
  return {
    id: crypto.randomUUID(),
    kind: "link",
    name: (typed || url.hostname.replace(/^www\./, "")).slice(0, MAX_LINK_NAME),
    type: "",
    size: 0,
    key: null,
    url: url.toString(),
  };
}

/** An uploaded key, checked against R2 and against being used already. */
async function parseUpload(env: Env, viewer: Viewer, body: Record<string, unknown>): Promise<NewAttachment> {
  const key = body.key;
  if (typeof key !== "string" || !key.startsWith(PREFIX)) throw badRequest("Invalid file key");
  const used = await env.DB.prepare(`SELECT 1 FROM attachments WHERE key = ?1`).bind(key).first();
  if (used) throw badRequest("That file is already attached somewhere; upload it again");
  const object = await env.FILES.head(key);
  if (!object) throw badRequest("The uploaded file was not found; try again");
  /* Only your own uploads: a key someone else uploaded is not yours to attach. */
  if (object.customMetadata?.uploadedBy !== viewer.user.id) throw badRequest("Invalid file key");
  const mime = object.httpMetadata?.contentType ?? "application/octet-stream";
  return {
    id: crypto.randomUUID(),
    kind: mime.startsWith("image/") ? "image" : "file",
    name: object.customMetadata?.name ?? (typeof body.name === "string" && body.name.trim() ? body.name.trim() : "file"),
    type: mime,
    size: object.size,
    key,
    url: null,
  };
}

/** POST /api/tasks/:id/attachments: one file ({ key }) or one link ({ url, name? }). */
export async function postTaskAttachment(request: Request, env: Env, viewer: Viewer, taskId: string, changes: Changes) {
  const { task, board } = await editableTask(env, viewer, taskId);
  if (task.attachments.length >= MAX_PER_TASK) throw badRequest(`A task can have at most ${MAX_PER_TASK} attachments`);
  const body = await readJson(request);
  const file = body.url !== undefined ? parseLink(body) : await parseUpload(env, viewer, body);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attachments (id, task_id, name, mime, size, kind, key, url, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(file.id, taskId, file.name, file.type, file.size, file.kind, file.key, file.url, viewer.user.id),
    eventStatement(env.DB, {
      boardId: board.id,
      taskId,
      actorId: viewer.user.id,
      kind: "attachment.added",
      after: { kind: file.kind, name: file.name },
    }),
  ]);
  changes.notify(await boardAudience(env.DB, board.id), "board");
  const updated = await findTask(env.DB, taskId);
  return json({ attachment: updated?.attachments.find((a) => a.id === file.id) }, { status: 201 });
}

/**
 * DELETE /api/tasks/:id/attachments/:attachmentId. The row goes; the R2
 * object is deleted too, since nothing else can point at it.
 */
export async function deleteTaskAttachment(env: Env, viewer: Viewer, taskId: string, attachmentId: string, changes: Changes) {
  const { task, board } = await editableTask(env, viewer, taskId);
  const attachment = task.attachments.find((a) => a.id === attachmentId);
  if (!attachment) throw notFound("No such attachment on this task");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM attachments WHERE id = ?1`).bind(attachmentId),
    eventStatement(env.DB, {
      boardId: board.id,
      taskId,
      actorId: viewer.user.id,
      kind: "attachment.removed",
      before: { kind: attachment.kind, name: attachment.name },
    }),
  ]);
  if (attachment.key) await env.FILES.delete(attachment.key);
  changes.notify(await boardAudience(env.DB, board.id), "board");
  return json({ ok: true, id: attachmentId });
}
