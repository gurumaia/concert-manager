import type { PhotoStore } from "../domain/photos.js";

/** In-memory object store for tests and local development. Its "signed" URLs point at the dev routes in app.ts. */
export class MemoryPhotoStore implements PhotoStore {
  objects = new Map<string, { data: Uint8Array; contentType: string }>();
  constructor(private baseUrl = "http://localhost") {}

  static idOf = (key: string) => Buffer.from(key).toString("base64url");
  static keyOf = (id: string) => Buffer.from(id, "base64url").toString();

  async presignPut(key: string, contentType: string) {
    return { url: `${this.baseUrl}/api/dev-store/${MemoryPhotoStore.idOf(key)}`, headers: { "content-type": contentType } };
  }
  async presignGet(key: string) { return `${this.baseUrl}/api/dev-store/${MemoryPhotoStore.idOf(key)}`; }
  async head(key: string) { const o = this.objects.get(key); return o ? { bytes: o.data.length } : undefined; }
  async peek(key: string, length: number) { return this.objects.get(key)?.data.slice(0, length); }
  async put(key: string, data: Uint8Array, contentType: string) { this.objects.set(key, { data: new Uint8Array(data), contentType }); }
  async copy(from: string, to: string, contentType: string) {
    const o = this.objects.get(from);
    if (!o) throw new Error("NoSuchKey");
    this.objects.set(to, { data: o.data, contentType });
  }
  async delete(key: string) { this.objects.delete(key); }
}
