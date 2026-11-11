import type { EventView } from "./types";

/** The act that people went to see: the headliner, else the first act on the bill, else the event title. */
export function headliner(e: Pick<EventView, "title" | "lineup">): string {
  const acts = e.lineup ?? [];
  return (acts.find((a) => a.role === "headliner") ?? acts[0])?.name ?? e.title;
}

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

export type Ranked = { name: string; count: number };

/** Count by a display name, case- and accent-insensitively ("Sepultura" and "sepultura" are one); the first spelling seen is shown. */
function rank(names: string[]): Ranked[] {
  const m = new Map<string, Ranked>();
  for (const n of names) {
    const k = fold(n);
    const r = m.get(k);
    if (r) r.count++; else m.set(k, { name: n, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type YearCount = { year: number; count: number };
export type History = {
  total: number;
  /** Every year from the first show to the last, including quiet years with 0, oldest first. */
  years: YearCount[];
  venues: number;
  artists: number;
  /** Money paid per currency (ticket + fees). */
  spent: Record<string, number>;
  topArtists: Ranked[];
  topVenues: Ranked[];
};

export function summarize(events: EventView[]): History {
  const perYear = new Map<number, number>();
  const spent: Record<string, number> = {};
  for (const e of events) {
    const y = Number(e.date.slice(0, 4));
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
    const paid = (e.rsvp?.pricePaid ?? 0) + (e.rsvp?.feesPaid ?? 0);
    if (paid > 0) { const c = e.currency ?? "BRL"; spent[c] = (spent[c] ?? 0) + paid; }
  }
  const ys = [...perYear.keys()];
  const years: YearCount[] = [];
  if (ys.length) for (let y = Math.min(...ys); y <= Math.max(...ys); y++) years.push({ year: y, count: perYear.get(y) ?? 0 });
  const artists = rank(events.map(headliner));
  const venues = rank(events.flatMap((e) => (e.venue ? [e.venue.name] : [])));
  return { total: events.length, years, venues: venues.length, artists: artists.length, spent, topArtists: artists.slice(0, 5), topVenues: venues.slice(0, 5) };
}

/** Free-text match over what a person would search: title, every act, venue, city and genre. */
export function matches(e: EventView, text: string): boolean {
  const needle = fold(text);
  if (!needle) return true;
  const hay = fold([e.title, e.genre, e.venue?.name, e.venue?.city, ...(e.lineup ?? []).map((a) => a.name)].filter(Boolean).join(" "));
  return hay.includes(needle);
}

/** Newest first, grouped by year. */
export function groupByYear(events: EventView[]): Array<{ year: number; events: EventView[] }> {
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date));
  const groups: Array<{ year: number; events: EventView[] }> = [];
  for (const e of sorted) {
    const y = Number(e.date.slice(0, 4));
    const g = groups[groups.length - 1];
    if (g && g.year === y) g.events.push(e); else groups.push({ year: y, events: [e] });
  }
  return groups;
}

// ---------------------------------------------------------------- who I went with
/** Filter value for "no one listed under Going with". */
export const ALONE = "\u0000alone";

export const personKey = (name: string) => fold(name).replace(/\s+/g, " ");

/** The people on an RSVP's "Going with" list: trimmed, de-duplicated ("Ana" and "ana " are one person), first spelling kept. */
export function companionsOf(e: Pick<EventView, "rsvp">): Array<{ key: string; name: string }> {
  const seen = new Map<string, string>();
  for (const raw of e.rsvp?.companions ?? []) {
    const name = raw.trim().replace(/\s+/g, " ");
    const key = personKey(name);
    if (key && !seen.has(key)) seen.set(key, name);
  }
  return [...seen].map(([key, name]) => ({ key, name }));
}

export type Person = { key: string; name: string; count: number };

/** Everyone you went with, most shows first. Shown with the spelling you used most ("Ana" over "ana"), capitalised ones winning ties. */
export function peopleOf(events: EventView[]): Person[] {
  const m = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const e of events) for (const c of companionsOf(e)) {
    const p = m.get(c.key) ?? { count: 0, spellings: new Map() };
    p.count++; p.spellings.set(c.name, (p.spellings.get(c.name) ?? 0) + 1);
    m.set(c.key, p);
  }
  const upper = (n: string) => (n[0] === n[0]!.toUpperCase() && n[0] !== n[0]!.toLowerCase() ? 1 : 0);
  return [...m].map(([key, p]) => ({
    key, count: p.count,
    name: [...p.spellings].sort((a, b) => b[1] - a[1] || upper(b[0]) - upper(a[0]) || a[0].localeCompare(b[0]))[0]![0],
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** `who` is a person key, ALONE, or undefined for everyone. */
export function withWho(e: Pick<EventView, "rsvp">, who?: string): boolean {
  if (!who) return true;
  const c = companionsOf(e);
  return who === ALONE ? c.length === 0 : c.some((x) => x.key === who);
}

/** A stable hue per person, so Ana is the same colour everywhere and between visits. */
export function personHue(key: string): number {
  let h = 7;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** The day one year before `now` (YYYY-MM-DD, local time): "the last 12 months" starts here. */
export function lastYearStart(now = new Date()): string {
  const d = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
