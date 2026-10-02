/* ============================================================================
   Your profile: the handle you go by and the picture beside it.
   ----------------------------------------------------------------------------
     PATCH  /api/me           { handle }
     PUT    /api/me/avatar    raw image bytes, content-type: its type
     DELETE /api/me/avatar
     GET    /api/avatars/:id  a picture, to whoever can see its owner

   Only ever your own: there is no route that changes someone else's. Unlike
   settings, these are seen by others, so a change reaches everyone who shows
   them (peopleAudience) and not just your own tabs.

   Mentions and assignments point at user ids, never at handles, so a rename
   breaks nothing; the old handle is free for anyone the moment it changes.

   A picture is stored as sent. The browser crops and shrinks it first
   (lib/avatar.ts); the cap here only keeps a script from storing a poster.
   Each upload gets a new key and the old object is deleted, so a picture's
   URL never changes what it shows and can be cached for good.
   ========================================================================== */

import { handleProblem, normalizeHandle } from "@/domain/handle";
import type { Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, conflict, notFound, readJson } from "../http";
import type { Changes } from "../live";
import { AVATAR_PREFIX, findUserById, peopleAudience, rowToUser } from "../repo/users";
import { getMe } from "./personal";

const MAX_AVATAR_BYTES = 1024 * 1024;
/* Types an <img> shows everywhere. Not SVG: it can carry script. */
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Answers like GET /api/me, from the row as it is now. */
async function freshMe(env: Env, viewer: Viewer): Promise<Response> {
  const row = await findUserById(env.DB, viewer.user.id);
  if (!row) throw notFound();
  return getMe(env, { ...viewer, user: rowToUser(row) });
}

/** PATCH /api/me { handle } */
export async function patchMe(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.handle !== "string") throw badRequest("`handle` must be a string");
  const handle = normalizeHandle(body.handle);
  const problem = handleProblem(handle);
  if (problem) throw badRequest(problem);

  if (handle !== viewer.user.handle) {
    const taken = await env.DB.prepare(`SELECT 1 FROM users WHERE handle = ?1 AND id != ?2`)
      .bind(handle, viewer.user.id)
      .first();
    if (taken) throw conflict(`\`${handle}\` is taken`);
    try {
      await env.DB.prepare(`UPDATE users SET handle = ?2 WHERE id = ?1`).bind(viewer.user.id, handle).run();
    } catch (error) {
      /* Someone took it between the check and the write. */
      if (String(error).includes("UNIQUE")) throw conflict(`\`${handle}\` is taken`);
      throw error;
    }
    changes.notify(await peopleAudience(env.DB, viewer.user.id), "people");
  }
  return freshMe(env, viewer);
}

/** PUT /api/me/avatar: the picture's bytes as the body. */
export async function putAvatar(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const mime = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!AVATAR_TYPES.has(mime)) throw badRequest("A picture is a PNG, JPEG, WebP or GIF");
  const tooBig = `That picture is too big (the limit is ${MAX_AVATAR_BYTES / 1024} KB)`;
  if (Number(request.headers.get("content-length") ?? "0") > MAX_AVATAR_BYTES) throw badRequest(tooBig);
  /* Buffered: it is small, and the size has to be known before it is kept. */
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw badRequest("Body is empty");
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw badRequest(tooBig);

  const key = `${AVATAR_PREFIX}${crypto.randomUUID()}`;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { userId: viewer.user.id },
  });
  await replaceAvatar(env, viewer, key);
  changes.notify(await peopleAudience(env.DB, viewer.user.id), "people");
  return freshMe(env, viewer);
}

/** DELETE /api/me/avatar: back to initials. */
export async function deleteAvatar(env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  await replaceAvatar(env, viewer, null);
  changes.notify(await peopleAudience(env.DB, viewer.user.id), "people");
  return freshMe(env, viewer);
}

async function replaceAvatar(env: Env, viewer: Viewer, key: string | null): Promise<void> {
  const old = await env.DB.prepare(`SELECT avatar_key FROM users WHERE id = ?1`)
    .bind(viewer.user.id)
    .first<{ avatar_key: string | null }>();
  await env.DB.prepare(`UPDATE users SET avatar_key = ?2 WHERE id = ?1`).bind(viewer.user.id, key).run();
  if (old?.avatar_key && old.avatar_key !== key) await env.FILES.delete(old.avatar_key);
}

/**
 * GET /api/avatars/:id. Seen by the people who can see its owner anywhere
 * else: themselves, anyone on a board with them, and admins. Everyone else
 * gets the same 404 as a key that never existed.
 */
export async function getAvatar(env: Env, viewer: Viewer, key: string): Promise<Response> {
  const visible = await env.DB.prepare(
    `SELECT 1 FROM users u
      WHERE u.avatar_key = ?1
        AND (u.id = ?2 OR ?3 = 1 OR EXISTS (
              SELECT 1 FROM board_members theirs
                JOIN board_members mine ON mine.board_id = theirs.board_id
               WHERE theirs.user_id = u.id AND mine.user_id = ?2))`,
  )
    .bind(key, viewer.user.id, viewer.user.isAdmin ? 1 : 0)
    .first();
  if (!visible) throw notFound();
  const object = await env.FILES.get(key);
  if (!object) throw notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  /* Private: who may see it depends on who asks. Immutable: a new picture is a new key. */
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
