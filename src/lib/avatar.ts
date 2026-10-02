/* ============================================================================
   A picture, made avatar-sized in the browser before it goes up.
   ----------------------------------------------------------------------------
   Cropped to the middle square and drawn at AVATAR_EDGE, so a phone photo
   goes up as a few dozen KB whatever it started as. WebP where the browser
   can encode it, PNG where it cannot. An animated GIF keeps its first frame.
   ========================================================================== */

import { api } from "./api";

/** Shown at 16 to 64 px; this covers 64 at 4x. */
const AVATAR_EDGE = 256;

export class AvatarError extends Error {}

async function square(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new AvatarError("That is not a picture");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarError("That picture could not be read");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const edge = Math.min(AVATAR_EDGE, side);
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext("2d");
  if (!context) throw new AvatarError("This browser cannot resize pictures");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, edge, edge);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  if (!blob) throw new AvatarError("That picture could not be resized");
  return blob;
}

/** Crop, shrink and PUT to `path` (/me/avatar, or an agent's); answers with what that route answers. */
export async function uploadAvatar<T>(file: File, path: string): Promise<T> {
  const blob = await square(file);
  /* A browser without a WebP encoder hands back a PNG, and says so in the type. */
  return api<T>(path, { method: "PUT", body: blob, headers: { "content-type": blob.type || "image/png" } });
}
