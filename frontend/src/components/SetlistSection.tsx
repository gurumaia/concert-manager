import { useState } from "react";
import { op } from "../api";
import type { EventView, Song } from "../types";

type ActResult = { act: string; status: "found" | "not_found" | "kept_manual" | "error"; songs?: number; message?: string };

const todayLocal = () => new Intl.DateTimeFormat("en-CA").format(new Date());

/** Songs in playing order, split wherever the section changes (main set, Encore, ...), numbered continuously. */
export function songGroups(songs: Song[]): Array<{ section?: string; start: number; songs: Song[] }> {
  const out: Array<{ section?: string; start: number; songs: Song[] }> = [];
  songs.forEach((s, i) => {
    const last = out[out.length - 1];
    if (last && last.section === s.section) last.songs.push(s);
    else out.push({ section: s.section, start: i + 1, songs: [s] });
  });
  return out;
}

export function summarize(results: ActResult[]): string {
  const found = results.filter((r) => r.status === "found").map((r) => r.act);
  const failed = results.filter((r) => r.status === "error");
  const parts: string[] = [];
  if (found.length) parts.push(`Found setlist for ${found.join(", ")}.`);
  else if (failed.length === results.length) parts.push("Could not reach setlist.fm. Try again in a moment.");
  else if (results.every((r) => r.status === "kept_manual")) parts.push("Every act already has a setlist you entered by hand.");
  else parts.push("setlist.fm has no setlist for this show yet. They are often posted a day or two later, and we also check again every morning.");
  if (failed.length && failed.length < results.length) parts.push(`Lookup failed for ${failed.map((r) => r.act).join(", ")}.`);
  return parts.join(" ");
}

/** Setlists of a show, plus (for shows that already happened) a button to fetch them from setlist.fm. */
export function SetlistSection({ event, readOnly, onUpdated }: { event: EventView; readOnly?: boolean; onUpdated: (e: EventView) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const past = event.date <= todayLocal();
  const setlists = event.setlists ?? [];
  if (!setlists.length && (!past || readOnly)) return null;

  const sync = async () => {
    setBusy(true); setError(undefined); setMessage(undefined);
    try {
      const r = await op<{ event: EventView; results: ActResult[] }>("sync_setlist", { eventId: event.id });
      onUpdated(r.event);
      setMessage(summarize(r.results));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="setlist-h" className="setlist-section">
      <h3 id="setlist-h">Setlist</h3>
      {setlists.map((sl) => (
        <div key={sl.act} className="setlist">
          {(setlists.length > 1 || (event.lineup?.length ?? 0) > 1) && <h4>{sl.act}</h4>}
          {songGroups(sl.songs).map((g) => (
            <div key={g.start}>
              {g.section && <p className="setlist-section-name muted small">{g.section}</p>}
              <ol start={g.start} className="setlist-songs">
                {g.songs.map((s, i) => (
                  <li key={i}>
                    {s.name}
                    {s.cover && <span className="muted"> ({s.cover} cover)</span>}
                    {s.info && <span className="muted"> · {s.info}</span>}
                    {s.tape && <span className="muted"> · tape</span>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <p className="muted small">
            {sl.source === "setlist.fm" ? "From " : "Added by hand"}
            {sl.source === "setlist.fm" && (sl.url ? <a href={sl.url} target="_blank" rel="noreferrer">setlist.fm</a> : "setlist.fm")}
          </p>
        </div>
      ))}
      {!setlists.length && <p className="muted">No setlist saved for this show yet.</p>}
      {past && !readOnly && (
        <div className="actions">
          <button className="btn small" onClick={sync} disabled={busy}>
            {busy ? "Looking up…" : setlists.length ? "Refresh from setlist.fm" : "Fetch setlist from setlist.fm"}
          </button>
        </div>
      )}
      {message && <p role="status" className="muted small">{message}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
