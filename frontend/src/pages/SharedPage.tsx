import { useCallback, useEffect, useState } from "react";
import { op } from "../api";
import { EventCard } from "../components/EventCard";
import { EventDrawer } from "../components/EventDrawer";
import type { SharedEventView } from "../types";

export function SharedPage() {
  const [items, setItems] = useState<SharedEventView[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<SharedEventView>();
  const load = useCallback(() => { op<SharedEventView[]>("list_shared_with_me").then(setItems).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  return (
    <>
      <h1>Shared with me</h1>
      <p className="muted">Shows other people RSVP'd to and shared with your email. Read only.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {!items && !error && <p className="muted">Loading…</p>}
      {items && !items.length && <div className="empty"><p><strong>Nothing shared with you yet.</strong></p><p className="muted">When someone shares a show with your email it shows up here.</p></div>}
      <ul className="cards">
        {items?.map((e) => <EventCard key={e.id + e.sharedBy.id} event={e} sharedBy={e.sharedBy.name ?? e.sharedBy.email} onOpen={() => setOpen(e)} />)}
      </ul>
      {open && <EventDrawer initial={open} readOnly ownerId={open.sharedBy.id} venues={[]} onClose={() => setOpen(undefined)} onChanged={load} />}
    </>
  );
}
