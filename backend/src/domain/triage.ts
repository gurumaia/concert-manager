import type { Rsvp, ShowEvent, Venue } from "./schemas.js";

/**
 * The triage view: the same tabs as the web app's Shows page. Pure (no I/O), so the text summary the model sees
 * and the numbers the UI shows come from one definition.
 */
export const TRIAGE_TABS = ["to_decide", "going", "interested", "past", "all"] as const;
export type TriageTab = (typeof TRIAGE_TABS)[number];

export type TriageEvent = ShowEvent & { venue: Venue | null; rsvp: Rsvp | null };
export type TriageFilters = { tab: TriageTab; newSince: string; genre?: string; venueId?: string; text?: string };
export type TriageCounts = Record<TriageTab, number>;

const DAY_MS = 24 * 3600_000;
/** The text result stays well under 2 KB whatever the data: we stop adding NEW lines at this many bytes. */
const TEXT_BUDGET_BYTES = 1700;

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Same rules as the Shows page: To decide = upcoming with no RSVP; Going / Interested = upcoming with that RSVP; Past = already
 * happened. An upcoming show that was skipped is only under All.
 */
export function inTab(e: TriageEvent, tab: TriageTab, today: string): boolean {
  if (tab === "all") return true;
  if (tab === "past") return e.date < today;
  if (e.date < today) return false;
  if (tab === "to_decide") return !e.rsvp;
  return e.rsvp?.status === (tab === "going" ? "going" : "interested");
}

export function matchesFilters(e: TriageEvent, f: Pick<TriageFilters, "genre" | "venueId" | "text">): boolean {
  if (f.venueId && e.venueId !== f.venueId) return false;
  if (f.genre && norm(e.genre?.trim() ?? "") !== norm(f.genre.trim())) return false;
  if (f.text) {
    const hay = norm([e.title, e.genre, e.venue?.name, e.venue?.city, ...(e.lineup ?? []).map((a) => a.name)].filter(Boolean).join(" "));
    if (!hay.includes(norm(f.text.trim()))) return false;
  }
  return true;
}

/** Added on or after `newSince` (ISO). An unparseable createdAt is never new. */
export function isNewSince(createdAt: string | undefined, newSince: string): boolean {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) && t >= Date.parse(newSince);
}

/** Default NEW window: the last 7 days, like the web app. */
export function defaultNewSince(now: Date): string {
  return new Date(now.getTime() - 7 * DAY_MS).toISOString();
}

export function countTabs(events: TriageEvent[], today: string): TriageCounts {
  const c: TriageCounts = { to_decide: 0, going: 0, interested: 0, past: 0, all: events.length };
  for (const e of events) {
    for (const t of ["to_decide", "going", "interested", "past"] as const) if (inTab(e, t, today)) c[t]++;
  }
  return c;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The short text the model gets: counts per tab, then one line per NEW event of the selected tab
 * (date · title · venue · id). Capped by size so it never grows with the data.
 */
export function triageText(events: TriageEvent[], f: TriageFilters, today: string): string {
  const matching = events.filter((e) => matchesFilters(e, f));
  const counts = countTabs(matching, today);
  const label: Record<TriageTab, string> = { to_decide: "to decide", going: "going", interested: "interested", past: "past", all: "all" };
  const head = `Show Manager triage. ${TRIAGE_TABS.map((t) => `${label[t]} ${counts[t]}`).join(" · ")}.`;
  const fresh = matching
    .filter((e) => inTab(e, f.tab, today) && isNewSince(e.createdAt, f.newSince))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const day = f.newSince.slice(0, 10);
  const title = fresh.length ? `New since ${day} in "${label[f.tab]}" (${fresh.length}):` : `Nothing new since ${day} in "${label[f.tab]}".`;
  const lines: string[] = [];
  let bytes = Buffer.byteLength(head) + Buffer.byteLength(title) + 200; // slack for the "+N more" line and newlines
  for (const e of fresh) {
    const line = `${e.date} · ${clip(e.title, 60)} · ${clip(e.venue?.name ?? "venue TBA", 40)} · ${e.id}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > TEXT_BUDGET_BYTES) break;
    lines.push(line);
  }
  const more = fresh.length - lines.length;
  return [head, title, ...lines, ...(more > 0 ? [`…and ${more} more.`] : [])].join("\n");
}
