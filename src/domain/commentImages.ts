/* ============================================================================
   Images on comments (COPL-117, migrations/0027_comment_attachments.sql).
   ----------------------------------------------------------------------------
   A comment carries uploaded images: keys from POST /api/uploads, claimed the
   way a task attachment claims one (routes/attachments.ts claimUpload). Only
   images, and only so many: a comment is a message, not a gallery. Shared by
   the Worker, which refuses, and the browser, which can say so before it
   uploads.
   ========================================================================== */

/** The most images one comment holds. */
export const COMMENT_IMAGES_MAX = 6;

/** What a comment's image may be: the types every browser shows inline. */
export const COMMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const isCommentImage = (mime: string) =>
  (COMMENT_IMAGE_TYPES as readonly string[]).includes(mime.split(";")[0].trim().toLowerCase());

/**
 * The `attachments` field of a new comment: absent is none, otherwise a list
 * of distinct upload keys, at most COMMENT_IMAGES_MAX. A refusal says why.
 */
export function parseCommentImages(raw: unknown): { ok: true; keys: string[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, keys: [] };
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string" || !k)) {
    return { ok: false, reason: "`attachments` must be a list of upload keys" };
  }
  const keys = raw as string[];
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "`attachments` names the same file twice" };
  if (keys.length > COMMENT_IMAGES_MAX) {
    return { ok: false, reason: `A comment can have at most ${COMMENT_IMAGES_MAX} images` };
  }
  return { ok: true, keys };
}
