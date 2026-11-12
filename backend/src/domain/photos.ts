/** Photos attached to a show. Private to the owner unless shared with specific emails or given a public link. */
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
export const MAX_PHOTOS_PER_EVENT = 20;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_THUMB_BYTES = 300 * 1024;
/** Inline (MCP) uploads carry the image inside the tool call, so they stay small. */
export const MAX_INLINE_BYTES = 1024 * 1024;

export type Photo = {
  id: string;
  eventId: string;
  key: string;
  thumbKey?: string;
  contentType: PhotoType;
  bytes: number;
  caption?: string;
  sharedWith: string[];
  /** Random, unguessable. Present = anyone with the link can see this photo. Clearing it revokes the link. */
  publicToken?: string;
  createdAt: string;
};

export type PhotoRef = { ownerId: string; eventId: string; photoId: string };

/** What callers see: signed, short-lived URLs instead of storage keys. */
export type PhotoView = Omit<Photo, "key" | "thumbKey" | "publicToken"> & {
  url: string;
  thumbUrl: string;
  /** Owner only. */
  publicUrl?: string;
  mine: boolean;
};

/** Object storage port (S3 in production). Keys are chosen by the service. */
export interface PhotoStore {
  presignPut(key: string, contentType: string, bytes: number): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<{ bytes: number } | undefined>;
  /** First bytes of an object, to check what it really is. */
  peek(key: string, length: number): Promise<Uint8Array | undefined>;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** Copies an object, replacing its stored content type with the one we verified from the bytes. */
  copy(from: string, to: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What the bytes actually are, from their header (the client-declared type is never trusted). */
export function sniffImage(b: Uint8Array): PhotoType | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

/** Fetches an image from the open internet for add_photo_from_url; must refuse private addresses (see infra/safeFetch.ts). */
export type ImageFetcher = (url: string, opts: { maxBytes: number }) => Promise<{ data: Uint8Array; contentType?: string }>;
