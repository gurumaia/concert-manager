import { useCallback, useEffect, useState } from "react";
import { op } from "../api";
import { dateLabel } from "../format";

type Loss = { ownerId: string; ownerName?: string; eventId: string; title: string; date: string; venue?: string; photoCount: number };

/**
 * Shows you answered after being tagged, which the owner has since taken you off (or deleted).
 * Nothing is lost until you decide: keep a copy as one of your own shows, or let go of your RSVP, score and photos of it.
 */
export function TagLosses({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Loss[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => { op<Loss[]>("list_tag_losses").then((r) => setItems(Array.isArray(r) ? r : []), () => {}); }, []);
  useEffect(load, [load]);

  async function resolve(l: Loss, keep: boolean) {
    if (!keep && l.photoCount > 0 && !confirm(`Delete your RSVP, score and ${l.photoCount} ${l.photoCount === 1 ? "photo" : "photos"} of “${l.title}”?`)) return;
    setBusy(l.eventId); setError(undefined);
    try { await op("resolve_tag_loss", { ownerId: l.ownerId, eventId: l.eventId, keep }); load(); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  }

  if (!items.length) return null;
  return (
    <section className="tag-losses" aria-label="Shows you were taken off of">
      {items.map((l) => (
        <div key={`${l.ownerId}#${l.eventId}`} className="tag-loss" role="group" aria-label={l.title}>
          <p><strong>{l.ownerName ?? "Someone"}</strong> took you off <strong>{l.title}</strong> <span className="muted">· {dateLabel(l.date, { month: "short", day: "numeric", year: "numeric" })}{l.venue ? ` · ${l.venue}` : ""}</span>.
            {" "}Keep a copy in your shows? Your RSVP and score{l.photoCount ? ` and ${l.photoCount} ${l.photoCount === 1 ? "photo" : "photos"}` : ""} come with it. Without a copy they are deleted.</p>
          <div className="actions">
            <button className="btn primary small" disabled={busy === l.eventId} onClick={() => void resolve(l, true)}>Keep a copy</button>
            <button className="btn small" disabled={busy === l.eventId} onClick={() => void resolve(l, false)}>No thanks</button>
          </div>
        </div>
      ))}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
