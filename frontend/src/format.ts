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
