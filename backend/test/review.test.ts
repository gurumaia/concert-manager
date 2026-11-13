import { describe, expect, it } from "vitest";
import { JPEG, repoKinds, setup as baseSetup, type RepoKind } from "./helpers.js";

for (const kind of repoKinds) suite(kind);

function suite(kind: RepoKind) {
  // "today" in the test clock is 2026-11-10
  async function withShows() {
    const s = await baseSetup(kind);
    const mk = async (title: string, date: string, rsvp: Parameters<typeof s.svc.setRsvp>[2] | null, extra: Record<string, unknown> = {}) => {
      const e = (await s.svc.createEvent(s.me, { title, date, venue: { name: "Vibra", city: "São Paulo", timezone: "America/Sao_Paulo" }, ...extra })).event;
      if (rsvp) await s.svc.setRsvp(s.me, e.id, rsvp);
      return e;
    };
    const a = await mk("Slayer", "2026-03-05", { status: "going", companions: ["Ana", "Bruno"], score: 9 }, { genre: "Metal" });
    const b = await mk("Maiden", "2026-09-14", { status: "going", companions: ["ana "] });
    const c = await mk("Solo night", "2026-10-01", { status: "going" });
    const skipped = await mk("Skipped", "2026-06-01", { status: "skipped" });
    const old = await mk("Last year", "2025-12-31", { status: "going", companions: ["Ana"] });
    const future = await mk("Future", "2026-12-24", { status: "going" });
    s.images.set("https://x.test/a.jpg", JPEG);
    await s.svc.addPhotoFromUrl(s.me, a.id, "https://x.test/a.jpg", "Front row");
    return { ...s, a, b, c, skipped, old, future };
  }
  const year = { from: "2026-01-01", to: "2026-12-31" };

  describe(`year in review [${kind}]`, () => {
    it("covers only attended shows in the range, oldest first, with photos", async () => {
      const s = await withShows();
      const r = await s.svc.yearReview(s.me, year);
      expect(r.shows.map((x) => x.title)).toEqual(["Slayer", "Maiden", "Solo night"]);
      expect(r.shows[0]).toMatchObject({ genre: "Metal", score: 9, venue: { name: "Vibra", city: "São Paulo" }, companions: ["Ana", "Bruno"] });
      expect(r.shows[0]!.photos).toHaveLength(1);
      expect(r.shows[0]!.photos[0]).toMatchObject({ caption: "Front row" });
      expect(r.shows[1]!.photos).toEqual([]);
      expect(JSON.stringify(r)).not.toMatch(/pricePaid|notes|email/);
    });

    it("each song says which act played it, and songs played from tape are left out", async () => {
      const s = await withShows();
      await s.svc.setSetlist(s.me, s.a.id, { act: "Slayer", songs: [{ name: "Raining Blood" }, { name: "Intro", tape: true }] });
      const r = await s.svc.yearReview(s.me, year);
      expect(r.shows[0]!.songs).toEqual([{ name: "Raining Blood", act: "Slayer" }]);
    });

    it("filters by people, ignoring case and accents, with any or all", async () => {
      const s = await withShows();
      expect((await s.svc.yearReview(s.me, { ...year, people: ["ANA"] })).shows.map((x) => x.title)).toEqual(["Slayer", "Maiden"]);
      expect((await s.svc.yearReview(s.me, { ...year, people: ["Ana", "Bruno"] })).shows.map((x) => x.title)).toEqual(["Slayer", "Maiden"]);
      expect((await s.svc.yearReview(s.me, { ...year, people: ["Ana", "Bruno"], match: "all" })).shows.map((x) => x.title)).toEqual(["Slayer"]);
      expect((await s.svc.yearReview(s.me, { ...year, people: ["Nobody"] })).shows).toEqual([]);
    });

    it("rejects an inverted range", async () => {
      const s = await withShows();
      await expect(s.svc.yearReview(s.me, { from: "2026-12-31", to: "2026-01-01" })).rejects.toThrow(/after the end/);
    });

    it("a shared link shows the live review without sign-in, hides names unless asked, and stops when revoked", async () => {
      const s = await withShows();
      const link = await s.svc.createReviewLink(s.me, { ...year, people: ["Ana"] }, false);
      expect(link.url).toBe(`https://shows.example.com/r/${link.token}`);
      const pub = (await s.svc.publicReview(link.token))!;
      expect(pub.shows.map((x) => x.title)).toEqual(["Slayer", "Maiden"]);
      expect(pub.shows[0]).toMatchObject({ companions: [], companionCount: 2 });
      expect(pub.owner).toBeUndefined();

      // live: a new photo on a matching show appears without touching the link
      s.images.set("https://x.test/b.jpg", JPEG);
      await s.svc.addPhotoFromUrl(s.me, s.b.id, "https://x.test/b.jpg");
      expect((await s.svc.publicReview(link.token))!.shows[1]!.photos).toHaveLength(1);

      const named = await s.svc.createReviewLink(s.me, year, true);
      expect((await s.svc.publicReview(named.token))!.shows[0]!.companions).toEqual(["Ana", "Bruno"]);

      expect(await s.svc.listReviewLinks(s.me)).toHaveLength(2);
      await expect(s.svc.revokeReviewLink(s.her, link.token)).rejects.toThrow(/not found/i);
      await s.svc.revokeReviewLink(s.me, link.token);
      expect(await s.svc.publicReview(link.token)).toBeUndefined();
      expect(await s.svc.publicReview("nope")).toBeUndefined();
    });
  });
}
