import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PhotoStore } from "../domain/photos.js";

export class S3PhotoStore implements PhotoStore {
  constructor(private bucket: string, private s3 = new S3Client({})) {}

  async presignPut(key: string, contentType: string, bytes: number) {
    // Type and length are part of the signature, so the browser cannot upload anything else with this URL.
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: bytes }), { expiresIn: 600, unhoistableHeaders: new Set(["content-length"]), signableHeaders: new Set(["content-type"]) });
    return { url, headers: { "content-type": contentType } };
  }
  presignGet(key: string, ttlSeconds: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseCacheControl: "private, max-age=3000" }), { expiresIn: ttlSeconds });
  }
  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: r.ContentLength ?? 0 };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return undefined;
      throw e;
    }
  }
  async peek(key: string, length: number) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${length - 1}` }));
      return await r.Body!.transformToByteArray();
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NoSuchKey") return undefined;
      throw e;
    }
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async copy(from: string, to: string, contentType: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${from.split("/").map(encodeURIComponent).join("/")}`, Key: to, ContentType: contentType, MetadataDirective: "REPLACE" }));
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
