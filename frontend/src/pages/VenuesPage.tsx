import { useState, type FormEvent } from "react";
import { op } from "../api";
import { Modal } from "../components/Modal";
import type { VenueRow } from "../types";

type Field = "name" | "address" | "city" | "state" | "country" | "capacity" | "timezone" | "website" | "mapsUrl" | "notes";
const FIELDS: Array<[Field, string, string?]> = [
  ["name", "Name"], ["address", "Street address", "Shown as the location on your calendar"], ["city", "City"], ["state", "State"],
  ["country", "Country"], ["capacity", "Capacity", "Number of people the venue holds"], ["timezone", "Time zone", "e.g. America/Sao_Paulo"], ["website", "Website"], ["mapsUrl", "Map link"], ["notes", "Notes"],
];

export function VenuesPage({ venues, reload }: { venues: VenueRow[]; reload: () => void }) {
  const [editing, setEditing] = useState<VenueRow | "new">();
  const [error, setError] = useState<string>();
  const [showRetired, setShowRetired] = useState(false);
  const retiredCount = venues.filter((v) => v.retiredAt).length;
  const visible = venues.filter((v) => showRetired || !v.retiredAt);

  return (
    <>
      <div className="toolbar"><h1>Venues</h1><button className="btn primary" onClick={() => setEditing("new")}>+ Add venue</button></div>
      {error && <p role="alert" className="error">{error}</p>}
      {retiredCount > 0 && (
        <label className="check"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show closed venues ({retiredCount})</label>
      )}
      {!visible.length && <div className="empty"><p><strong>No venues yet.</strong></p><p className="muted">Venues are created when you add events.</p></div>}
      <ul className="cards">
        {visible.map((v) => (
          <li key={v.id} className={`card ${v.retiredAt ? "skipped" : ""}`}>
            <button className="card-main" onClick={() => setEditing(v)}>
              <span className="info">
                <span className="title">{v.name}</span>
                <span className="sub">{[v.address, v.city, v.state].filter(Boolean).join(", ") || "No address yet"}</span>
                {v.capacity ? <span className="sub">Capacity {v.capacity.toLocaleString("en-US")}</span> : null}
              </span>
              {v.retiredAt && <span className="badge skipped">Closed</span>}
              <span className="tag">{v.eventCount} {v.eventCount === 1 ? "show" : "shows"}</span>
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <Modal title={editing === "new" ? "Add venue" : editing.name} onClose={() => setEditing(undefined)}>
          <VenueForm
            venue={editing === "new" ? undefined : editing}
            others={venues.filter((v) => !v.retiredAt && (editing === "new" || v.id !== editing.id))}
            onDone={() => { setEditing(undefined); reload(); }}
            onError={setError}
          />
        </Modal>
      )}
    </>
  );
}

function VenueForm({ venue, others, onDone, onError }: { venue?: VenueRow; others: VenueRow[]; onDone: () => void; onError: (m: string) => void }) {
  const [d, setD] = useState<Record<Field, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, venue?.[k] !== undefined ? String(venue[k]) : ""])) as Record<Field, string>);
  const [mergeInto, setMergeInto] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  // capacity is the one numeric field; blank means "unknown" (null clears it on update).
  const value = (k: Field): string | number | undefined => {
    const t = d[k].trim();
    if (!t) return undefined;
    return k === "capacity" ? Number(t.replace(/[.,\s]/g, "")) : t;
  };

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(undefined);
    try {
      if (venue) {
        const changes = Object.fromEntries(FIELDS.map(([k]) => [k, value(k) ?? (k === "name" ? undefined : null)]));
        await op("update_venue", { venueId: venue.id, changes });
      } else {
        await op("create_venue", Object.fromEntries(FIELDS.map(([k]) => [k, value(k)])));
      }
      onDone();
    } catch (e2) { setErr((e2 as Error).message); setBusy(false); }
  }

  return (
    <form className="form" onSubmit={save}>
      {FIELDS.map(([k, label, hint]) => (
        <label key={k}>{label}{hint && <span className="muted small"> · {hint}</span>}
          <input required={k === "name"} {...(k === "capacity" ? { inputMode: "numeric" as const } : {})} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
        </label>
      ))}
      {err && <p role="alert" className="error">{err}</p>}
      <div className="actions spread">
        {venue ? (
          <div className="row">
            <button type="button" className="btn" disabled={busy}
              onClick={async () => {
                setBusy(true); setErr(undefined);
                try { await op(venue.retiredAt ? "unretire_venue" : "retire_venue", { venueId: venue.id }); onDone(); }
                catch (e) { setErr((e as Error).message); setBusy(false); }
              }}>{venue.retiredAt ? "Reopen venue" : "Mark as closed"}</button>
            <select aria-label="Merge into another venue" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
              <option value="">Merge into…</option>
              {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button type="button" className="btn danger" disabled={!mergeInto && venue.eventCount > 0}
              onClick={async () => {
                const label = mergeInto ? "Move its shows to the selected venue and delete this one?" : "Delete this venue?";
                if (!confirm(label)) return;
                try {
                  if (mergeInto) await op("merge_venues", { fromVenueId: venue.id, intoVenueId: mergeInto });
                  else await op("delete_venue", { venueId: venue.id });
                  onDone();
                } catch (e) { onError((e as Error).message); setErr((e as Error).message); }
              }}>{mergeInto ? "Merge" : "Delete"}</button>
          </div>
        ) : <span />}
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}
