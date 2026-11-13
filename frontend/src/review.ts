import type { ReviewData, ReviewPhoto, ReviewShow } from "./types";

/** A photo in a slide, with a short caption such as "Slayer · Mar". */
export type Pic = ReviewPhoto & { label: string };
export type Count = { name: string; count: number };

/** One screen of the story. Every slide is optional except the first and the last: a slide appears only when there is enough to say. */
export type Slide =
  | { kind: "intro"; range: string; count: number; every?: number; venues: number; cities: number; people: string[]; owner?: string }
  | { kind: "months"; best: string; count: number; byMonth: number[] }
  | { kind: "collage"; pics: Pic[]; more: number }
  | { kind: "artists"; top: Count[]; pic?: Pic }
  | { kind: "genres"; top: Count[] }
  | { kind: "venue"; name: string; count: number; withCompany: number; pic?: Pic }
  | { kind: "people"; top: Count[] }
  | { kind: "best"; title: string; score: number; when: string; venue?: string; pics: Pic[] }
  | { kind: "song"; name: string; count: number }
  | { kind: "gallery"; pics: Pic[] }
  | { kind: "bookends"; first: { title: string; when: string }; last: { title: string; when: string } }
  | { kind: "outro"; range: string; count: number; photos: number };

export const COLLAGE_MAX = 4;
export const GALLERY_MIN = 5;
export const GALLERY_MAX = 12;
export const BEST_MAX = 8;

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).format(utc(date));
export const shortDate = (d: string) => fmt(d, { month: "short", day: "numeric" });
export const longDate = (d: string) => fmt(d, { month: "long", day: "numeric", year: "numeric" });
const monthShort = (d: string) => fmt(d, { month: "short" });
const dayDiff = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);

/** The act people went to see: the headliner, else the first act, else the show's title. */
export function headlinerOf(s: Pick<ReviewShow, "title" | "lineup">): string {
  return (s.lineup.find((a) => a.role === "headliner") ?? s.lineup[0])?.name ?? s.title;
}

