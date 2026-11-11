import { useCallback, useEffect, useState } from "react";
import { op } from "../api";
import { logout } from "../auth";
import { money } from "../format";
import type { CalendarStatus, Stats } from "../types";

type CalList = { calendars: Array<{ id: string; name: string; primary?: boolean }>; selected?: string };

export function SettingsPage({ me }: { me?: { email?: string; name?: string } }) {
  const [cal, setCal] = useState<CalendarStatus>();
  const [list, setList] = useState<CalList>();
  const [stats, setStats] = useState<Stats>();
  const [pick, setPick] = useState("");
  const [newName, setNewName] = useState("Concerts");
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const flag = new URLSearchParams(location.search).get("calendar");

  const load = useCallback(async () => {
    try {
      const c = await op<CalendarStatus>("calendar_status");
      setCal(c);
      if (c.connected) setList(await op<CalList>("calendar_list"));
      setStats(await op<Stats>("get_stats"));
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (list?.selected) setPick(list.selected); }, [list?.selected]);

  async function act(fn: () => Promise<string | void>) {
    setBusy(true); setError(undefined); setMsg(undefined);
    try { const m = await fn(); if (m) setMsg(m); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Settings</h1>
      {flag === "connected" && <p role="status" className="ok">Google account connected. Now choose which calendar gets your shows.</p>}
      {(flag === "denied" || flag === "error") && <p role="alert" className="error">Google Calendar was not connected. Try again.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {msg && <p role="status" className="ok">{msg}</p>}

      <section className="panel" aria-labelledby="cal-h">
        <h2 id="cal-h">Google Calendar</h2>
        {!cal && <p className="muted">Loading…</p>}
        {cal && !cal.connected && (
          <>
            <p>Connect Google to put the shows you are going to on a calendar, with doors time, venue address and a reminder the day before.</p>
            <button className="btn primary" disabled={busy} onClick={() => act(async () => { const r = await op<{ url: string }>("calendar_connect"); location.assign(r.url); })}>Connect Google Calendar</button>
          </>
        )}
        {cal?.connected && (
          <>
            <p>Connected{cal.connectedAs ? <> as <strong>{cal.connectedAs}</strong></> : null}. {cal.calendarName ? <>Shows go to <strong>{cal.calendarName}</strong>.</> : <strong>Choose a calendar below.</strong>}</p>
            <div className="form">
              <label>Use an existing calendar
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Choose…</option>
                  {list?.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? " (primary)" : ""}</option>)}
                </select>
              </label>
              <div className="actions">
                <button className="btn primary" disabled={busy || !pick || pick === cal.calendarId} onClick={() => act(async () => {
                  const r = await op<{ resync: { synced: number } }>("calendar_select", { calendarId: pick });
                  return `Calendar selected. ${r.resync.synced} show${r.resync.synced === 1 ? "" : "s"} synced.`;
                })}>Use this calendar</button>
              </div>
              <label>…or create a dedicated one
                <span className="row">
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <button className="btn" disabled={busy || !newName.trim()} onClick={() => act(async () => { await op("calendar_select", { createName: newName.trim() }); return "Calendar created and selected."; })}>Create</button>
                </span>
              </label>
            </div>
            <div className="actions">
              <button className="btn" disabled={busy || !cal.calendarId} onClick={() => act(async () => {
                const r = await op<{ synced: number; errors: string[] }>("calendar_resync");
                return `Re-synced ${r.synced} show${r.synced === 1 ? "" : "s"}${r.errors.length ? `, ${r.errors.length} failed` : ""}.`;
              })}>Re-sync now</button>
              <button className="btn danger" disabled={busy} onClick={() => {
                const remove = confirm("Disconnect Google Calendar?\n\nOK also deletes the calendar entries Show Manager created. Cancel keeps them.") ;
                void act(async () => { await op("calendar_disconnect", { removeEvents: remove }); return "Disconnected."; });
              }}>Disconnect</button>
            </div>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="stats-h">
        <h2 id="stats-h">Your concerts</h2>
        {!stats && <p className="muted">Loading…</p>}
        {stats && (
          <>
            <dl className="stats">
              <div><dt>Attended</dt><dd>{stats.attendedTotal}</dd></div>
              <div><dt>Going</dt><dd>{stats.upcomingGoing}</dd></div>
              <div><dt>To decide</dt><dd>{stats.undecidedUpcoming}</dd></div>
              {Object.entries(stats.totalSpent).filter(([, v]) => v > 0).map(([cur, v]) => <div key={cur}><dt>Spent</dt><dd>{money(v, cur)}</dd></div>)}
            </dl>
            {stats.attendedByVenue.length > 0 && (
              <table>
                <caption className="sr">Shows attended by venue</caption>
                <thead><tr><th>Venue</th><th>Shows</th></tr></thead>
                <tbody>{stats.attendedByVenue.map((v) => <tr key={v.venueId ?? "none"}><td>{v.venue}{v.city ? <span className="muted"> · {v.city}</span> : null}</td><td>{v.count}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="acct-h">
        <h2 id="acct-h">Account</h2>
        <p>{me?.name ? <>{me.name} · </> : null}{me?.email ?? "Signed in"}</p>
        <button className="btn" onClick={() => void logout()}>Sign out</button>
      </section>

      <section className="panel" aria-labelledby="mcp-h">
        <h2 id="mcp-h">Use with Claude</h2>
        <p>Add this URL as a custom connector in claude.ai (Settings → Connectors), then sign in with the same account:</p>
        <p><code>{location.origin}/mcp</code></p>
      </section>
    </>
  );
}
