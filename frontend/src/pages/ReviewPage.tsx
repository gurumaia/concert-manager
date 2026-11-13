import { useCallback, useEffect, useMemo, useState } from "react";
import { op } from "../api";
import { loadAttended } from "../attended";
import { ReviewStory } from "../components/ReviewStory";
import { peopleOf } from "../history";
import { rangeLabel } from "../review";
import type { EventView, ReviewData, ReviewRecipe } from "../types";

type Link = { token: string; url: string; recipe: ReviewRecipe; showNames: boolean; createdAt: string };
const PEOPLE_SHOWN = 10;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Recap: pick a date range and (optionally) people, play it as a tap-through story, or share a public, unlisted link to it. */
export function ReviewPage() {
  const [events, setEvents] = useState<EventView[]>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [picked, setPicked] = useState<string[]>([]); // person keys
  const [match, setMatch] = useState<"any" | "all">("any");
  const [allPeople, setAllPeople] = useState(false);
  const [data, setData] = useState<ReviewData>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [links, setLinks] = useState<Link[]>([]);
  const [showNames, setShowNames] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [fresh, setFresh] = useState<string>();

  const people = useMemo(() => peopleOf(events ?? []), [events]);
  const years = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of events ?? []) m.set(Number(e.date.slice(0, 4)), (m.get(Number(e.date.slice(0, 4))) ?? 0) + 1);
    return [...m].sort((a, b) => b[0] - a[0]);
  }, [events]);
  const names = picked.map((k) => people.find((p) => p.key === k)?.name).filter((n): n is string => !!n);

  useEffect(() => {
    loadAttended().then((all) => {
      setEvents(all);
      const latest = all.reduce((y, e) => Math.max(y, Number(e.date.slice(0, 4))), 0) || new Date().getFullYear();
      setFrom(`${latest}-01-01`); setTo(`${latest}-12-31`);
    }).catch((e) => setError((e as Error).message));
    op<Link[]>("list_review_links").then(setLinks).catch(() => undefined);
  }, []);

  const valid = !!from && !!to && from <= to;
  useEffect(() => {
    if (!valid) { setData(undefined); return; }
    let live = true;
    setBusy(true);
    op<ReviewData>("year_review", { from, to, ...(names.length ? { people: names, ...(names.length > 1 ? { match } : {}) } : {}) })
      .then((d) => { if (live) { setData(d); setError(undefined); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [from, to, names.join("|"), match, valid]); // eslint-disable-line react-hooks/exhaustive-deps

  const setYear = (y: number) => { setFrom(`${y}-01-01`); setTo(`${y}-12-31`); };
  const last12 = () => { const t = new Date(); const f = new Date(t); f.setFullYear(f.getFullYear() - 1); f.setDate(f.getDate() + 1); setFrom(iso(f)); setTo(iso(t)); };
  const allTime = () => { const ds = (events ?? []).map((e) => e.date).sort(); if (ds.length) { setFrom(ds[0]!); setTo(ds[ds.length - 1]!); } };
  const togglePerson = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const isYear = (y: number) => from === `${y}-01-01` && to === `${y}-12-31`;

  const shows = data?.shows.length ?? 0;
  const photos = data?.shows.reduce((n, s) => n + s.photos.length, 0) ?? 0;
  const visiblePeople = allPeople || people.length <= PEOPLE_SHOWN ? people : people.filter((p, i) => i < PEOPLE_SHOWN || picked.includes(p.key));

  const share = async () => {
    setError(undefined);
    try {
      const l = await op<Link>("create_review_link", { from, to, showNames, ...(names.length ? { people: names, ...(names.length > 1 ? { match } : {}) } : {}) });
      setLinks((ls) => [l, ...ls]); setFresh(l.token);
      await Promise.resolve(); document.getElementById(`link-${l.token}`)?.scrollIntoView?.({ block: "nearest" });
    } catch (e) { setError((e as Error).message); }
  };
  const revoke = useCallback(async (l: Link) => {
    if (!confirm("Stop sharing this link? Anyone who has it will see a “not found” page. This cannot be undone.")) return;
    try { await op("revoke_review_link", { token: l.token }); setLinks((ls) => ls.filter((x) => x.token !== l.token)); } catch (e) { setError((e as Error).message); }
  }, []);
  const copy = async (l: Link) => { await navigator.clipboard?.writeText(l.url); setCopied(l.token); setTimeout(() => setCopied(undefined), 2000); };

  useEffect(() => {
    if (!playing) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [playing]);

  return (
    <>
      <h1>Recap</h1>
      <p className="muted">A tap-through story of the shows you went to, with your photos. Pick a period, and optionally who you went with.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {!events && !error && <p className="muted">Loading…</p>}
      {events && !events.length && <div className="empty"><p><strong>No shows to look back on yet.</strong></p><p className="muted">Once you have been to a show (going, with a date that has passed), it shows up here.</p></div>}

      {events && events.length > 0 && (
        <>
          <section className="card rv-form" aria-label="Period">
            <h2>Period</h2>
            <p className="muted small">Pick a year, or set your own dates. The number is how many shows you went to.</p>
            <div className="rv-chips" role="group" aria-label="Quick periods">
              {years.map(([y, n]) => <button key={y} className="rv-chip" aria-pressed={isYear(y)} onClick={() => setYear(y)}>{y}<small><span className="rv-sr">, </span>{plural(n, "show")}</small></button>)}
              <button className="rv-chip" onClick={last12}>Last 12 months</button>
              <button className="rv-chip" onClick={allTime}>All time</button>
            </div>
            <div className="rv-dates">
              <label className="field"><span>From</span><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="field"><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
            {!valid && from && to && <p role="alert" className="error small">The start date is after the end date.</p>}
          </section>

          <section className="card rv-form" aria-label="People">
            <h2>Who you went with <span className="muted small">(optional)</span></h2>
            {people.length === 0
              ? <p className="muted small">Add names under “Going with” when you open a show, and you can look back at the shows you shared with them.</p>
              : (
                <>
                  <div className="rv-chips" role="group" aria-label="People">
                    {visiblePeople.map((p) => <button key={p.key} className="rv-chip" aria-pressed={picked.includes(p.key)} onClick={() => togglePerson(p.key)}>{p.name}<small><span className="rv-sr">, </span>{plural(p.count, "show")}</small></button>)}
                    {people.length > PEOPLE_SHOWN && <button className="btn small ghost" onClick={() => setAllPeople(!allPeople)}>{allPeople ? "Show fewer" : `Show ${people.length - visiblePeople.length} more`}</button>}
                  </div>
                  {picked.length > 1 && (
                    <div className="seg" role="group" aria-label="How to match">
                      <button className={`seg-btn theme${match === "any" ? " on" : ""}`} aria-pressed={match === "any"} onClick={() => setMatch("any")}>Shows with any of them</button>
                      <button className={`seg-btn theme${match === "all" ? " on" : ""}`} aria-pressed={match === "all"} onClick={() => setMatch("all")}>Only shows with all of them</button>
                    </div>
                  )}
                  <p className="muted small">{picked.length ? "Only shows you went to with the people you picked." : "Nobody picked: all your shows in the period."}</p>
                </>
              )}
          </section>

          <section className="card rv-form rv-play" aria-label="Preview">
            {busy && !data ? <p className="muted">Loading…</p> : valid && data && (
              shows
                ? <p className="lead">{plural(shows, "show")} · {plural(photos, "photo")}<span className="muted"> · {rangeLabel(from, to)}</span></p>
                : <p className="lead">No shows in this selection.<span className="muted"> Try a wider period{names.length ? " or fewer people" : ""}.</span></p>
            )}
            <button className="btn primary big" disabled={!shows || busy} onClick={() => setPlaying(true)}>Play my recap</button>
          </section>

          <section className="card rv-form" aria-label="Share">
            <h2>Share</h2>
            <p className="muted small">Creates a link that anyone you send it to can open, without signing in. It is not listed anywhere.</p>
            <ul className="muted small rv-bullets">
              <li><strong>Public through the link:</strong> the photos, show titles, venues, dates and scores in this selection.</li>
              <li><strong>Not included:</strong> what you paid, your notes and your email.</li>
              <li><strong>Stays up to date:</strong> photos you add to these shows later appear too, until you stop sharing.</li>
              <li>You can stop sharing at any time and the link stops working right away.</li>
            </ul>
            <label className="rv-check"><input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} /> Show the names of the people I went with</label>
            <p className="muted small rv-hint">{showNames ? "Their names will appear on the shared page. Only tick this if they are fine with it." : "Names stay hidden. Photos can still show people's faces."}</p>
            <div><button className="btn" onClick={() => void share()} disabled={!shows || !valid}>Create link for this selection</button></div>
            {links.length > 0 && (
              <ul className="plain rv-links" aria-label="Shared links">
                {links.map((l) => (
                  <li key={l.token} id={`link-${l.token}`} className={fresh === l.token ? "fresh" : undefined}>
                    <div>
                      {fresh === l.token && <span className="ok small" role="status">Link created. </span>}<strong>{rangeLabel(l.recipe.from, l.recipe.to)}</strong>
                      <span className="muted small"> · {l.recipe.people?.length ? `only shows with ${l.recipe.people.join(l.recipe.match === "all" ? " & " : " or ")}` : "all your shows"} · {l.showNames ? "names of the people you went with are shown" : "names hidden"}</span>
                      <div className="small rv-url"><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></div>
                    </div>
                    <div className="rv-link-actions">
                      <button className="btn small" onClick={() => void copy(l)}>{copied === l.token ? "Copied" : "Copy link"}</button>
                      <button className="btn small danger" onClick={() => void revoke(l)}>Stop sharing</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {playing && data && (
        <div className="rv-overlay" onClick={(e) => { if (e.target === e.currentTarget) setPlaying(false); }}>
          <ReviewStory data={data} onClose={() => setPlaying(false)} fullscreenOnStart={typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches} />
        </div>
      )}
    </>
  );
}
