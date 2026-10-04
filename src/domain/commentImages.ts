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

/* ---------------------------------------------------- from an assistant --- */

/**
 * The most bytes one image from comment_on_task may be, decoded. An MCP
 * request carries them as base64 in one JSON body, so the cap keeps the
 * whole call (COMMENT_IMAGES_MAX of them) well inside an isolate's memory.
 */
export const TOOL_IMAGE_BYTES_MAX = 5 * 1024 * 1024;
const TOOL_IMAGE_NAME_MAX = 120;

/** An image an assistant sent, decoded and its type read from its bytes. */
export interface ToolImage {
  name: string;
  type: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

/** PNG or JPEG by its magic numbers, whatever the name says; anything else is null. */
export function sniffImage(bytes: Uint8Array): ToolImage["type"] | null {
  const starts = (sig: number[]) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

/**
 * comment_on_task's `images`: absent is none, otherwise a list of
 * { name, data } with data base64 (a `data:...;base64,` prefix is allowed),
 * at most COMMENT_IMAGES_MAX, each at most TOOL_IMAGE_BYTES_MAX decoded and
 * a PNG or JPEG by its bytes. A refusal names the image and the limit.
 */
export function parseToolImages(raw: unknown): { ok: true; images: ToolImage[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "`images` must be a list of { name, data }" };
  if (raw.length > COMMENT_IMAGES_MAX) return { ok: false, reason: `A comment can have at most ${COMMENT_IMAGES_MAX} images, not ${raw.length}` };
  const megabytes = TOOL_IMAGE_BYTES_MAX / 1024 / 1024;
  const images: ToolImage[] = [];
  for (const [i, item] of raw.entries()) {
    const which = `Image ${i + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, reason: `${which} must be { name, data }` };
    const { name, data, ...rest } = item as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length) return { ok: false, reason: `${which} has unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")}; it takes name and data` };
    if (typeof name !== "string" || !name.trim()) return { ok: false, reason: `${which} needs a name` };
    if (name.trim().length > TOOL_IMAGE_NAME_MAX) return { ok: false, reason: `${which}'s name is longer than ${TOOL_IMAGE_NAME_MAX} characters` };
    const label = `${which} (${name.trim()})`;
    if (typeof data !== "string" || !data) return { ok: false, reason: `${label} needs data, the file as base64` };
    const base64 = data.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
    /* Refused before decoding: four characters carry three bytes. */
    if (Math.floor((base64.length * 3) / 4) - 2 > TOOL_IMAGE_BYTES_MAX) {
      return { ok: false, reason: `${label} is too big: the limit is ${megabytes} MB per image` };
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) return { ok: false, reason: `${label}'s data is not base64` };
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    if (bytes.length > TOOL_IMAGE_BYTES_MAX) return { ok: false, reason: `${label} is too big: the limit is ${megabytes} MB per image` };
    const type = sniffImage(bytes);
    if (!type) return { ok: false, reason: `${label} is not a PNG or JPEG (its bytes say so, whatever its name)` };
    images.push({ name: name.trim(), type, bytes });
  }
  return { ok: true, images };
}
