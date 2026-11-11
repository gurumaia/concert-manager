import type { EventView, Tier } from "./types";

export const money = (n: number, currency = "BRL") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

/** "Wed, Nov 11" from YYYY-MM-DD, without time-zone drift. */
export function dateLabel(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const monthKey = (date: string) => date.slice(0, 7);
export const monthLabel = (key: string) => dateLabel(`${key}-01`, { month: "long", year: "numeric" });

export function timeLabel(e: Pick<EventView, "doorsTime" | "startTime">) {
  if (e.startTime && e.doorsTime) return `Doors ${e.doorsTime} · Show ${e.startTime}`;
  if (e.startTime) return `Show ${e.startTime}`;
  if (e.doorsTime) return `Doors ${e.doorsTime}`;
  return "Time TBA";
}

/** Cheapest tier with fee shown separately: "from R$ 300 + R$ 45 fee". */
export function priceLabel(e: Pick<EventView, "tiers" | "currency">) {
  const priced = (e.tiers ?? []).filter((t) => t.price !== undefined);
  if (!priced.length) return undefined;
  const cheapest = priced.reduce((a, b) => ((a.price ?? 0) <= (b.price ?? 0) ? a : b));
  return tierLabel(cheapest, e.currency, priced.length > 1 ? "from " : "");
}

export function tierLabel(t: Tier, eventCurrency = "BRL", prefix = "") {
  const cur = t.currency ?? eventCurrency;
  const base = `${prefix}${money(t.price ?? 0, cur)}`;
  return t.fee ? `${base} + ${money(t.fee, cur)} fee` : base;
}

export const statusLabel: Record<string, string> = {
  interested: "Interested",
  going: "Going",
  skipped: "Skipped",
  attended: "Attended",
};

export const saleLabel: Record<string, string> = {
  unknown: "Unknown",
  announced: "Announced",
  on_sale: "On sale",
  sold_out: "Sold out",
  cancelled: "Cancelled",
  postponed: "Postponed",
};

export const NEW_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Added within the last 7 days (rolling window, not calendar weeks). */
export function isNewEvent(createdAt: string | undefined, nowMs: number): boolean {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) && nowMs - t < NEW_WINDOW_DAYS * DAY_MS;
}

/** How long ago a show was added, by elapsed time: "just now", "5 hours ago", "3 days ago". */
export function addedLabel(createdAt: string, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - Date.parse(createdAt));
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  if (elapsed < 60 * 60 * 1000) return "just now";
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// Genre colours: related genres share a hue ("Thrash metal" and "Heavy metal" look alike); anything unknown gets a stable hue
// from its name, so a genre keeps its colour everywhere and between visits. First matching family wins, so "Blues rock" is a blues.
const GENRE_FAMILIES: Array<[RegExp, number]> = [
  [/metal|thrash|doom|grindcore|deathcore/, 355],
  [/punk|hardcore|emo|ska|hc\b/, 305],
  [/blues/, 215],
  [/jazz|soul|funk|r&b|rnb|motown/, 265],
  [/rock|grunge|alternative|indie|shoegaze/, 28],
  [/pop|k-?pop|disco/, 335],
  [/electronic|edm|techno|house|trance|dance|drum.?and.?bass/, 190],
  [/hip.?hop|rap|trap|r&b/, 48],
  [/classical|orchestr|opera|symphon|chamber/, 245],
  [/samba|pagode|mpb|bossa|forro|forró|axe|axé|sertanejo|baile|funk carioca|latin|reggaeton|salsa/, 95],
  [/folk|country|acoustic|bluegrass|singer/, 70],
  [/reggae|dub/, 140],
];

export function genreHue(genre: string): number {
  const g = genre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const [re, hue] of GENRE_FAMILIES) if (re.test(g)) return hue;
  let h = 0;
  for (const ch of g.trim()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
