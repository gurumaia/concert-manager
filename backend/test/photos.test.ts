import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../src/infra/safeFetch.js";
import { MemoryPhotoStore } from "../src/infra/memoryPhotoStore.js";
import { sniffImage } from "../src/domain/photos.js";
import { JPEG, PNG, WEBP, friedman, repoKinds, setup as baseSetup, type RepoKind } from "./helpers.js";

for (const kind of repoKinds) suite(kind);

function suite(kind: RepoKind) {

async function withEvent() {
  const s = await baseSetup(kind);
  const ev = (await s.svc.createEvent(s.me, friedman)).event;
  return { ...s, ev };
}
/** Browser flow: request URLs, "upload" the file, confirm. */
async function upload(s: Awaited<ReturnType<typeof withEvent>>, bytes: Uint8Array, opts: { thumb?: Uint8Array; claim?: string } = {}) {
  const r = await s.svc.requestPhotoUpload(s.me, s.ev.id, { contentType: opts.claim ?? "image/jpeg", bytes: bytes.length, thumbBytes: opts.thumb?.length });
  await s.photos.put(MemoryPhotoStore.keyOf(r.upload.url.split("/").pop()!), bytes, "text/html"); // a hostile client can send any type
  if (opts.thumb) await s.photos.put(MemoryPhotoStore.keyOf(r.thumbUpload!.url.split("/").pop()!), opts.thumb, "image/jpeg");
  return s.svc.confirmPhoto(s.me, s.ev.id, r.photoId, "  Front row  ");
}

describe(`photos: upload [${kind}]`, () => {
  it("signed upload then confirm files the photo, trims the caption and leaves nothing behind in tmp", async () => {
    const s = await withEvent();
    const p = await upload(s, PNG, { thumb: JPEG, claim: "image/png" });
    expect(p).toMatchObject({ eventId: s.ev.id, contentType: "image/png", caption: "Front row", mine: true, sharedWith: [] });
    expect(p.thumbUrl).not.toBe(p.url);
    expect(p).not.toHaveProperty("key");
    expect([...s.photos.objects.keys()].some((k) => k.startsWith("tmp/"))).toBe(false);
    // the stored type comes from the bytes, not from what the browser claimed
    expect([...s.photos.objects.entries()].find(([k]) => k.startsWith("p/") && !k.endsWith(".thumb"))![1].contentType).toBe("image/png");
    expect(await s.svc.listPhotos(s.me, s.ev.id)).toHaveLength(1);
  });

  it("trusts the bytes, not the declared type", async () => {
    const s = await withEvent();
    const r = await s.svc.requestPhotoUpload(s.me, s.ev.id, { contentType: "image/jpeg", bytes: 12 });
    await s.photos.put(MemoryPhotoStore.keyOf(r.upload.url.split("/").pop()!), new TextEncoder().encode("<html>nope</html>"), "image/jpeg");
    await expect(s.svc.confirmPhoto(s.me, s.ev.id, r.photoId)).rejects.toThrow(/not a JPEG, PNG or WebP/);
    expect(await s.svc.listPhotos(s.me, s.ev.id)).toHaveLength(0);
    expect(s.photos.objects.size).toBe(0); // the rejected upload is cleaned up
  });

  it("rejects a confirm with no upload, bad types and oversize requests", async () => {
    const s = await withEvent();
    await expect(s.svc.confirmPhoto(s.me, s.ev.id, "missing")).rejects.toThrow(/not found/);
    await expect(s.svc.requestPhotoUpload(s.me, s.ev.id, { contentType: "image/gif", bytes: 10 })).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(s.svc.requestPhotoUpload(s.me, s.ev.id, { contentType: "image/jpeg", bytes: 11 * 1024 * 1024 })).rejects.toThrow(/at most 10 MB/);
    await expect(s.svc.requestPhotoUpload(s.me, "nope", { contentType: "image/jpeg", bytes: 10 })).rejects.toThrow(/not found/i);
  });

  it("caps photos per show at 20", async () => {
    const s = await withEvent();
    for (let i = 0; i < 20; i++) s.images.set(`https://x.test/${i}.jpg`, JPEG);
    for (let i = 0; i < 20; i++) await s.svc.addPhotoFromUrl(s.me, s.ev.id, `https://x.test/${i}.jpg`);
    await expect(s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/0.jpg")).rejects.toThrow(/at most 20/);
    await expect(s.svc.requestPhotoUpload(s.me, s.ev.id, { contentType: "image/jpeg", bytes: 10 })).rejects.toThrow(/at most 20/);
  });
});

describe(`photos: from an AI assistant [${kind}]`, () => {
  it("imports from a URL and from base64", async () => {
    const s = await withEvent();
    s.images.set("https://press.example/a.webp", WEBP);
    const a = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://press.example/a.webp", "Press shot");
    expect(a).toMatchObject({ contentType: "image/webp", caption: "Press shot" });
    const b = await s.svc.addPhotoBase64(s.me, s.ev.id, `data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}`);
    expect(b.contentType).toBe("image/jpeg");
    expect(await s.svc.listPhotos(s.me, s.ev.id)).toHaveLength(2);
  });

  it("refuses dead links, non-images and big inline images", async () => {
    const s = await withEvent();
    await expect(s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://press.example/missing.jpg")).rejects.toThrow(/Could not download/);
    s.images.set("https://press.example/page.html", new TextEncoder().encode("<html>"));
    await expect(s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://press.example/page.html")).rejects.toThrow(/not a JPEG/);
    const big = new Uint8Array(1024 * 1024 + 1); big.set(JPEG);
    await expect(s.svc.addPhotoBase64(s.me, s.ev.id, Buffer.from(big).toString("base64"))).rejects.toThrow(/at most 1 MB/);
  });
});

describe(`photos: counts [${kind}]`, () => {
  it("event lists and details carry the number of photos you can see; shared shows count only what was shared", async () => {
    const s = await withEvent();
    const other = (await s.svc.createEvent(s.me, { title: "Other", date: "2026-10-01" })).event;
    for (const n of ["a", "b", "c"]) s.images.set(`https://x.test/${n}.jpg`, JPEG);
    const a = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/a.jpg");
    await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/b.jpg");
    await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/c.jpg");
    const counts = () => s.svc.listEvents(s.me, {}).then((r) => Object.fromEntries(r.events.map((e) => [e.id, e.photoCount])));
    expect(await counts()).toEqual({ [s.ev.id]: 3, [other.id]: 0 });
    expect((await s.svc.getEvent(s.me, s.ev.id)).photoCount).toBe(3);
    await s.svc.deletePhoto(s.me, s.ev.id, a.id);
    expect((await counts())[s.ev.id]).toBe(2);
    await s.svc.ensureUser(s.her);
    await s.svc.sharePhotos(s.me, s.ev.id, ["her@example.com"], [(await s.svc.listPhotos(s.me, s.ev.id))[0]!.id]);
    expect((await s.svc.listSharedWithMe(s.her))[0]!.photoCount).toBe(1); // not the owner's 2
  });
});

describe(`photos: privacy [${kind}]`, () => {
  it("are private by default: other users see nothing and cannot touch them", async () => {
    const s = await withEvent();
    s.images.set("https://x.test/a.jpg", JPEG);
    const p = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/a.jpg");
    expect(await s.svc.listPhotos(s.her, s.ev.id, s.me.userId)).toEqual([]);
    expect(await s.svc.listSharedWithMe(s.her)).toEqual([]);
    await expect(s.svc.deletePhoto(s.her, s.ev.id, p.id)).rejects.toThrow(/not found/i);
    await expect(s.svc.listPhotos(s.her, s.ev.id)).rejects.toThrow(/not found/i); // her own event list, not mine
  });

  it("share with chosen emails: they see only those photos, the show appears under shared-with-me without my RSVP", async () => {
    const s = await withEvent();
    await s.svc.setRsvp(s.me, s.ev.id, { status: "going", pricePaid: 300, notes: "secret" });
    s.images.set("https://x.test/a.jpg", JPEG); s.images.set("https://x.test/b.jpg", PNG);
    const a = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/a.jpg");
    await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/b.jpg");
    await s.svc.ensureUser(s.her);
    const shared = await s.svc.sharePhotos(s.me, s.ev.id, ["Her@Example.com", "me@example.com"], [a.id]);
    expect(shared[0]!.sharedWith).toEqual(["her@example.com"]); // lower-cased, never myself
    const seen = await s.svc.listPhotos(s.her, s.ev.id, s.me.userId);
    expect(seen.map((p) => p.id)).toEqual([a.id]);
    expect(seen[0]).toMatchObject({ mine: false, sharedWith: [] }); // viewers do not learn who else has it
    expect(seen[0]).not.toHaveProperty("publicUrl");
    const list = await s.svc.listSharedWithMe(s.her);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: s.ev.id, rsvp: null, attended: false, sharedBy: { id: "u1" } });
    await s.svc.unsharePhotos(s.me, s.ev.id, ["her@example.com"]);
    expect(await s.svc.listPhotos(s.her, s.ev.id, s.me.userId)).toEqual([]);
    expect(await s.svc.listSharedWithMe(s.her)).toEqual([]);
  });

  it("an RSVP share and a photo share of the same show show up once", async () => {
    const s = await withEvent();
    await s.svc.setRsvp(s.me, s.ev.id, { status: "going" });
    await s.svc.shareRsvp(s.me, s.ev.id, ["her@example.com"]);
    s.images.set("https://x.test/a.jpg", JPEG);
    await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/a.jpg");
    await s.svc.sharePhotos(s.me, s.ev.id, ["her@example.com"]);
    const list = await s.svc.listSharedWithMe(s.her);
    expect(list).toHaveLength(1);
    expect(list[0]!.rsvp?.status).toBe("going");
  });

  it("public link: works without sign-in, only for that photo, and revoking kills it", async () => {
    const s = await withEvent();
    s.images.set("https://x.test/a.jpg", JPEG); s.images.set("https://x.test/b.jpg", JPEG);
    const a = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/a.jpg");
    const b = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/b.jpg");
    expect(a).not.toHaveProperty("publicUrl");
    const [on] = await s.svc.setPhotosPublic({ ...s.me, baseUrl: "https://shows.example.com" }, s.ev.id, true, [a.id]);
    const token = on!.publicUrl!.split("/").pop()!;
    expect(on!.publicUrl).toBe(`https://shows.example.com/api/public/photos/${token}`);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(await s.svc.publicPhotoUrl(token)).toContain("/api/dev-store/");
    expect(await s.svc.publicPhotoUrl("guess")).toBeUndefined();
    expect((await s.svc.listPhotos(s.me, s.ev.id)).find((p) => p.id === b.id)).not.toHaveProperty("publicUrl");
    const again = await s.svc.setPhotosPublic(s.me, s.ev.id, true, [a.id]);
    expect(again[0]!.publicUrl).toContain(token); // turning it on twice keeps the same link
    await s.svc.setPhotosPublic(s.me, s.ev.id, false, [a.id]);
    expect(await s.svc.publicPhotoUrl(token)).toBeUndefined();
  });

  it("deleting a photo or its event removes the files, the share and the public link", async () => {
    const s = await withEvent();
    s.images.set("https://x.test/a.jpg", JPEG); s.images.set("https://x.test/b.jpg", JPEG);
    const a = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/a.jpg");
    await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/b.jpg");
    const [pub] = await s.svc.setPhotosPublic(s.me, s.ev.id, true);
    await s.svc.sharePhotos(s.me, s.ev.id, ["her@example.com"]);
    const token = pub!.publicUrl!.split("/").pop()!;
    await s.svc.deletePhoto(s.me, s.ev.id, a.id);
    expect(s.photos.objects.size).toBe(1);
    await s.svc.deleteEvent(s.me, s.ev.id);
    expect(s.photos.objects.size).toBe(0);
    expect(await s.svc.publicPhotoUrl(token)).toBeUndefined();
    expect(await s.repo.listPhotosSharedWith("her@example.com")).toEqual([]);
  });

  it("captions can be set and cleared", async () => {
    const s = await withEvent();
    s.images.set("https://x.test/a.jpg", JPEG);
    const a = await s.svc.addPhotoFromUrl(s.me, s.ev.id, "https://x.test/a.jpg");
    expect((await s.svc.updatePhoto(s.me, s.ev.id, a.id, "Encore")).caption).toBe("Encore");
    expect((await s.svc.updatePhoto(s.me, s.ev.id, a.id, null)).caption).toBeUndefined();
  });
});

}

describe("photo helpers", () => {
  it("sniffImage recognises the supported formats only", () => {
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("GIF89a......"))).toBeUndefined();
    expect(sniffImage(new Uint8Array())).toBeUndefined();
  });

  it("isBlockedAddress refuses everything that is not a public address", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "not-an-ip"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "172.15.255.255", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(a), a).toBe(false);
  });
});
