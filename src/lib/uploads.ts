/* ============================================================================
   Client-side upload, ported from the work tracker.
   ----------------------------------------------------------------------------
   Each file is POSTed as a raw body to /api/uploads and comes back as a key
   that a task then references. No multipart: the Worker would have to buffer
   the whole form, and an isolate only gets 128 MB.

   Big photos are downscaled first, purely as a courtesy to whoever is on bad
   wifi; the server neither knows nor cares. Anything that is not a
   downscalable image goes up untouched.
   ========================================================================== */

import type { Attachment, UploadedFile } from "@/domain/types";
import { api } from "./api";

/** Matches the Worker's cap (worker/routes/attachments.ts). */
export const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;

/** Longest edge after downscaling: enough for a full-screen retina view. */
const MAX_IMAGE_EDGE = 2400;
/** Below this, downscaling costs more than it saves. */
const DOWNSCALE_ABOVE_BYTES = 400 * 1024;
const JPEG_QUALITY = 0.85;
const DOWNSCALABLE = /^image\/(png|jpe?g|webp)$/i;

export class UploadError extends Error {}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The original blob unchanged when downscaling would not help or fails. */
async function downscaleImage(file: File): Promise<Blob> {
  if (!DOWNSCALABLE.test(file.type) || file.size < DOWNSCALE_ABOVE_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    /* Only when it actually got smaller: a flat-colour PNG can grow as a JPEG. */
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(`“${file.name}” is too big (the limit is ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`);
  }
  const body = await downscaleImage(file);
  /* A downscaled image is a JPEG whatever went in. */
  const type = body === file ? file.type || "application/octet-stream" : "image/jpeg";
  const { file: uploaded } = await api<{ file: UploadedFile }>("/uploads", {
    method: "POST",
    body,
    headers: { "content-type": type, "x-file-name": encodeURIComponent(file.name) },
  });
  return uploaded;
}

/** The authenticated URL for an uploaded object. Never a public R2 link. */
export function attachmentUrl(key: string, download = false): string {
  return `/api/attachments/${key}${download ? "?download=1" : ""}`;
}

/** Where an attachment opens: its own address for a link, our route for a file. */
export function attachmentHref(file: Pick<Attachment, "kind" | "url" | "key">, download = false): string {
  if (file.kind === "link") return file.url ?? "#";
  return attachmentUrl(file.key ?? "", download);
}

export function hostOf(url: string | null): string {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
