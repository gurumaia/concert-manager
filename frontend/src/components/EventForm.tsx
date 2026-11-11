import { useState, type FormEvent } from "react";
import type { Act, EventView, Tier, VenueRow } from "../types";
import { saleLabel } from "../format";

const ROLES: NonNullable<Act["role"]>[] = ["headliner", "support", "opener", "guest"];
const NEW_VENUE = "__new";

type Draft = {
  title: string; date: string; doorsTime: string; startTime: string; endTime: string;
  venueId: string; newVenue: string; newVenueCity: string; newVenueAddress: string;
  lineup: Array<{ name: string; role: string }>;
  tiers: Array<{ name: string; price: string; fee: string }>;
  currency: string; ticketUrl: string; sourceUrl: string; genre: string; saleStatus: string; notes: string;
};

const num = (s: string) => (s.trim() === "" ? undefined : Number(s.replace(",", ".")));

function toDraft(e?: EventView): Draft {
  return {
    title: e?.title ?? "", date: e?.date ?? "", doorsTime: e?.doorsTime ?? "", startTime: e?.startTime ?? "", endTime: e?.endTime ?? "",
    venueId: e?.venueId ?? "", newVenue: "", newVenueCity: "", newVenueAddress: "",
    lineup: (e?.lineup ?? []).map((a) => ({ name: a.name, role: a.role ?? "" })),
    tiers: (e?.tiers ?? []).map((t) => ({ name: t.name, price: t.price?.toString() ?? "", fee: t.fee?.toString() ?? "" })),
    currency: e?.currency ?? "BRL", ticketUrl: e?.ticketUrl ?? "", sourceUrl: e?.sourceUrl ?? "", genre: e?.genre ?? "",
    saleStatus: e?.saleStatus ?? "", notes: e?.notes ?? "",
  };
}

/** Build the payload for create_event / update_event(changes). On edit, a emptied field becomes null (= clear it). */
export function toInput(d: Draft, isEdit: boolean): Record<string, unknown> {
  const opt = (v: string) => (v.trim() !== "" ? v.trim() : isEdit ? null : undefined);
  const lineup: Act[] = d.lineup.filter((a) => a.name.trim()).map((a) => ({ name: a.name.trim(), ...(a.role ? { role: a.role as Act["role"] } : {}) }));
  const tiers: Tier[] = d.tiers.filter((t) => t.name.trim()).map((t) => ({ name: t.name.trim(), price: num(t.price), fee: num(t.fee) }));
  const venue = d.venueId === NEW_VENUE && d.newVenue.trim() ? { name: d.newVenue.trim(), city: d.newVenueCity.trim() || undefined, address: d.newVenueAddress.trim() || undefined } : undefined;
  return {
    title: d.title.trim(), date: d.date,
    doorsTime: opt(d.doorsTime), startTime: opt(d.startTime), endTime: opt(d.endTime),
    ...(d.venueId && d.venueId !== NEW_VENUE ? { venueId: d.venueId } : !d.venueId && isEdit ? { venueId: null } : {}),
    ...(venue ? { venue } : {}),
    ...(lineup.length || isEdit ? { lineup } : {}),
    ...(tiers.length || isEdit ? { tiers } : {}),
    currency: d.currency || undefined, ticketUrl: opt(d.ticketUrl), sourceUrl: opt(d.sourceUrl), genre: opt(d.genre),
    saleStatus: d.saleStatus || (isEdit ? null : undefined), notes: opt(d.notes),
  };
}