/** Count names case- and accent-insensitively, first spelling kept, most first (ties alphabetical). */
function rank(names: string[]): Count[] {
  const m = new Map<string, Count>();
  for (const n of names) {
    const k = fold(n);
    const r = m.get(k);
    if (r) r.count++; else m.set(k, { name: n, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** "2026" for a whole calendar year, otherwise "Mar 5 – Sep 14, 2026" style. */
export function rangeLabel(from: string, to: string): string {
  if (from.slice(0, 4) === to.slice(0, 4) && from.slice(5) === "01-01" && to.slice(5) === "12-31") return from.slice(0, 4);
  const y = (d: string) => d.slice(0, 4);
  return y(from) === y(to) ? `${shortDate(from)} – ${shortDate(to)}, ${y(to)}` : `${shortDate(from)}, ${y(from)} – ${shortDate(to)}, ${y(to)}`;
}

const picsOf = (s: ReviewShow): Pic[] => s.photos.map((p) => ({ ...p, label: `${headlinerOf(s)} · ${monthShort(s.date)}` }));

/** Up to `n` photos spread evenly through the list (so a deck does not show only the first show's pictures). */
function spread<T>(all: T[], n: number): T[] {
  if (all.length <= n) return all;
  return Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]!);
}

/**
 * Turns a review into the slides to show. Pure and deterministic: the same shows always give the same deck.
 * Each slide has a rule; one that does not have enough to say is left out (3 shows make a short deck, 30 a long one).
 * `today` caps "one show every N days" so a range that reaches into the future does not stretch it.
 */
export function buildDeck(data: ReviewData, today: string = new Date().toISOString().slice(0, 10)): Slide[] {
  const shows = data.shows;
  if (!shows.length) return [];
  const { from, to } = data.recipe;
  const range = rangeLabel(from, to);
  const names = data.recipe.people ?? [];
  const slides: Slide[] = [];

  const cities = new Set(shows.map((s) => fold(s.venue?.city ?? "")).filter(Boolean));
  const venues = new Set(shows.map((s) => fold(s.venue?.name ?? "")).filter(Boolean));
  const days = dayDiff(from, to < today ? to : today < from ? from : today) + 1;
  slides.push({
    kind: "intro", range, count: shows.length, venues: venues.size, cities: cities.size, people: names, ...(data.owner ? { owner: data.owner } : {}),
    ...(shows.length >= 2 && days >= shows.length ? { every: Math.round(days / shows.length) } : {}),
  });

  // Busiest month: needs a few shows and a clear winner (a three-way tie says nothing).
  if (shows.length >= 3) {
    const by = Array<number>(12).fill(0);
    for (const s of shows) by[Number(s.date.slice(5, 7)) - 1]!++;
    const max = Math.max(...by);
    if (by.filter((n) => n === max).length === 1 && max >= 2) {
      const i = by.indexOf(max);
      slides.push({ kind: "months", best: fmt(`2000-${String(i + 1).padStart(2, "0")}-01`, { month: "long" }), count: max, byMonth: by });
    }
  }

  const allPics = shows.flatMap(picsOf);
  if (allPics.length >= 3) {
    const pics = spread(allPics, COLLAGE_MAX);
    slides.push({ kind: "collage", pics, more: allPics.length - pics.length });
  }

  const artists = rank(shows.map(headlinerOf)).filter((a) => a.count >= 2).slice(0, 3);
  if (artists.length) {
    const top = fold(artists[0]!.name);
    const pic = shows.filter((s) => fold(headlinerOf(s)) === top).flatMap(picsOf)[0];
    slides.push({ kind: "artists", top: artists, ...(pic ? { pic } : {}) });
  }

  const genres = rank(shows.map((s) => s.genre ?? "").filter(Boolean));
  if (genres.length >= 2) slides.push({ kind: "genres", top: genres.slice(0, 3) });

  if (shows.length >= 3) {
    const byVenue = new Map<string, { name: string; shows: ReviewShow[] }>();
    for (const s of shows) {
      if (!s.venue) continue;
      const k = fold(s.venue.name);
      byVenue.set(k, { name: s.venue.name, shows: [...(byVenue.get(k)?.shows ?? []), s] });
    }
    const top = [...byVenue.values()].sort((a, b) => b.shows.length - a.shows.length || a.name.localeCompare(b.name))[0];
    if (top && top.shows.length >= 2) {
      const pic = top.shows.flatMap(picsOf)[0];
      slides.push({ kind: "venue", name: top.name, count: top.shows.length, withCompany: top.shows.filter((s) => s.companionCount > 0).length, ...(pic ? { pic } : {}) });
    }
  }

  // "Your crew" only when names are visible and the review is not already about specific people.
  if (!names.length) {
    const crew = rank(shows.flatMap((s) => s.companions)).slice(0, 3);
    if (crew.length) slides.push({ kind: "people", top: crew });
  }

  if (shows.length >= 2) {
    const scored = shows.filter((s) => s.score !== undefined);
    if (scored.length) {
      const best = [...scored].sort((a, b) => b.score! - a.score! || b.photos.length - a.photos.length || b.date.localeCompare(a.date))[0]!;
      slides.push({ kind: "best", title: headlinerOf(best), score: best.score!, when: longDate(best.date), ...(best.venue ? { venue: best.venue.name } : {}), pics: picsOf(best).slice(0, BEST_MAX) });
    }
  }

  // Most-heard song: once per show, at least twice.
  const songs = rank(shows.flatMap((s) => [...new Map(s.songs.map((n) => [fold(n), n])).values()]));
  if (songs[0] && songs[0].count >= 2) slides.push({ kind: "song", name: songs[0].name, count: songs[0].count });

  if (allPics.length >= GALLERY_MIN) slides.push({ kind: "gallery", pics: spread(allPics, GALLERY_MAX) });

  if (shows.length >= 2) {
    const first = shows[0]!, last = shows[shows.length - 1]!;
    slides.push({ kind: "bookends", first: { title: headlinerOf(first), when: longDate(first.date) }, last: { title: headlinerOf(last), when: longDate(last.date) } });
  }

  slides.push({ kind: "outro", range, count: shows.length, photos: allPics.length });
  return slides;
}

/** How long a slide stays before moving on, and how long each photo of a slideshow stays. */
export const SLIDE_MS = 6000;
export const PHOTO_MS = 3000;
export function slideDuration(s: Slide): number {
  return (s.kind === "best" || s.kind === "gallery") && s.pics.length > 1 ? s.pics.length * PHOTO_MS : SLIDE_MS;
}
