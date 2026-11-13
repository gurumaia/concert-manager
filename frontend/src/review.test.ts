import { describe, expect, it } from "vitest";
import { buildDeck, rangeLabel, slideDuration, slideImages, type Slide } from "./review";
import type { ReviewData, ReviewShow } from "./types";

const photo = (id: string) => ({ id, url: `/${id}.jpg`, thumbUrl: `/${id}-t.jpg` });
const show = (title: string, date: string, extra: Partial<ReviewShow> = {}): ReviewShow => ({
  date, title, lineup: [], companions: [], companionCount: 0, songs: [], photos: [], ...extra,
});
const data = (shows: ReviewShow[], recipe: Partial<ReviewData["recipe"]> = {}): ReviewData => ({ recipe: { from: "2026-01-01", to: "2026-12-31", ...recipe }, shows });
const kinds = (d: ReviewData) => buildDeck(d, "2026-12-31").map((s) => s.kind);

describe("buildDeck", () => {
  it("is empty without shows", () => expect(buildDeck(data([]))).toEqual([]));

  it("one show gives a short deck: an intro and an outro", () => {
    expect(kinds(data([show("Slayer", "2026-03-05")]))).toEqual(["intro", "outro"]);
  });

  it("leaves slides out until there is enough to say", () => {
    const s = [show("A", "2026-01-10"), show("B", "2026-02-10"), show("C", "2026-03-10")];
    expect(kinds(data(s))).toEqual(["intro", "bookends", "outro"]);
  });

  it("builds every slide for a rich year, in a fixed order", () => {
    const venue = { name: "Vibra", city: "São Paulo" };
    const s = [
      show("Slayer", "2026-03-05", { genre: "Metal", venue, companions: ["Ana"], companionCount: 1, songs: [{ name: "Raining Blood", act: "Slayer" }], photos: [photo("a"), photo("b")], score: 9 }),
      show("Slayer", "2026-03-20", { genre: "Metal", venue, songs: [{ name: "Raining Blood", act: "Slayer" }], photos: [photo("c")], score: 7 }),
      show("Bossa", "2026-09-14", { genre: "MPB", venue: { name: "Blue Note", city: "Rio" }, photos: [photo("d"), photo("e")] }),
    ];
    const deck = buildDeck(data(s), "2026-12-31");
    expect(deck.map((x) => x.kind)).toEqual(["intro", "months", "collage", "artists", "genres", "venue", "people", "best", "song", "gallery", "bookends", "outro"]);
    expect(deck[0]).toMatchObject({ count: 3, venues: 2, cities: 2, every: 122 });
    expect(deck[1]).toMatchObject({ best: "March", count: 2 });
    expect(deck.find((x) => x.kind === "best")).toMatchObject({ title: "Slayer", score: 9, when: "March 5, 2026" });
    expect(deck.find((x) => x.kind === "song")).toMatchObject({ name: "Raining Blood", act: "Slayer", count: 2 });
  });

  it("the busiest month is one calendar month, named with its year only when the range spans several years", () => {
    const s = [show("A", "2024-03-01"), show("B", "2024-03-09"), show("C", "2024-03-20"), show("D", "2025-08-02"), show("E", "2025-08-20")];
    const multi = buildDeck(data(s, { from: "2024-01-01", to: "2025-12-31" }), "2025-12-31").find((x) => x.kind === "months") as Extract<Slide, { kind: "months" }>;
    expect(multi).toMatchObject({ best: "March 2024", count: 3 });
    expect(multi.byMonth).toEqual([0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const one = buildDeck(data(s.slice(0, 3), { from: "2024-01-01", to: "2024-12-31" }), "2025-12-31").find((x) => x.kind === "months");
    expect(one).toMatchObject({ best: "March" });
    // the same month in two years is two different months: 2+2 is a tie, not 4
    const tie = [show("A", "2024-03-01"), show("B", "2024-03-09"), show("C", "2025-03-02"), show("D", "2025-03-20")];
    expect(buildDeck(data(tie, { from: "2024-01-01", to: "2025-12-31" }), "2025-12-31").map((x) => x.kind)).not.toContain("months");
  });

  it("the same song title by two bands is two songs, and the slide names the band", () => {
    const a = (act: string) => ({ name: "Intro", act });
    const s = [show("A", "2026-01-10", { songs: [a("Slayer"), a("Slayer")] }), show("B", "2026-02-10", { songs: [a("Sepultura")] }), show("C", "2026-03-10", { songs: [a("Sepultura")] }), show("D", "2026-04-10", { songs: [a("Sepultura")] })];
    const song = buildDeck(data(s), "2026-12-31").find((x) => x.kind === "song");
    expect(song).toMatchObject({ name: "Intro", act: "Sepultura", count: 3 });
  });

  it("photo captions use the show's name, not one of its acts", () => {
    const s = [show("Festival CPM 22", "2026-09-14", { lineup: [{ name: "Green Day", role: "headliner" }, { name: "CPM 22", role: "support" }], photos: [photo("a"), photo("b"), photo("c"), photo("d"), photo("e")] }), show("B", "2026-10-01")];
    const g = buildDeck(data(s), "2026-12-31").find((x) => x.kind === "gallery") as Extract<Slide, { kind: "gallery" }>;
    expect(g.pics.map((p) => p.label)).toEqual(Array(5).fill("Festival CPM 22 · Sep"));
  });

  it("no tie for busiest month, no 'crew' when the review is about specific people", () => {
    const s = [show("A", "2026-01-10", { companions: ["Ana"] }), show("B", "2026-02-10"), show("C", "2026-03-10")];
    expect(kinds(data(s))).not.toContain("months");
    expect(kinds(data(s))).toContain("people");
    expect(kinds(data(s, { people: ["Ana"] }))).not.toContain("people");
  });

  it("a counted artist is case- and accent-insensitive", () => {
    const s = [show("x", "2026-01-10", { lineup: [{ name: "Sepúltura", role: "headliner" }] }), show("y", "2026-02-10", { lineup: [{ name: "sepultura", role: "headliner" }] })];
    const a = buildDeck(data(s), "2026-12-31").find((x) => x.kind === "artists") as Extract<Slide, { kind: "artists" }>;
    expect(a.top).toEqual([{ name: "Sepúltura", count: 2 }]);
  });

  it("photos: no collage under three, spread over the year; a gallery from five; the best show without photos still gets a slide", () => {
    expect(kinds(data([show("A", "2026-01-10", { photos: [photo("a"), photo("b")] })]))).not.toContain("collage");
    const many = Array.from({ length: 6 }, (_, i) => show(`S${i}`, `2026-0${i + 1}-10`, { photos: [photo(`p${i}`)] }));
    const deck = buildDeck(data(many), "2026-12-31");
    const collage = deck.find((x) => x.kind === "collage") as Extract<Slide, { kind: "collage" }>;
    expect(collage.pics.map((p) => p.id)).toEqual(["p0", "p1", "p3", "p4"]);
    expect(collage.more).toBe(2);
    expect(deck.map((x) => x.kind)).toContain("gallery");
    const noPhotos = buildDeck(data([show("A", "2026-01-10", { score: 8 }), show("B", "2026-02-10")]), "2026-12-31").find((x) => x.kind === "best") as Extract<Slide, { kind: "best" }>;
    expect(noPhotos.pics).toEqual([]);
  });

  it("'one every N days' stops at today for a range that reaches into the future", () => {
    const d = buildDeck(data([show("A", "2026-01-10"), show("B", "2026-02-10")]), "2026-03-01");
    expect(d[0]).toMatchObject({ every: 30 }); // 60 days so far / 2 shows
  });

  it("slideshows take as long as their photos", () => {
    const pics = [1, 2, 3].map((i) => ({ ...photo(`p${i}`), label: "" }));
    expect(slideDuration({ kind: "gallery", pics })).toBe(9000);
    expect(slideDuration({ kind: "best", title: "", score: 1, when: "", pics: [pics[0]!] })).toBe(6000);
  });
});

describe("rangeLabel", () => {
  it("names whole calendar years and spells out other ranges", () => {
    expect(rangeLabel("2026-01-01", "2026-12-31")).toBe("2026");
    expect(rangeLabel("2026-03-05", "2026-09-14")).toBe("Mar 5 – Sep 14, 2026");
    expect(rangeLabel("2025-07-01", "2026-06-30")).toBe("Jul 1, 2025 – Jun 30, 2026");
  });
});

describe("slideImages", () => {
  const pic = (id: string) => ({ ...photo(id), label: "" });
  it("lists what each slide shows: previews for the collage and small polaroids, full photos for slideshows, nothing for text slides", () => {
    expect(slideImages({ kind: "collage", pics: [pic("a"), pic("b")], more: 0 })).toEqual(["/a-t.jpg", "/b-t.jpg"]);
    expect(slideImages({ kind: "venue", name: "V", count: 2, withCompany: 0, pic: pic("c") })).toEqual(["/c-t.jpg"]);
    expect(slideImages({ kind: "artists", top: [] })).toEqual([]);
    expect(slideImages({ kind: "gallery", pics: [pic("d"), pic("e")] })).toEqual(["/d.jpg", "/e.jpg"]);
    expect(slideImages({ kind: "best", title: "", score: 1, when: "", pics: [pic("f")] })).toEqual(["/f.jpg"]);
    expect(slideImages({ kind: "outro", range: "", count: 1, photos: 0 })).toEqual([]);
  });
});
