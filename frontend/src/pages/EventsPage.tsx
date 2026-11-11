import { venueNames } from "../history";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { op } from "../api";
import { EventCard } from "../components/EventCard";
import { EventDrawer } from "../components/EventDrawer";
import { GenreChips, type GenreOption } from "../components/GenreChips";
import { dateLabel, genreHue, isNewEvent, monthKey, monthLabel, NEW_WINDOW_DAYS } from "../format";
import type { EventView, VenueRow } from "../types";

export type Tab = "undecided" | "going" | "interested" | "past" | "all";
type Status = "going" | "interested" | "skipped";
// `color` is the tab's status colour (the same ones the cards' RSVP badges use); All stays neutral.
const TABS: Array<{ id: Tab; label: string; color?: string }> = [
  { id: "undecided", label: "To decide", color: "var(--accent)" }, { id: "going", label: "Going", color: "var(--going)" },
  { id: "interested", label: "Interested", color: "var(--interested)" }, { id: "past", label: "Past", color: "var(--skipped)" }, { id: "all", label: "All" },
];

/** One RSVP change made on a card, or its undo. `from` / `to` are the RSVP status before and after (null = undecided). */
export type Decision = { event: EventView; from: string | null; to: string | null; undo: boolean };

/**
 * Settings for running this page inside Claude as an MCP App: no add/edit drawer (the page is a triage view), filters
 * chosen by the tool call, NEW judged against the call's `newSince`, and every RSVP change reported through `onDecision`.
 */
