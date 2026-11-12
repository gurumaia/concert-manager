import { op } from "./api";
import type { PhotoView } from "./types";

export const MAX_PHOTOS = 20;
const FULL_SIDE = 2000;
const THUMB_SIDE = 480;

async function render(bitmap: ImageBitmap, side: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff"; // transparent PNGs become JPEG
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process the image"))), "image/jpeg", quality));
}

/**
 * Shrinks a phone photo (often 5-12 MB) to a ~2000 px JPEG plus a small preview before upload.
 * Re-encoding also drops EXIF data such as GPS position, which matters for photos that may be shared.
 */
export async function prepareImage(file: File): Promise<{ full: Blob; thumb: Blob }> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error(`${file.name || "That file"} can't be read as an image by this browser. Try a JPEG or PNG.`); }
  try { return { full: await render(bitmap, FULL_SIDE, 0.85), thumb: await render(bitmap, THUMB_SIDE, 0.8) }; }
  finally { bitmap.close(); }
}

// The local dev server stands in for S3 on the page's own origin.
const target = (url: string) => (url.includes("/api/dev-store/") ? new URL(url).pathname : url);

async function put(url: string, headers: Record<string, string>, body: Blob) {
  const res = await fetch(target(url), { method: "PUT", headers, body });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

type UploadRequest = { photoId: string; upload: { url: string; headers: Record<string, string> }; thumbUpload?: { url: string; headers: Record<string, string> } };

/** Prepare, send straight to storage, then attach to the show. */
export async function uploadPhoto(eventId: string, file: File): Promise<PhotoView> {
  const { full, thumb } = await prepareImage(file);
  const req = await op<UploadRequest>("request_photo_upload", { eventId, contentType: "image/jpeg", bytes: full.size, thumbBytes: thumb.size });
  await put(req.upload.url, req.upload.headers, full);
  if (req.thumbUpload) await put(req.thumbUpload.url, req.thumbUpload.headers, thumb);
  return op<PhotoView>("confirm_photo", { eventId, photoId: req.photoId });
}
