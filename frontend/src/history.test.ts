import { describe, expect, it } from "vitest";
import { ALONE, addCompanions, suggestPeople, companionsOf, groupByYear, headliner, lastYearStart, matches, peopleOf, summarize, withWho } from "./history";
import type { EventView } from "./types";

let n = 0;
const ev = (date: string, o: Partial<EventView> = {}): EventView => ({
  id: `e${++n}`, title: "Show", date, createdAt: "", updatedAt: "", venue: null,
  rsvp: { eventId: "x", status: "attended", sharedWith: [], createdAt: "", updatedAt: "" }, ...o,
});
const venue = (name: string) => ({ id: name, name, createdAt: "", updatedAt: "" });

describe("headliner", () => {
  it("prefers the headliner role, then the first act, then the title", () => {
    expect(headliner({ title: "T", lineup: [{ name: "Opener", role: "opener" }, { name: "Star", role: "headliner" }] })).toBe("Star");
    expect(headliner({ title: "T", lineup: [{ name: "First" }, { name: "Second" }] })).toBe("First");
    expect(headliner({ title: "Just Title" })).toBe("Just Title");
  });
});

describe("summarize", () => {
  it("fills quiet years with 0 so the chart has no gaps", () => {
    const s = summarize([ev("2006-05-01"), ev("2009-01-01"), ev("2009-02-01")]);
    expect(s.years).toEqual([{ year: 2006, count: 1 }, { year: 2007, count: 0 }, { year: 2008, count: 0 }, { year: 2009, count: 2 }]);
  });
  it("counts artists and venues ignoring case and accents, and ranks them", () => {
    const s = summarize([
      ev("2010-01-01", { title: "Sepultura", venue: venue("Audio") }),
      ev("2011-01-01", { title: "sepultura", venue: venue("Audio") }),
      ev("2012-01-01", { title: "Angra", venue: venue("Tom Brasil") }),
    ]);
    expect(s.topArtists[0]).toEqual({ name: "Sepultura", count: 2 });
    expect(s.artists).toBe(2);
    expect(s.topVenues[0]).toEqual({ name: "Audio", count: 2 });
    expect(s.venues).toBe(2);
  });
  it("sums price and fees per currency and skips shows with no price", () => {
    const paid = (pricePaid: number, feesPaid?: number) => ({ eventId: "x", status: "attended" as const, pricePaid, feesPaid, sharedWith: [], createdAt: "", updatedAt: "" });
    const s = summarize([ev("2010-01-01", { rsvp: paid(100, 10) }), ev("2011-01-01", { currency: "USD", rsvp: paid(50) }), ev("2012-01-01")]);
    expect(s.spent).toEqual({ BRL: 110, USD: 50 });
  });
  it("handles an empty history", () => {
    expect(summarize([])).toMatchObject({ total: 0, years: [], spent: {} });
  });
});

describe("matches / groupByYear", () => {
  it("searches title, acts, venue, city and genre without caring about accents", () => {
    const e = ev("2010-01-01", { title: "Tour", lineup: [{ name: "Sepultura" }], venue: { ...venue("Audio"), city: "São Paulo" }, genre: "Thrash" });
    for (const t of ["sepultura", "AUDIO", "sao paulo", "thrash", ""]) expect(matches(e, t)).toBe(true);
    expect(matches(e, "metallica")).toBe(false);
  });
  it("groups newest year first and newest show first within a year", () => {
    const g = groupByYear([ev("2010-03-01"), ev("2012-01-01"), ev("2010-09-01")]);
    expect(g.map((x) => x.year)).toEqual([2012, 2010]);
    expect(g[1]!.events.map((e) => e.date)).toEqual(["2010-09-01", "2010-03-01"]);
  });
});

const withPeople = (date: string, companions?: string[]) => ev(date, { rsvp: { eventId: "x", status: "attended", sharedWith: [], createdAt: "", updatedAt: "", companions } });

describe("who I went with", () => {
  it("treats spelling variants of a name as one person and keeps the first spelling", () => {
    expect(companionsOf(withPeople("2020-01-01", ["Ana", " ana ", "JOÃO  Silva", "joao silva", ""]))).toEqual([
      { key: "ana", name: "Ana" }, { key: "joao silva", name: "JOÃO Silva" },
    ]);
  });
  it("ranks people by shows together", () => {
    const l = [withPeople("2020-01-01", ["Ana", "Bruno"]), withPeople("2021-01-01", ["ana"]), withPeople("2022-01-01")];
    expect(peopleOf(l).map((p) => [p.name, p.count])).toEqual([["Ana", 2], ["Bruno", 1]]);
  });
  it("shows the spelling used most, preferring capitals on a tie", () => {
    const l = [withPeople("2020-01-01", ["ana"]), withPeople("2021-01-01", ["Ana"]), withPeople("2022-01-01", ["Ana"]), withPeople("2023-01-01", ["bia"]), withPeople("2024-01-01", ["Bia"])];
    expect(peopleOf(l).map((p) => p.name)).toEqual(["Ana", "Bia"]);
  });
  it("filters by person, by alone, and not at all", () => {
    const a = withPeople("2020-01-01", ["Ana"]), solo = withPeople("2021-01-01"), none = withPeople("2022-01-01", []);
    expect([a, solo, none].filter((e) => withWho(e, "ana"))).toEqual([a]);
    expect([a, solo, none].filter((e) => withWho(e, ALONE))).toEqual([solo, none]);
    expect([a, solo, none].filter((e) => withWho(e))).toHaveLength(3);
  });
  it("starts the last 12 months one year back", () => {
    expect(lastYearStart(new Date(2026, 10, 11))).toBe("2025-11-11");
  });
  it("adds names, splitting commas and skipping ones already listed", () => {
    expect(addCompanions(["Ana"], " bruno ,  Carla Souza, ANA ,")).toEqual(["Ana", "bruno", "Carla Souza"]);
    expect(addCompanions(["Ana"], "  ")).toEqual(["Ana"]);
  });
  it("suggests known people, best match first, never ones already on the list", () => {
    const people = peopleOf([withPeople("2020-01-01", ["Maria Ana", "Ana", "Bruno", "Joana"]), withPeople("2021-01-01", ["Ana"])]);
    expect(suggestPeople(people, "an", [])).toEqual(["Ana", "Maria Ana", "Joana"]);
    expect(suggestPeople(people, "an", ["ana"])).toEqual(["Maria Ana", "Joana"]);
    expect(suggestPeople(people, "", ["Bruno"], 2)).toEqual(["Ana", "Joana"]);
  });
});
