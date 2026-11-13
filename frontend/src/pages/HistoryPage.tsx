import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { op } from "../api";
import { EventDrawer } from "../components/EventDrawer";
import { Icon } from "../components/Icon";
import { loadAttended } from "../attended";
import { dateLabel, genreHue } from "../format";
import { ALONE, companionsOf, groupByYear, headliner, lastYearStart, matches, peopleOf, personHue, summarize, withWho, type Person, type Ranked } from "../history";
import type { EventView, VenueRow } from "../types";
import { useBlockStrayFileDrops, usePhotoDrop } from "../usePhotoDrop";

const NUDGE_DAYS = 14;
const NUDGE_KEY = "history-confirmed";
const confirmedIds = (): string[] => { try { return JSON.parse(localStorage.getItem(NUDGE_KEY) ?? "[]"); } catch { return []; } };

/** YYYY-MM-DD for `days` ago in the browser's own time zone. */
function daysAgo(days: number) {
  const d = new Date(Date.now() - days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const spentLabel = (spent: Record<string, number>) => {
  const parts = Object.entries(spent).map(([cur, n]) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n));
  return parts.length ? parts.join(" + ") : "–";
};

/** Every show you went to, newest first: an overview of the whole span, then a searchable ledger grouped by year. */
export function HistoryPage({ venues, reload }: { venues: VenueRow[]; reload: () => void | Promise<void> }) {
  useBlockStrayFileDrops();
  const [events, setEvents] = useState<EventView[]>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [year, setYear] = useState<number | "12m">();
  const [who, setWho] = useState<string>(); // a person key, ALONE, or everyone
  const [allPeople, setAllPeople] = useState(false);
  const [open, setOpen] = useState<EventView>();
  const [confirmed, setConfirmed] = useState<string[]>(confirmedIds);
  const [nudgeBusy, setNudgeBusy] = useState(false);

  const load = useCallback(async () => {
    try { setEvents(await loadAttended()); setError(undefined); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const all = events ?? [];
  const sum = useMemo(() => summarize(all), [events]); // eslint-disable-line react-hooks/exhaustive-deps
  const since = useMemo(() => lastYearStart(), []);
  const people = useMemo(() => peopleOf(all), [events]); // eslint-disable-line react-hooks/exhaustive-deps
  const inRange = (e: EventView) => (year === "12m" ? e.date >= since : !year || e.date.startsWith(String(year)));
  const shown = useMemo(() => all.filter((e) => inRange(e) && withWho(e, who) && matches(e, q)), [events, q, year, who]); // eslint-disable-line react-hooks/exhaustive-deps
  // With a person (or "Alone") chosen: how many shows that is, per year (the chart overlay) and over the last 12 months.
  const together = useMemo(() => {
    if (!who) return undefined;
    const byYear = new Map<number, number>();
    let total = 0, recent = 0;
    for (const e of all) if (withWho(e, who)) { total++; if (e.date >= since) recent++; const y = Number(e.date.slice(0, 4)); byYear.set(y, (byYear.get(y) ?? 0) + 1); }
    return { byYear, total, recent };
  }, [events, who, since]); // eslint-disable-line react-hooks/exhaustive-deps
  const whoName = who === ALONE ? "no one listed" : people.find((p) => p.key === who)?.name ?? "";
  const hue = who && who !== ALONE ? personHue(who) : undefined;
  const groups = useMemo(() => groupByYear(shown), [shown]);
  const max = Math.max(1, ...sum.years.map((y) => y.count));
  const filtered = !!q.trim() || !!year || !!who;
  const first = sum.years[0]?.year, last = sum.years[sum.years.length - 1]?.year;

  // Going to a show that has passed counts as having been there, so the last couple of weeks get a quick "did you really go?" check.
  const recent = useMemo(() => {
    const from = daysAgo(NUDGE_DAYS);
    return all.filter((e) => e.date >= from && !confirmed.includes(e.id)).sort((a, b) => b.date.localeCompare(a.date));
  }, [events, confirmed]); // eslint-disable-line react-hooks/exhaustive-deps

  async function didntGo(e: EventView) {
    setNudgeBusy(true);
    try { await op("set_rsvp", { eventId: e.id, status: "skipped" }); await load(); void reload(); } catch (err) { setError((err as Error).message); } finally { setNudgeBusy(false); }
  }
  function confirmAll() {
    const next = [...new Set([...confirmed, ...recent.map((e) => e.id)])];
    try { localStorage.setItem(NUDGE_KEY, JSON.stringify(next)); } catch { /* private mode: it just asks again */ }
    setConfirmed(next);
  }

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!events) return <p className="muted">Loading your history…</p>;

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Shows I've been to</h1>
          {sum.total > 0 && <p className="muted small hist-span">{first === last ? first : `${first} – ${last}`}</p>}
        </div>
      </div>

      {recent.length > 0 && (
        <section className="card hist-nudge" aria-label="Recent shows to confirm">
          <h2>Did you make these?</h2>
          <p className="muted small">A show you were going to counts as attended once its date passes. Tell me about any you missed.</p>
          <ul>
            {recent.map((e) => (
              <li key={e.id}>
                <span><b>{e.title}</b> <span className="muted small">· {dateLabel(e.date, { month: "short", day: "numeric" })}{e.venue ? ` · ${e.venue.name}` : ""}</span></span>
                <button className="btn small" disabled={nudgeBusy} onClick={() => void didntGo(e)} aria-label={`I didn't go to ${e.title}`}>Didn’t go</button>
              </li>
            ))}
          </ul>
          <button className="btn small ghost" onClick={confirmAll}>I went to all of these</button>
        </section>
      )}

      {sum.total === 0 ? (
        <div className="empty">
          <p><strong>No shows in your history yet.</strong></p>
          <p className="muted">Mark a show as Going. Once its date has passed it counts as attended and shows up here.</p>
        </div>
      ) : (
        <>
          <dl className="hist-stats">
            <Stat value={sum.total.toLocaleString("en")} label={sum.total === 1 ? "show" : "shows"} />
            <Stat value={String(sum.years.length)} label={sum.years.length === 1 ? "year" : "years"} />
            <Stat value={String(sum.artists)} label={sum.artists === 1 ? "artist" : "artists"} />
            <Stat value={String(sum.venues)} label={sum.venues === 1 ? "venue" : "venues"} />
            <Stat value={spentLabel(sum.spent)} label="spent" />
          </dl>

          {sum.years.length > 1 && (
            <section aria-label="Shows per year" style={hue !== undefined ? ({ "--who": `hsl(${hue} 60% 50%)` } as CSSProperties) : undefined}>
              <div className="hist-bars" role="group" aria-label="Shows per year. Choose a year to filter the list.">
                {sum.years.map((y) => {
                  const w = together?.byYear.get(y.year) ?? 0;
                  return (
                    <button key={y.year} className={`${year === y.year ? "on" : ""}${together ? " split" : ""}`} style={{ height: `${Math.max(4, (y.count / max) * 100)}%` }}
                      disabled={y.count === 0} aria-pressed={year === y.year}
                      aria-label={together ? `${y.year}: ${w} of ${y.count} ${y.count === 1 ? "show" : "shows"} with ${whoName}` : `${y.year}: ${y.count} ${y.count === 1 ? "show" : "shows"}`}
                      onClick={() => setYear(year === y.year ? undefined : y.year)}>
                      {together && w > 0 && <em style={{ height: `${(w / y.count) * 100}%` }} />}
                      {y.count > 0 && <span aria-hidden="true">{together && w > 0 ? `${w}/` : ""}{y.count}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="hist-axis" aria-hidden="true">{sum.years.map((y) => <span key={y.year}>{String(y.year).slice(2)}</span>)}</div>
              {together && (
                <p className="hist-legend small muted" aria-hidden="true">
                  <span><u className="mine" />{who === ALONE ? "no one listed" : `with ${whoName}`}</span><span><u />all other shows</span>
                </p>
              )}
            </section>
          )}

          <PeopleStrip people={people} who={who} onPick={(k) => setWho(who === k ? undefined : k)} all={allPeople} onToggleAll={() => setAllPeople(!allPeople)} total={sum.total} alone={all.filter((e) => withWho(e, ALONE)).length} />
          {together && (
            <dl className="hist-stats hist-together" aria-live="polite">
              <div><dd style={hue !== undefined ? { color: `hsl(${hue} 60% 50%)` } : undefined}>{together.total}</dd><dt>{who === ALONE ? "with no one listed" : `with ${whoName}`}</dt></div>
              <div><dd>{together.recent}</dd><dt>in the last 12 months</dt></div>
              <div><dd>{Math.round((together.total / sum.total) * 100)}%</dd><dt>of all your shows</dt></div>
            </dl>
          )}

          <div className="hist-two">
            <TopList title="Most seen" items={sum.topArtists} onPick={(n) => setQ(n)} />
            <TopList title="Favourite venues" items={sum.topVenues} onPick={(n) => setQ(n)} />
          </div>

          <div className="filters hist-filters">
            <input type="search" placeholder="Search artist, venue or city…" aria-label="Search your history" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Year" value={String(year ?? "")} onChange={(e) => setYear(e.target.value === "12m" ? "12m" : e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">All years</option>
              <option value="12m">Last 12 months</option>
              {[...sum.years].reverse().filter((y) => y.count > 0).map((y) => <option key={y.year} value={y.year}>{y.year}</option>)}
            </select>
            {filtered && <button className="btn small ghost" onClick={() => { setQ(""); setYear(undefined); setWho(undefined); }}>Clear filters</button>}
          </div>
          {filtered && <p className="muted small" aria-live="polite">{shown.length === 1 ? "1 show" : `${shown.length} shows`} match</p>}

          {groups.length === 0 ? (
            <div className="empty"><p><strong>No shows match.</strong></p><p className="muted">Try a different name or clear the filters.</p></div>
          ) : (
            <div className="hist-layout">
              <YearRail groups={groups} />
              <div>
                {groups.map((g) => (
                  <section key={g.year} id={`year-${g.year}`} className="hist-section" aria-labelledby={`hy-${g.year}`}>
                    <div className="hist-year">
                      <h2 id={`hy-${g.year}`}>{g.year}</h2>
                      <span className="muted small">{g.events.length === 1 ? "1 show" : `${g.events.length} shows`}</span>
                    </div>
                    <ul className="hist-list">
                      {g.events.map((e) => <Row key={e.id} event={e} onOpen={() => setOpen(e)} onPhotosChanged={() => { void load(); void reload(); }} />)}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {open && (
        <EventDrawer eventId={open.id} initial={open} venues={venues} onClose={() => setOpen(undefined)} onChanged={() => { void load(); void reload(); }} />
      )}
    </>
  );
}

/** Years down the left with their show counts: click to jump, the one you are reading is highlighted. Hidden on phones (the Year menu covers it). */
function YearRail({ groups }: { groups: Array<{ year: number; events: EventView[] }> }) {
  const [active, setActive] = useState<number>();
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<number, boolean>();
    // The year being read is the topmost section that reaches the upper part of the screen.
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) seen.set(Number(en.target.id.replace("year-", "")), en.isIntersecting);
      const top = groups.find((g) => seen.get(g.year));
      if (top) setActive(top.year);
    }, { rootMargin: "-90px 0px -60% 0px" });
    groups.forEach((g) => { const el = document.getElementById(`year-${g.year}`); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [groups]);
  return (
    <nav className="hist-rail" aria-label="Jump to year">
      {groups.map((g) => (
        <a key={g.year} href={`#year-${g.year}`} aria-current={active === g.year ? "true" : undefined}
          onClick={(e) => { e.preventDefault(); document.getElementById(`year-${g.year}`)?.scrollIntoView({ block: "start" }); setActive(g.year); }}>
          {g.year}<i>{g.events.length}</i>
        </a>
      ))}
    </nav>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div><dd>{value}</dd><dt>{label}</dt></div>;
}

function TopList({ title, items, onPick }: { title: string; items: Ranked[]; onPick: (name: string) => void }) {
  const top = items[0]?.count ?? 1;
  return (
    <section className="card hist-top">
      <h2>{title}</h2>
      <ol>
        {items.map((r) => (
          <li key={r.name}>
            <button onClick={() => onPick(r.name)} title={`Show only ${r.name}`}><span>{r.name}</span><i>{r.count}×</i></button>
            <span className="bar" aria-hidden="true"><u style={{ width: `${(r.count / top) * 100}%` }} /></span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Row({ event: e, onOpen, onPhotosChanged }: { event: EventView; onOpen: () => void; onPhotosChanged: () => void }) {
  const drop = usePhotoDrop(e.id, onPhotosChanged);
  const [, , day] = e.date.split("-");
  const lead = headliner(e);
  const support = (e.lineup ?? []).map((a) => a.name).filter((n) => n !== lead && n !== e.title);
  const genre = e.genre?.trim();
  const companions = companionsOf(e);
  return (
    <li className={`hist-item${drop.state.dragging ? " dropping" : ""}`} {...drop.handlers}>
      <button className="hist-row" onClick={onOpen} aria-label={`${e.title}, ${dateLabel(e.date, { month: "long", day: "numeric", year: "numeric" })}. Open details${companions.length ? `, with ${companions.map((c) => c.name).join(", ")}` : ""}`}>
        <span className="hd" aria-hidden="true"><b>{day}</b><span>{dateLabel(e.date, { month: "short" })}</span></span>
        <span className="hi">
          <span className="ht">{e.title}</span>
          {support.length > 0 && <span className="hs"><span className="muted">with</span> {support.slice(0, 3).join(", ")}{support.length > 3 ? ` +${support.length - 3}` : ""}</span>}
          <span className="hs muted">{e.venue ? `${e.venue.name}${e.venue.city ? ` · ${e.venue.city}` : ""}` : "Venue not set"}</span>
        </span>
        <span className="hs-side">
          {!!e.photoCount && <span className="tag photo-tag" aria-label={`${e.photoCount} ${e.photoCount === 1 ? "photo" : "photos"}`}><Icon name="camera" size={13} />{e.photoCount}</span>}
          {e.topScore !== undefined && <span className="tag" aria-label={`${(e.lineup?.length ?? 0) > 1 ? "Best act score" : "Score"} ${e.topScore} out of 10`} title={(e.lineup?.length ?? 0) > 1 ? "Best act score" : "Score"}>★ {e.topScore}</span>}
          {companions.length > 0 && <Avatars people={companions} />}
          {genre && <span className="genre-pill" style={{ "--h": genreHue(genre) } as CSSProperties} title={genre}>{genre}</span>}
        </span>
      </button>
      {drop.state.dragging && <span className="drop-hint" aria-hidden="true">Drop to add photos to {e.title}</span>}
      {drop.state.status && <p role="status" className="drop-note muted small">{drop.state.status}</p>}
      {drop.state.error && <p role="alert" className="drop-note error small">{drop.state.error} <button className="icon-btn" aria-label="Dismiss" onClick={drop.dismiss}>×</button></p>}
    </li>
  );
}

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";
const hueStyle = (key: string) => ({ "--h": personHue(key) }) as CSSProperties;

function Avatars({ people }: { people: Array<{ key: string; name: string }> }) {
  const extra = people.length - 3;
  return (
    <span className="avatars" title={people.map((p) => p.name).join(", ")}>
      {people.slice(0, 3).map((p) => <span key={p.key} className="avatar" style={hueStyle(p.key)} aria-hidden="true">{initial(p.name)}</span>)}
      {extra > 0 && <span className="avatar more" aria-hidden="true">+{extra}</span>}
    </span>
  );
}

const STRIP = 10;

/** Everyone you went with, as filter chips (pick one again to clear). "Alone" is always there. */
function PeopleStrip({ people, who, onPick, all, onToggleAll, total, alone }: {
  people: Person[]; who?: string; onPick: (key: string) => void; all: boolean; onToggleAll: () => void; total: number; alone: number;
}) {
  const chosen = people.findIndex((p) => p.key === who);
  const visible = all || people.length <= STRIP ? people : people.filter((p, i) => i < STRIP || i === chosen);
  return (
    <section className="card hist-people" aria-label="Who I went with">
      <h2>Went with</h2>
      <div className="hist-chips">
        {visible.map((p) => (
          <button key={p.key} className={who === p.key ? "on" : ""} style={hueStyle(p.key)} aria-pressed={who === p.key} aria-label={`${p.name}, ${p.count} ${p.count === 1 ? "show" : "shows"}`} onClick={() => onPick(p.key)}>
            <span className="avatar" aria-hidden="true">{initial(p.name)}</span><b>{p.name}</b><i>{p.count}</i>
          </button>
        ))}
        <button className={`alone${who === ALONE ? " on" : ""}`} aria-pressed={who === ALONE} aria-label={`Alone, ${alone} ${alone === 1 ? "show" : "shows"}`}
          title="Shows with nobody listed under “Going with”" onClick={() => onPick(ALONE)}>
          <span className="avatar" aria-hidden="true">∅</span><b>Alone</b><i>{alone}</i>
        </button>
        {people.length > STRIP && <button className="ghost" onClick={onToggleAll}>{all ? "Show fewer" : `Show ${people.length - visible.length} more`}</button>}
      </div>
      {people.length === 0 && total > 0 && <p className="muted small">Add names under “Going with” when you open a show, and they will show up here.</p>}
    </section>
  );
}