export type Embed = {
  newSince?: number;
  initial?: { tab?: Tab; genre?: string; venueId?: string; text?: string };
  onDecision?: (d: Decision) => void;
  openLink?: (url: string) => void;
};

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function EventsPage({ events, venues, reload, error, loading, embed }: {
  events: EventView[]; venues: VenueRow[]; reload: () => void | Promise<void>; error?: string; loading: boolean; embed?: Embed;
}) {
  const [tab, setTab] = useState<Tab>(embed?.initial?.tab ?? "undecided");
  const [q, setQ] = useState(embed?.initial?.text ?? "");
  const [venueId, setVenueId] = useState(embed?.initial?.venueId ?? "");
  const [open, setOpen] = useState<string | "new" | undefined>();
  const [quickError, setQuickError] = useState<string>();
  const [onlyNew, setOnlyNew] = useState(false);
  const [genres, setGenres] = useState<Set<string>>(() => new Set(embed?.initial?.genre ? [norm(embed.initial.genre.trim())] : []));
  const [notice, setNotice] = useState<string>();
  const [last, setLast] = useState<{ event: EventView; from: Status | null; to: Status }>(); // the one RSVP change Undo can take back
  const busy = useRef(false);
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
      if (needle && !norm([e.title, e.genre, ...venueNames(e.venue), e.venue?.city, ...(e.lineup ?? []).map((a) => a.name)].filter(Boolean).join(" ")).includes(needle)) return false;
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
  const fresh = (createdAt: string) => embed?.newSince !== undefined ? Date.parse(createdAt) >= embed.newSince : isNewEvent(createdAt, nowMs);
  const added = useMemo(() => shown.filter((e) => fresh(e.createdAt)), [shown, nowMs, embed?.newSince]); // eslint-disable-line react-hooks/exhaustive-deps
  const rest = useMemo(() => shown.filter((e) => !fresh(e.createdAt)), [shown, nowMs, embed?.newSince]); // eslint-disable-line react-hooks/exhaustive-deps
  // "this week" for the default 7-day window; an explicit newSince (from the tool call) is named by its date.
  const weekWindow = embed?.newSince === undefined || Math.abs(nowMs - embed.newSince - NEW_WINDOW_DAYS * 86_400_000) < 86_400_000;
  const sinceText = weekWindow ? "this week" : `since ${dateLabel(new Date(embed!.newSince!).toISOString().slice(0, 10), { month: "short", day: "numeric" })}`;

  const groups = useMemo(() => {
    const m = new Map<string, EventView[]>();
    for (const e of rest) m.set(monthKey(e.date), [...(m.get(monthKey(e.date)) ?? []), e]);
    return [...m.entries()];
  }, [rest]);

  async function quick(e: EventView, status: Status) {
    if (busy.current) return;
    busy.current = true;
    setQuickError(undefined); setNotice(undefined);
    const from = (e.rsvp?.status as Status | undefined) ?? null;
    try {
      const r = await op<{ warnings: string[] }>("set_rsvp", { eventId: e.id, status });
      if (r.warnings.length) {
        // A sandboxed iframe cannot alert(); show the overlap warning inline instead.
        if (embed) setNotice(r.warnings.join(" ")); else alert(r.warnings.join("\n"));
      }
      await reload();
      if (embed) { setLast({ event: e, from, to: status }); embed.onDecision?.({ event: e, from, to: status, undo: false }); }
    } catch (err) { setQuickError((err as Error).message); } finally { busy.current = false; }
  }

  /** Put the last RSVP change back: its previous status, or no RSVP at all if there was none. */
  async function undo() {
    if (!last || busy.current) return;
    busy.current = true;
    setQuickError(undefined); setNotice(undefined);
    try {
      if (last.from) await op("set_rsvp", { eventId: last.event.id, status: last.from });
      else await op("remove_rsvp", { eventId: last.event.id });
      await reload();
      embed?.onDecision?.({ event: last.event, from: last.to, to: last.from, undo: true });
      setLast(undefined);
    } catch (err) { setQuickError((err as Error).message); } finally { busy.current = false; }
  }

  // On the web the card opens the details drawer; inside Claude it opens the show's ticket / source page, when it has one.
  const openProps = (e: EventView) => {
    if (!embed) return { onOpen: () => setOpen(e.id) };
    const url = e.ticketUrl ?? e.sourceUrl;
    return url && embed.openLink ? { onOpen: () => embed.openLink!(url), openLabel: "Open the ticket page" } : {};
  };

  return (
    <div className={embed ? "embedded" : undefined}>
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
        {!embed && <button className="btn primary fb-add" onClick={() => setOpen("new")}>+ Add event</button>}
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
      {notice && <p role="status" className="notice">{notice}</p>}
      {last && (
        <div role="status" className="undobar">
          <span>{last.to === "going" ? "Going" : last.to === "interested" ? "Interested" : "Skipped"}: <strong>{last.event.title}</strong></span>
          <button className="btn small" onClick={() => void undo()}>Undo</button>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setLast(undefined)}>×</button>
        </div>
      )}
      {loading && !events.length && <p className="muted">Loading shows…</p>}
      {!loading && !(onlyNew ? added : shown).length && (
        <div className="empty">
          {onlyNew ? (
            <>
              <p><strong>Nothing was added {weekWindow ? "in the last 7 days" : sinceText} here.</strong></p>
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
            <h2 id="added-h">✦ Added {sinceText} · {added.length}</h2>
            <button className="link" aria-pressed={onlyNew} onClick={() => setOnlyNew((v) => !v)}>{onlyNew ? "Show all" : "Show only new"}</button>
          </div>
          <ul className="cards">
            {added.map((e) => <EventCard key={e.id} event={e} isNew now={nowMs} {...openProps(e)} onQuick={(s) => quick(e, s)} />)}
          </ul>
        </section>
      )}

      {!onlyNew && groups.map(([key, list]) => (
        <section key={key} aria-labelledby={`m-${key}`}>
          <h2 className="month" id={`m-${key}`}>{monthLabel(key)}</h2>
          <ul className="cards">
            {list.map((e) => <EventCard key={e.id} event={e} {...openProps(e)} onQuick={(s) => quick(e, s)} />)}
          </ul>
        </section>
      ))}

      {!embed && open && (
        <EventDrawer
          key={open}
          eventId={open === "new" ? undefined : open}
          initial={open === "new" ? undefined : events.find((e) => e.id === open)}
          venues={venues}
          onClose={() => setOpen(undefined)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
