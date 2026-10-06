/** Pictures attached to a question (paste, drop or the attach button). */

/** Same cap as `_MAX_IMAGES` in backend/routers/news_ai.py. */
export const MAX_ASK_IMAGES = 4;
export const ASK_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** Longest side sent to the model — past this a vision model scales it down itself. */
const MAX_SIDE = 1568;
const JPEG_QUALITY = 0.85;

/** Image files among what a paste or a drop carried. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files].filter((f) => ASK_IMAGE_ACCEPT.split(",").includes(f.type));
}

/**
 * One picture as a JPEG data URL no longer than MAX_SIDE on its long side — a
 * 4K screenshot goes from ~8 MB of PNG to a few hundred KB, which is what
 * travels with the question. Transparency is laid on white.
 */
export async function toAskImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}
