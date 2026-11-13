import { describe, expect, it } from "vitest";
import { JPEG, friedman, repoKinds, setup, type RepoKind } from "./helpers.js";

for (const kind of repoKinds) suite(kind);

function suite(kind: RepoKind) {
  const shows = async () => {
    const s = await setup(kind);
    const a = (await s.svc.createEvent(s.me, friedman)).event;
    const b = (await s.svc.createEvent(s.me, { ...friedman, title: "Second show", date: "2031-03-04" })).event;
    await s.svc.ensureUser(s.her);
    return { ...s, a, b };
  };
  const photo = (s: Awaited<ReturnType<typeof shows>>, eventId: string) => s.svc.addPhotoBase64(s.me, eventId, Buffer.from(JPEG).toString("base64"));

  describe(`going with: linked people [${kind}]`, () => {
    it("sharing follows the 'Going with' list: an email adds the share, removing the person drops it", async () => {
      const s = await shows();
      const r = await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: ["Her <Her@Example.com>", "Bruno"] });
      expect(r.rsvp.companions).toEqual(["Her", "Bruno"]);
      expect(r.rsvp.sharedWith).toEqual(["her@example.com"]);
      expect((await s.svc.listSharedWithMe(s.her)).map((e) => e.id)).toEqual([s.a.id]);
      expect(await s.svc.listPeople(s.me)).toEqual([{ key: "her", name: "Her", email: "her@example.com" }]);

      await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: ["Bruno"] });
      expect(await s.svc.listSharedWithMe(s.her)).toHaveLength(0);
    });

    it("a bare email links the person it already belongs to, or creates one named from the address", async () => {
      const s = await shows();
      await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: ["Ana Souza <ana@x.com>"] });
      const r = await s.svc.setRsvp(s.me, s.b.id, { status: "going", companions: ["ana@x.com", "joao.silva@x.com"] });
      expect(r.rsvp.companions).toEqual(["Ana Souza", "Joao silva"]);
      expect(r.rsvp.sharedWith.sort()).toEqual(["ana@x.com", "joao.silva@x.com"]);
    });

    it("adding an email to a name already used on past and upcoming shows shares all of them, photos included", async () => {
      const s = await shows();
      await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: ["Bruno"] });
      await s.svc.setRsvp(s.me, s.b.id, { status: "interested", companions: ["bruno", "Carla"] });
      await photo(s, s.a.id);
      const out = await s.svc.setPersonEmail(s.me, "Bruno", "Her@Example.com");
      expect(out.shows).toBe(2);
      expect((await s.svc.listSharedWithMe(s.her)).map((e) => e.id).sort()).toEqual([s.a.id, s.b.id].sort());
      expect((await s.svc.listPhotos(s.her, s.a.id, s.me.userId))).toHaveLength(1);

      // a photo added later goes to the people on the show too
      await photo(s, s.a.id);
      expect(await s.svc.listPhotos(s.her, s.a.id, s.me.userId)).toHaveLength(2);

      // changing the email moves the share; clearing it stops it
      await s.svc.setPersonEmail(s.me, "Bruno", "other@example.com");
      expect(await s.svc.listSharedWithMe(s.her)).toHaveLength(0);
      expect(await s.svc.listPhotos(s.her, s.a.id, s.me.userId)).toHaveLength(0);
      await s.svc.setPersonEmail(s.me, "Bruno", null);
      expect(await s.svc.listPeople(s.me)).toEqual([]);
      expect((await s.svc.getEvent(s.me, s.a.id)).rsvp?.sharedWith).toEqual([]);
    });

    it("keeps manual shares, and does not unshare an email another person on the show still uses", async () => {
      const s = await shows();
      await s.svc.setRsvp(s.me, s.a.id, { status: "going" });
      await s.svc.shareRsvp(s.me, s.a.id, ["manual@example.com"]);
      await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: ["Ana <her@example.com>", "Ana's sister <her@example.com>"] });
      await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: ["Ana's sister"] });
      expect((await s.svc.getEvent(s.me, s.a.id)).rsvp?.sharedWith.sort()).toEqual(["her@example.com", "manual@example.com"]);
      await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: [] });
      expect((await s.svc.getEvent(s.me, s.a.id)).rsvp?.sharedWith).toEqual(["manual@example.com"]);
    });

    it("never shares with yourself, and rejects an invalid email", async () => {
      const s = await shows();
      const r = await s.svc.setRsvp(s.me, s.a.id, { status: "going", companions: ["Me <me@example.com>"] });
      expect(r.rsvp.sharedWith).toEqual([]);
      await expect(s.svc.setPersonEmail(s.me, "Ana", "not-an-email")).rejects.toThrow(/valid email/);
    });
  });
}
