import { useMemo, useState } from "react";
import { op } from "../api";
import { EventCard } from "../components/EventCard";
import { EventDrawer } from "../components/EventDrawer";
import { monthKey, monthLabel } from "../format";
import type { EventView, VenueRow } from "../types";

type Tab = "undecided" | "going" | "interested" | "past" | "all";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "undecided", label: "To decide" }, { id: "going", label: "Going" }, { id: "interested", label: "Interested" },
  { id: "past", label: "Past" }, { id: "all", label: "All" },
];

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function EventsPage({ events, venues, reload, error, loading }: {
  events: EventView[]; venues: VenueRow[]; reload: () => void; error?: string; loading: boolean;
}) {
  const [tab, setTab] = useState<Tab>("undecided");
  const [q, setQ] = useState("");
  const [venueId, setVenueId] = useState("");
  const [open, setOpen] = useState<string | "new" | undefined>();
  const [quickError, setQuickError] = useState<string>();
  const today = new Date().toISOString().slice(0, 10);

  const counts = useMemo(() => ({
    undecided: events.filter((e) => !e.rsvp && e.date >= today).length,
    going: events.filter((e) => e.rsvp?.status === "going" && e.date >= today).length,
    interested: events.filter((e) => e.rsvp?.status === "interested" && e.date >= today).length,
    past: events.filter((e) => e.date < today).length,
    all: events.length,
  }), [events, today]);

  const shown = useMemo(() => {
    const needle = norm(q.trim());
    const list = events.filter((e) => {
      if (tab === "undecided" && (e.rsvp || e.date < today)) return false;
      if (tab === "going" && !(e.rsvp?.status === "going" && e.date >= today)) return false;
      if (tab === "interested" && !(e.rsvp?.status === "interested" && e.date >= today)) return false;
      if (tab === "past" && e.date >= today) return false;
      if (venueId && e.venueId !== venueId) return false;
      if (needle && !norm([e.title, e.genre, e.venue?.name, e.venue?.city, ...(e.lineup ?? []).map((a) => a.name)].filter(Boolean).join(" ")).includes(needle)) return false;
      return true;
    });
    return tab === "past" ? [...list].reverse() : list;
  }, [events, tab, q, venueId, today]);

  const groups = useMemo(() => {
    const m = new Map<string, EventView[]>();
    for (const e of shown) m.set(monthKey(e.date), [...(m.get(monthKey(e.date)) ?? []), e]);
    return [...m.entries()];
  }, [shown]);

  async function quick(e: EventView, status: "going" | "interested" | "skipped") {
    setQuickError(undefined);
    try {
      const r = await op<{ warnings: string[] }>("set_rsvp", { eventId: e.id, status });
      if (r.warnings.length) alert(r.warnings.join("\n"));
      reload();
    } catch (err) { setQuickError((err as Error).message); }
  }

  return (
    <>
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Filter shows">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}<span className="count">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <div className="filters">
          <input type="search" aria-label="Search shows" placeholder="Search artist, venue, city…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Filter by venue" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
            <option value="">All venues</option>
            {venues.filter((v) => v.eventCount > 0).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <button className="btn primary" onClick={() => setOpen("new")}>+ Add event</button>
        </div>
      </div>

      {(error || quickError) && <p role="alert" className="error">{error ?? quickError}</p>}
      {loading && !events.length && <p className="muted">Loading shows…</p>}
      {!loading && !shown.length && (
        <div className="empty">
          <p><strong>{events.length ? "Nothing matches here." : "No shows yet."}</strong></p>
          <p className="muted">{events.length ? "Try another tab or clear the search." : "Ask Claude to find concerts and add them with Show Manager, or add one yourself."}</p>
        </div>
      )}

      {groups.map(([key, list]) => (
        <section key={key} aria-labelledby={`m-${key}`}>
          <h2 className="month" id={`m-${key}`}>{monthLabel(key)}</h2>
          <ul className="cards">
            {list.map((e) => <EventCard key={e.id} event={e} onOpen={() => setOpen(e.id)} onQuick={(s) => quick(e, s)} />)}
          </ul>
        </section>
      ))}

      {open && (
        <EventDrawer
          key={open}
          eventId={open === "new" ? undefined : open}
          initial={open === "new" ? undefined : events.find((e) => e.id === open)}
          venues={venues}
          onClose={() => setOpen(undefined)}
          onChanged={reload}
        />
      )}
    </>
  );
}