export function EventForm({ event, venues, onSave, onCancel }: {
  event?: EventView; venues: VenueRow[]; onSave: (input: Record<string, unknown>) => Promise<void>; onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(event));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true); setError(undefined);
    try { await onSave(toInput(d, !!event)); } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>Title<input required value={d.title} onChange={(e) => set("title", e.target.value)} autoFocus /></label>
      <div className="grid-4">
        <label>Date<input required type="date" value={d.date} onChange={(e) => set("date", e.target.value)} /></label>
        <label>Doors<input type="time" value={d.doorsTime} onChange={(e) => set("doorsTime", e.target.value)} /></label>
        <label>Show starts<input type="time" value={d.startTime} onChange={(e) => set("startTime", e.target.value)} /></label>
        <label>Ends<input type="time" value={d.endTime} onChange={(e) => set("endTime", e.target.value)} /></label>
      </div>

      <label>Venue
        <select value={d.venueId} onChange={(e) => set("venueId", e.target.value)}>
          <option value="">Unknown</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}{v.city ? ` (${v.city})` : ""}</option>)}
          <option value={NEW_VENUE}>New venue…</option>
        </select>
      </label>
      {d.venueId === NEW_VENUE && (
        <div className="grid-3 nested">
          <label>Venue name<input required value={d.newVenue} onChange={(e) => set("newVenue", e.target.value)} /></label>
          <label>City<input value={d.newVenueCity} onChange={(e) => set("newVenueCity", e.target.value)} /></label>
          <label>Address<input value={d.newVenueAddress} onChange={(e) => set("newVenueAddress", e.target.value)} /></label>
        </div>
      )}

      <fieldset>
        <legend>Lineup</legend>
        {d.lineup.map((a, i) => (
          <div className="row" key={i}>
            <input aria-label={`Act ${i + 1} name`} placeholder="Artist" value={a.name} onChange={(e) => set("lineup", d.lineup.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <select aria-label={`Act ${i + 1} role`} value={a.role} onChange={(e) => set("lineup", d.lineup.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
              <option value="">Role</option>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
            <button type="button" className="icon-btn" aria-label={`Remove act ${i + 1}`} onClick={() => set("lineup", d.lineup.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => set("lineup", [...d.lineup, { name: "", role: d.lineup.length ? "support" : "headliner" }])}>+ Add act</button>
      </fieldset>

      <fieldset>
        <legend>Ticket tiers <span className="muted">(fee is shown separately)</span></legend>
        {d.tiers.map((t, i) => (
          <div className="row" key={i}>
            <input aria-label={`Tier ${i + 1} name`} placeholder="Pista, VIP…" value={t.name} onChange={(e) => set("tiers", d.tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input aria-label={`Tier ${i + 1} price`} placeholder="Price" inputMode="decimal" value={t.price} onChange={(e) => set("tiers", d.tiers.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            <input aria-label={`Tier ${i + 1} fee`} placeholder="Fee" inputMode="decimal" value={t.fee} onChange={(e) => set("tiers", d.tiers.map((x, j) => (j === i ? { ...x, fee: e.target.value } : x)))} />
            <button type="button" className="icon-btn" aria-label={`Remove tier ${i + 1}`} onClick={() => set("tiers", d.tiers.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => set("tiers", [...d.tiers, { name: "", price: "", fee: "" }])}>+ Add tier</button>
      </fieldset>

      <div className="grid-3">
        <label>Currency<input maxLength={3} value={d.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></label>
        <label>Genre<input value={d.genre} onChange={(e) => set("genre", e.target.value)} /></label>
        <label>Ticket sales
          <select value={d.saleStatus} onChange={(e) => set("saleStatus", e.target.value)}>
            <option value="">Unknown</option>
            {Object.entries(saleLabel).filter(([k]) => k !== "unknown").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <label>Ticket link<input type="url" value={d.ticketUrl} onChange={(e) => set("ticketUrl", e.target.value)} placeholder="https://" /></label>
      <label>Source link<input type="url" value={d.sourceUrl} onChange={(e) => set("sourceUrl", e.target.value)} placeholder="https://" /></label>
      <label>Notes<textarea rows={3} value={d.notes} onChange={(e) => set("notes", e.target.value)} /></label>

      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : event ? "Save changes" : "Add event"}</button>
      </div>
    </form>
  );
}
