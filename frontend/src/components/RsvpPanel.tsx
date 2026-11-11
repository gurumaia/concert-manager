import { useEffect, useState } from "react";
import { op } from "../api";
import { money, statusLabel, tierLabel } from "../format";
import { peopleOf, type Person } from "../history";
import { PeopleInput } from "./PeopleInput";
import type { EventView, RsvpStatus, SyncResult } from "../types";

const STATUSES: RsvpStatus[] = ["interested", "going", "skipped"];
type SetRsvpResult = { rsvp: NonNullable<EventView["rsvp"]>; warnings: string[]; calendar: SyncResult };

export function RsvpPanel({ event, onChanged }: { event: EventView; onChanged: () => void }) {
  const r = event.rsvp;
  const [tier, setTier] = useState(r?.tierName ?? "");
  const [qty, setQty] = useState(r?.quantity?.toString() ?? "");
  const [paid, setPaid] = useState(r?.pricePaid?.toString() ?? "");
  const [fees, setFees] = useState(r?.feesPaid?.toString() ?? "");
  const [companions, setCompanions] = useState<string[]>(r?.companions ?? []);
  const [people, setPeople] = useState<Person[]>([]);
  const [notes, setNotes] = useState(r?.notes ?? "");
  const [shareEmail, setShareEmail] = useState("");
  const [msg, setMsg] = useState<{ warnings: string[]; calendar?: SyncResult }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const n = (s: string) => (s.trim() === "" ? undefined : Number(s.replace(",", ".")));

  // Suggestions are only a convenience, so a failed lookup just leaves the box without them.
  useEffect(() => {
    let live = true;
    op<{ events: EventView[] }>("list_events", { rsvp: "any", limit: 500, sort: "desc" })
      .then((res) => { if (live) setPeople(peopleOf(res.events)); }, () => {});
    return () => { live = false; };
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const save = (status: RsvpStatus) => run(async () => {
    const res = await op<SetRsvpResult>("set_rsvp", {
      eventId: event.id, status,
      tierName: tier || undefined, quantity: n(qty), pricePaid: n(paid), feesPaid: n(fees),
      companions, notes: notes.trim() || undefined,
    });
    setMsg({ warnings: res.warnings, calendar: res.calendar });
    onChanged();
  });

  const showTicketFields = r?.status === "going";
  // Going to a show that is over means you went, so the buttons say so; skipping it is how you say you did not.
  const past = !!event.past;
  const label = (s: RsvpStatus) => (past && s === "going" ? "Attended" : past && s === "skipped" ? "Didn't go" : statusLabel[s]);

  return (
    <section aria-labelledby="rsvp-h" className="panel">
      <h3 id="rsvp-h">Your RSVP</h3>
      <div className="seg" role="group" aria-label="RSVP status">
        {STATUSES.map((s) => (
          <button key={s} className={`seg-btn ${r?.status === s ? `on ${past && s === "going" ? "attended" : s}` : ""}`} aria-pressed={r?.status === s} disabled={busy} onClick={() => save(s)}>
            {label(s)}
          </button>
        ))}
      </div>
      {!r && <p className="muted small">{past ? "Pick Attended if you went. It will show up in your history." : "Not decided yet. Going also covers “bought tickets” and adds the show to your calendar."}</p>}
      {r?.status === "going" && past && <p className="muted small">Counted as a show you went to. If you did not make it, choose Didn’t go.</p>}

      {msg?.warnings.map((w) => <p key={w} role="status" className="warn">⚠ {w}</p>)}
      {msg?.calendar && <CalendarNote c={msg.calendar} />}
      {error && <p role="alert" className="error">{error}</p>}

      {r && (
        <div className="form compact">
          <div className="grid-4">
            <label>Tier
              <select value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">—</option>
                {(event.tiers ?? []).map((t) => <option key={t.name} value={t.name}>{t.name} · {tierLabel(t, event.currency)}</option>)}
              </select>
            </label>
            <label>Tickets<input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            {showTicketFields && <label>Paid ({event.currency ?? "BRL"})<input inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} /></label>}
            {showTicketFields && <label>Fees paid<input inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} /></label>}
          </div>
          <PeopleInput label="Going with" value={companions} onChange={setCompanions} people={people} />
          <label>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => save(r.status)}>Save details</button>
            <button className="btn danger" disabled={busy} onClick={() => run(async () => { await op("remove_rsvp", { eventId: event.id }); onChanged(); })}>Remove RSVP</button>
          </div>
          {r.pricePaid !== undefined && <p className="muted small">Total paid {money(r.pricePaid + (r.feesPaid ?? 0), event.currency)}{r.feesPaid ? ` (${money(r.feesPaid, event.currency)} fees)` : ""}</p>}

          <h4>Share</h4>
          <p className="muted small">People you share with see this show under “Shared with me” when they sign in with that email.</p>
          <ul className="chips">
            {r.sharedWith.map((e) => (
              <li key={e} className="chip">{e}
                <button aria-label={`Stop sharing with ${e}`} className="icon-btn" onClick={() => run(async () => { await op("unshare_rsvp", { eventId: event.id, emails: [e] }); onChanged(); })}>×</button>
              </li>
            ))}
          </ul>
          <form className="row" onSubmit={(ev) => { ev.preventDefault(); if (!shareEmail) return; void run(async () => { await op("share_rsvp", { eventId: event.id, emails: [shareEmail] }); setShareEmail(""); onChanged(); }); }}>
            <input type="email" aria-label="Email to share with" placeholder="name@example.com" value={shareEmail} onChange={(e) => setShareEmail(e.target.value)} />
            <button className="btn" disabled={busy || !shareEmail}>Share</button>
          </form>
        </div>
      )}
    </section>
  );
}

export function CalendarNote({ c }: { c: SyncResult }) {
  if (c.status === "synced") return <p role="status" className="ok">✓ On your Google Calendar</p>;
  if (c.status === "removed") return <p role="status" className="muted small">Removed from your Google Calendar</p>;
  if (c.status === "error") return <p role="alert" className="error">Calendar sync failed: {c.message}. The RSVP is saved; use Re-sync in Settings.</p>;
  if (c.message) return <p role="status" className="muted small">{c.message}. <a href="/settings" onClick={(e) => { e.preventDefault(); history.pushState(null, "", "/settings"); dispatchEvent(new PopStateEvent("popstate")); }}>Set up calendar</a></p>;
  return null;
}
