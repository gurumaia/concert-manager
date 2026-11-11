import { useMemo, useState, type CSSProperties } from "react";
import { op } from "../api";
import { EventCard } from "../components/EventCard";
import { EventDrawer } from "../components/EventDrawer";
import { GenreChips, type GenreOption } from "../components/GenreChips";
import { genreHue, isNewEvent, monthKey, monthLabel } from "../format";
import type { EventView, VenueRow } from "../types";

type Tab = "undecided" | "going" | "interested" | "past" | "all";
// `color` is the tab's status colour (the same ones the cards' RSVP badges use); All stays neutral.
const TABS: Array<{ id: Tab; label: string; color?: string }> = [
  { id: "undecided", label: "To decide", color: "var(--accent)" }, { id: "going", label: "Going", color: "var(--going)" },
  { id: "interested", label: "Interested", color: "var(--interested)" }, { id: "past", label: "Past", color: "var(--skipped)" }, { id: "all", label: "All" },
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
  const [onlyNew, setOnlyNew] = useState(false);
  const [genres, setGenres] = useState<Set<string>>(new Set());
  // One reference time per data load, so the 7-day window does not shift while you browse.
  const nowMs = useMemo(() => Date.now(), [events]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = new Date().toISOString().slice(0, 10);

  const counts = useMemo(() => ({
    undecided: events.filter((e) => !e.rsvp && e.date >= today).length,
    going: events.filter((e) => e.rsvp?.status === "going" && e.date >= today).length,
    interested: events.filter((e) => e.rsvp?.status === "interested" && e.date >= today).length,
    past: events.filter((e) => e.date < today).length,
    all: events.length,
  }), [events, today]);

  // Everything the tab, search and venue allow; the genre filter narrows it further, and its chips count from here.
  const inView = useMemo(() => {
    const needle = norm(q.trim());
    return events.filter((e) => {
      if (tab === "undecided" && (e.rsvp || e.date < today)) return false;
      if (tab === "going" && !(e.rsvp?.status === "going" && e.date >= today)) return false;
      if (tab === "interested" && !(e.rsvp?.status === "interested" && e.date >= today)) return false;
      if (tab === "past" && e.date >= today) return false;
      if (venueId && e.venueId !== venueId) return false;
      if (needle && !norm([e.title, e.genre, e.venue?.name, e.venue?.city, ...(e.lineup ?? []).map((a) => a.name)].filter(Boolean).join(" ")).includes(needle)) return false;
      return true;
    });
  }, [events, tab, q, venueId, today]);

  const genreOptions = useMemo<GenreOption[]>(() => {
    const all = new Map<string, { label: string; total: number; count: number }>();
    for (const e of events) {
      const label = e.genre?.trim();
      if (!label) continue;
      const g = all.get(norm(label)) ?? { label, total: 0, count: 0 };
      g.total++;
      all.set(norm(label), g);
    }
    for (const e of inView) {
      const k = e.genre?.trim() && norm(e.genre.trim());
      if (k && all.has(k)) all.get(k)!.count++;
    }
    // Ordered by how many shows have the genre overall, so the row does not reshuffle as you switch tabs.
    return [...all.entries()]
      .sort((a, b) => b[1].total - a[1].total || a[1].label.localeCompare(b[1].label))
      .map(([key, g]) => ({ key, label: g.label, hue: genreHue(g.label), count: g.count }));
  }, [events, inView]);

  const shown = useMemo(() => {
    const list = genres.size ? inView.filter((e) => e.genre?.trim() && genres.has(norm(e.genre.trim()))) : inView;
    return tab === "past" ? [...list].reverse() : list;
  }, [inView, genres, tab]);

  // Shows added in the last 7 days are lifted out of the month groups into a section of their own at the top.
  const added = useMemo(() => shown.filter((e) => isNewEvent(e.createdAt, nowMs)), [shown, nowMs]);
  const rest = useMemo(() => shown.filter((e) => !isNewEvent(e.createdAt, nowMs)), [shown, nowMs]);

  const groups = useMemo(() => {
    const m = new Map<string, EventView[]>();
    for (const e of rest) m.set(monthKey(e.date), [...(m.get(monthKey(e.date)) ?? []), e]);
    return [...m.entries()];
  }, [rest]);

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
      <div className="filterbar">
        <div className="tabs" role="tablist" aria-label="Filter shows" style={{ gridArea: "tabs" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`${tab === t.id ? "on" : ""}${t.color ? "" : " neutral"}`}
              style={t.color ? ({ "--c": t.color } as CSSProperties) : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.color && <span className="dot" aria-hidden="true" />}
              {t.label}<span className="count">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <button className="btn primary fb-add" onClick={() => setOpen("new")}>+ Add event</button>
        <input className="fb-search" type="search" aria-label="Search shows" placeholder="Search artist, venue, city…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="fb-venue" aria-label="Filter by venue" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
          <option value="">All venues</option>
          {venues.filter((v) => v.eventCount > 0).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <div style={{ gridArea: "chips", minWidth: 0 }}>
          <GenreChips
            genres={genreOptions}
            selected={genres}
            onToggle={(k) => setGenres((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
            onClear={() => setGenres(new Set())}
          />
        </div>
      </div>

      {(error || quickError) && <p role="alert" className="error">{error ?? quickError}</p>}
      {loading && !events.length && <p className="muted">Loading shows…</p>}
      {!loading && !(onlyNew ? added : shown).length && (
        <div className="empty">
          {onlyNew ? (
            <>
              <p><strong>Nothing was added in the last 7 days here.</strong></p>
              <p className="muted">This only looks at the tab, search and venue you have selected.</p>
              <button className="btn" onClick={() => setOnlyNew(false)}>Show all shows</button>
            </>
          ) : (
            <>
              <p><strong>{events.length ? "Nothing matches here." : "No shows yet."}</strong></p>
              <p className="muted">{events.length ? "Try another tab, or clear the search and genre filters." : "Ask Claude to find concerts and add them with Show Manager, or add one yourself."}</p>
              {genres.size > 0 && <button className="btn" onClick={() => setGenres(new Set())}>Clear genre filter</button>}
            </>
          )}
        </div>
      )}

      {added.length > 0 && (
        <section aria-labelledby="added-h">
          <div className="sect">
            <h2 id="added-h">✦ Added this week · {added.length}</h2>
            <button className="link" aria-pressed={onlyNew} onClick={() => setOnlyNew((v) => !v)}>{onlyNew ? "Show all" : "Show only new"}</button>
          </div>
          <ul className="cards">
            {added.map((e) => <EventCard key={e.id} event={e} isNew now={nowMs} onOpen={() => setOpen(e.id)} onQuick={(s) => quick(e, s)} />)}
          </ul>
        </section>
      )}

      {!onlyNew && groups.map(([key, list]) => (
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
