// Warms the browser cache with the photos that are about to be shown, so flipping through the story never flashes an empty frame.
const MAX_KEPT = 80;
// Holding the Image objects keeps the decoded pictures in memory (and stops the request being cancelled when the object is collected).
const kept = new Map<string, HTMLImageElement>();

export function preload(urls: string[]): void {
  if (typeof Image === "undefined") return;
  for (const url of urls) {
    if (!url || kept.has(url)) continue;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    img.decode?.().catch(() => undefined); // a photo that fails to load is handled where it is shown
    kept.set(url, img);
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  }
}
