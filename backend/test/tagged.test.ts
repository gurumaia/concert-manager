import { describe, expect, it } from "vitest";
import { JPEG, friedman, repoKinds, setup, type RepoKind } from "./helpers.js";

for (const kind of repoKinds) suite(kind);

function suite(kind: RepoKind) {
  /** `me` tags `her` (her@example.com) on a show that is already over. */
  const tagged = async (extra: Record<string, unknown> = {}) => {
    const s = await setup(kind);
    await s.svc.ensureUser(s.her);
    const ev = (await s.svc.createEvent(s.me, { ...friedman, date: "2020-03-04", ...extra })).event;
    await s.svc.setRsvp(s.me, ev.id, { status: "going", companions: ["Her <her@example.com>", "Bruno"] });
    return { ...s, ev };
  };
  const list = async (s: Awaited<ReturnType<typeof tagged>>, who: "me" | "her" = "her") => (await s.svc.listEvents(s[who], { tagged: true, limit: 500 })).events;

  describe(`tagged shows in my own lists [${kind}]`, () => {
    it("a tagged show appears in the tagged person's list, unanswered, with who tagged them; plain lists leave it out", async () => {
      const s = await tagged();
      const [t] = await list(s);
      expect(t).toMatchObject({ id: s.ev.id, tagged: true, rsvp: null, taggedBy: [{ id: s.me.userId, email: "me@example.com" }] });
      expect((await s.svc.listEvents(s.her, { limit: 500 })).events).toHaveLength(0);
      expect((await s.svc.getEvent(s.her, s.ev.id)).tagged).toBe(true);
      expect(await list(s, "me")).toHaveLength(1); // the owner's own show, not tagged
      expect((await list(s, "me"))[0]?.tagged).toBeUndefined();
    });

    it("they answer on their own: their RSVP and score are theirs, the owner's are untouched, and a past going show counts as attended", async () => {
      const s = await tagged();
      const r = await s.svc.setRsvp(s.her, s.ev.id, { status: "going", notes: "front row", companions: ["Nobody"], tierName: "x", score: 8.5 });
      expect(r.rsvp).toMatchObject({ status: "going", notes: "front row", score: 8.5 });
      expect(r.rsvp.companions).toBeUndefined();
      expect(r.rsvp.tierName).toBeUndefined();
      expect(r.rsvp.sharedWith).toEqual([]);
      const [t] = await list(s);
      expect(t).toMatchObject({ attended: true, topScore: 8.5 });
      expect((await s.svc.getEvent(s.me, s.ev.id)).rsvp?.score).toBeUndefined();
      await s.svc.setScores(s.her, s.ev.id, { score: 9 });
      expect((await s.svc.getEvent(s.her, s.ev.id)).topScore).toBe(9);
      await s.svc.removeRsvp(s.her, s.ev.id);
      expect((await s.svc.getEvent(s.her, s.ev.id)).rsvp).toBeNull();
    });

    it("the details stay the owner's: a tagged person cannot edit or delete the show", async () => {
      const s = await tagged();
      await expect(s.svc.updateEvent(s.her, s.ev.id, { title: "Mine now" })).rejects.toThrow(/not found/);
      await expect(s.svc.deleteEvent(s.her, s.ev.id)).rejects.toThrow(/not found/);
      await expect(s.svc.getEvent({ userId: "stranger", email: "x@example.com" }, s.ev.id)).rejects.toThrow(/not found/);
    });

    it("a show they already have themselves appears once, as theirs, marked with who tagged them", async () => {
      const s = await tagged();
      const mine = (await s.svc.createEvent(s.her, { ...friedman, date: "2020-03-04" })).event;
      const l = await list(s);
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ id: mine.id, taggedBy: [{ id: s.me.userId }] });
      expect(l[0]?.tagged).toBeUndefined();
      expect((await s.svc.getEvent(s.her, mine.id)).taggedBy).toHaveLength(1);
    });

    it("they can add their own photos to it; the owner never sees them", async () => {
      const s = await tagged();
      await s.svc.addPhotoBase64(s.her, s.ev.id, Buffer.from(JPEG).toString("base64"));
      expect(await s.svc.listPhotos(s.her, s.ev.id)).toHaveLength(1);
      expect(await s.svc.listPhotos(s.me, s.ev.id)).toHaveLength(0);
      expect((await list(s))[0]?.photoCount).toBe(1);
    });
  });

  describe(`being taken off a show I answered [${kind}]`, () => {
    it("offers a copy: keeping moves my RSVP, score and photos onto a show of my own", async () => {
      const s = await tagged();
      await s.svc.setRsvp(s.her, s.ev.id, { status: "going", score: 7 });
      await s.svc.addPhotoBase64(s.her, s.ev.id, Buffer.from(JPEG).toString("base64"));
      await s.svc.setRsvp(s.me, s.ev.id, { status: "going", companions: ["Bruno"] }); // her email dropped
      expect(await list(s)).toHaveLength(0);
      const losses = await s.svc.listTagLosses(s.her);
      expect(losses).toEqual([expect.objectContaining({ eventId: s.ev.id, title: friedman.title, photoCount: 1 })]);
      const out = await s.svc.resolveTagLoss(s.her, s.me.userId, s.ev.id, true);
      expect(out.kept).toBe(true);
      const [mine] = await list(s);
      expect(mine).toMatchObject({ title: friedman.title, date: "2020-03-04", topScore: 7, photoCount: 1 });
      expect(mine?.id).not.toBe(s.ev.id);
      expect(mine?.tagged).toBeUndefined();
      expect(await s.svc.listPhotos(s.her, mine!.id)).toHaveLength(1);
      expect(await s.svc.listTagLosses(s.her)).toEqual([]);
    });

    it("letting go deletes my RSVP, score and photos of it", async () => {
      const s = await tagged();
      await s.svc.setRsvp(s.her, s.ev.id, { status: "going" });
      await s.svc.addPhotoBase64(s.her, s.ev.id, Buffer.from(JPEG).toString("base64"));
      await s.svc.unshareRsvp(s.me, s.ev.id, ["her@example.com"]);
      await s.svc.resolveTagLoss(s.her, s.me.userId, s.ev.id, false);
      expect(await list(s)).toHaveLength(0);
      expect((await s.svc.listEvents(s.her, { tagged: true })).total).toBe(0);
      await expect(s.svc.resolveTagLoss(s.her, s.me.userId, s.ev.id, true)).rejects.toThrow(/Nothing to resolve/);
    });

    it("someone who never answered just stops seeing it, and a deleted show is offered too", async () => {
      const s = await tagged();
      await s.svc.setRsvp(s.me, s.ev.id, { status: "going", companions: [] });
      expect(await s.svc.listTagLosses(s.her)).toEqual([]);

      const again = await tagged({ title: "Second", date: "2020-05-05" });
      await again.svc.setRsvp(again.her, again.ev.id, { status: "interested" });
      await again.svc.deleteEvent(again.me, again.ev.id);
      expect((await again.svc.listTagLosses(again.her)).map((l) => l.title)).toEqual(["Second"]);
      const kept = await again.svc.resolveTagLoss(again.her, again.me.userId, again.ev.id, true);
      expect(kept.kept).toBe(true);
      expect((await list(again)).map((e) => e.title)).toEqual(["Second"]);
    });

    it("being tagged again clears the offer", async () => {
      const s = await tagged();
      await s.svc.setRsvp(s.her, s.ev.id, { status: "going" });
      await s.svc.setRsvp(s.me, s.ev.id, { status: "going", companions: [] });
      expect(await s.svc.listTagLosses(s.her)).toHaveLength(1);
      await s.svc.shareRsvp(s.me, s.ev.id, ["her@example.com"]);
      expect(await s.svc.listTagLosses(s.her)).toEqual([]);
      expect((await list(s))[0]?.rsvp?.status).toBe("going");
    });
  });
}
