import type { Rsvp, ShowEvent, UserProfile, Venue } from "./schemas.js";

export const DEFAULT_TZ = "America/Sao_Paulo";
const DEFAULT_DURATION_MIN = 180;

export type CalendarListItem = { id: string; name: string; primary?: boolean; accessRole?: string };

/** Port to the calendar provider (Google Calendar). */
export interface CalendarGateway {
  listCalendars(user: UserProfile): Promise<CalendarListItem[]>;
  createCalendar(user: UserProfile, name: string, timeZone: string): Promise<CalendarListItem>;
  /** Insert or update; returns the provider event id. */
  upsertEvent(user: UserProfile, calendarId: string, existingEventId: string | undefined, body: CalendarEventBody): Promise<string>;
  deleteEvent(user: UserProfile, calendarId: string, eventId: string): Promise<void>;
}

export type CalendarEventBody = {
  summary: string;
  location?: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  reminders: { useDefault: false; overrides: Array<{ method: "popup"; minutes: number }> };
  extendedProperties?: { private: Record<string, string> };
  source?: { title: string; url: string };
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Add minutes to a local wall-clock date/time without touching time zones. */
export function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi + minutes));
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
  };
}

export function addDays(date: string, days: number): string {
  return addMinutes(date, "00:00", days * 1440).date;
}

/** Minutes since midnight of the event's start (start, else doors), or undefined for all-day. */
export function eventStartMinutes(e: ShowEvent): number | undefined {
  const t = e.startTime ?? e.doorsTime;
  if (!t) return undefined;
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function eventEndMinutes(e: ShowEvent): number | undefined {
  const s = eventStartMinutes(e);
  if (s === undefined) return undefined;
  if (e.endTime) {
    const [h, m] = e.endTime.split(":").map(Number) as [number, number];
    let end = h * 60 + m;
    if (end <= s) end += 1440;
    return end;
  }
  return s + DEFAULT_DURATION_MIN;
}

export function venueLocation(v?: Venue): string | undefined {
  if (!v) return undefined;
  const parts = [v.name, v.address, [v.city, v.state].filter(Boolean).join(" - ") || undefined].filter(Boolean);
  return parts.join(", ");
}

const money = (n: number, cur: string) => `${cur} ${n.toFixed(2)}`;

export function buildDescription(e: ShowEvent, r: Rsvp, v?: Venue, appUrl?: string): string {
  const lines: string[] = [];
  if (e.doorsTime) lines.push(`Doors: ${e.doorsTime}`);
  if (e.startTime) lines.push(`Show: ${e.startTime}`);
  if (e.lineup?.length) {
    lines.push("", "Lineup:");
    for (const a of e.lineup) lines.push(`- ${a.name}${a.role && a.role !== "headliner" ? ` (${a.role})` : ""}${a.startTime ? ` ${a.startTime}` : ""}`);
  }
  const cur = e.currency ?? "BRL";
  const tier = e.tiers?.find((t) => t.name === r.tierName);
  if (r.tierName || r.pricePaid !== undefined) {
    lines.push("");
    lines.push(`Ticket: ${r.tierName ?? "-"}${r.quantity ? ` x${r.quantity}` : ""}`);
    if (r.pricePaid !== undefined) lines.push(`Paid: ${money(r.pricePaid, tier?.currency ?? cur)}${r.feesPaid !== undefined ? ` + fees ${money(r.feesPaid, tier?.currency ?? cur)}` : ""}`);
  }
  if (r.companions?.length) lines.push(`Going with: ${r.companions.join(", ")}`);
  if (v?.mapsUrl) lines.push("", `Map: ${v.mapsUrl}`);
  if (e.ticketUrl) lines.push(`Tickets: ${e.ticketUrl}`);
  if (r.notes) lines.push("", r.notes);
  if (appUrl) lines.push("", `Show Manager: ${appUrl}`);
  return lines.join("\n").trim();
}

/** Build the Google Calendar event body for a going/attended RSVP. */
export function buildCalendarEvent(e: ShowEvent, r: Rsvp, v: Venue | undefined, ownerId: string, appUrl?: string): CalendarEventBody {
  const tz = v?.timezone ?? DEFAULT_TZ;
  const startMin = eventStartMinutes(e);
  const endMin = eventEndMinutes(e);
  let start: CalendarEventBody["start"];
  let end: CalendarEventBody["end"];
  if (startMin === undefined || endMin === undefined) {
    start = { date: e.date };
    end = { date: addDays(e.date, 1) }; // all-day end date is exclusive
  } else {
    const s = addMinutes(e.date, "00:00", startMin);
    const en = addMinutes(e.date, "00:00", endMin);
    start = { dateTime: `${s.date}T${s.time}:00`, timeZone: tz };
    end = { dateTime: `${en.date}T${en.time}:00`, timeZone: tz };
  }
  return {
    summary: e.title,
    location: venueLocation(v),
    description: buildDescription(e, r, v, appUrl),
    start,
    end,
    // One day before, as a popup.
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] },
    extendedProperties: { private: { showManagerEventId: e.id, showManagerOwner: ownerId } },
    ...(e.ticketUrl ? { source: { title: "Tickets", url: e.ticketUrl } } : {}),
  };
}

/** True when this RSVP status should have a calendar entry. */
export const syncsToCalendar = (status: Rsvp["status"]) => status === "going" || status === "attended";
