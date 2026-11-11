import { useCallback, useEffect, useState } from "react";
import { op } from "../api";
import { dateLabel, priceLabel, saleLabel, tierLabel, timeLabel } from "../format";
import type { EventView, VenueRow } from "../types";
import { EventForm } from "./EventForm";
import { Modal } from "./Modal";
import { RsvpPanel } from "./RsvpPanel";
import { SetlistSection } from "./SetlistSection";

/** Event details + RSVP + edit. `readOnly` is for events shared with me. */
export function EventDrawer({ eventId, initial, venues, readOnly, onClose, onChanged }: {
  eventId?: string; initial?: EventView; venues: VenueRow[]; readOnly?: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [event, setEvent] = useState<EventView | undefined>(initial);
  const [mode, setMode] = useState<"view" | "edit">(eventId || initial ? "view" : "edit");
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    if (!eventId || readOnly) return;
    try { setEvent(await op<EventView>("get_event", { eventId })); } catch (e) { setError((e as Error).message); }
    onChanged();
  }, [eventId, readOnly, onChanged]);

  useEffect(() => { if (eventId && !readOnly) void reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (mode === "edit") {
    return (
      <Modal title={event ? "Edit event" : "Add event"} onClose={onClose} wide>
        <EventForm
          event={event}
          venues={venues}
          onCancel={() => (event ? setMode("view") : onClose())}
          onSave={async (input) => {
            if (event) {
              const r = await op<{ event: EventView }>("update_event", { eventId: event.id, changes: input });
              setEvent(r.event); setMode("view");
            } else {
              const r = await op<{ event: EventView; created: boolean }>("create_event", { ...input, ifDuplicate: "skip" });
              if (!r.created) throw new Error("A show on this date at this venue already exists. Find it in the list to edit it.");
              onChanged(); onClose(); return;
            }
            onChanged();
          }}
        />
      </Modal>
    );
  }
  if (!event) return <Modal title="Event" onClose={onClose}>{error ? <p role="alert" className="error">{error}</p> : <p>Loading…</p>}</Modal>;

  const price = priceLabel(event);
  return (
    <Modal
      title={event.title}
      onClose={onClose}
      wide
      actions={!readOnly ? <button className="btn small" onClick={() => setMode("edit")}>Edit</button> : undefined}
    >
      <div className="detail">
        <p className="lead">{dateLabel(event.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · {timeLabel(event)}</p>
        {event.venue ? (
          <p>
            <strong>{event.venue.name}</strong>
            {event.venue.address && <><br />{event.venue.address}</>}
            {(event.venue.city || event.venue.state) && <><br />{[event.venue.city, event.venue.state].filter(Boolean).join(" - ")}</>}
            {event.venue.capacity ? <><br /><span className="muted">Capacity {event.venue.capacity.toLocaleString("en-US")}</span></> : null}
            {event.venue.mapsUrl && <><br /><a href={event.venue.mapsUrl} target="_blank" rel="noreferrer">Open map</a></>}
          </p>
        ) : <p className="muted">Venue not set</p>}

        {event.lineup?.length ? (
          <>
            <h3>Lineup</h3>
            <ul className="plain">
              {event.lineup.map((a, i) => <li key={i}>{a.name}{a.role && a.role !== "headliner" ? <span className="muted"> · {a.role}</span> : null}{a.startTime ? <span className="muted"> · {a.startTime}</span> : null}</li>)}
            </ul>
          </>
        ) : null}

        {event.tiers?.length ? (
          <>
            <h3>Tickets {event.saleStatus && event.saleStatus !== "unknown" ? <span className={`tag sale-${event.saleStatus}`}>{saleLabel[event.saleStatus]}</span> : null}</h3>
            <ul className="plain">
              {event.tiers.map((t) => <li key={t.name}>{t.name}: {t.price !== undefined ? tierLabel(t, event.currency) : "price TBA"}</li>)}
            </ul>
          </>
        ) : price ? <p>{price}</p> : null}

        <p className="links">
          {event.ticketUrl && <a href={event.ticketUrl} target="_blank" rel="noreferrer">Buy tickets</a>}
          {event.sourceUrl && <a href={event.sourceUrl} target="_blank" rel="noreferrer">Source</a>}
        </p>
        {event.genre && <p className="muted">{event.genre}{event.ageRating ? ` · ${event.ageRating}` : ""}</p>}
        {event.description && <p>{event.description}</p>}
        {event.notes && <p className="note">{event.notes}</p>}
      </div>

      <SetlistSection event={event} readOnly={readOnly} onUpdated={(e) => { setEvent(e); onChanged(); }} />

      {!readOnly && <RsvpPanel event={event} onChanged={reload} />}
      {readOnly && event.rsvp && <p className="panel">Status: <strong>{event.rsvp.status}</strong>{event.rsvp.companions?.length ? ` · with ${event.rsvp.companions.join(", ")}` : ""}</p>}

      {!readOnly && (
        <div className="actions">
          <button className="btn danger" onClick={async () => {
            if (!confirm(`Delete “${event.title}”? Its RSVP and calendar entry are removed too.`)) return;
            try { await op("delete_event", { eventId: event.id }); onChanged(); onClose(); } catch (e) { setError((e as Error).message); }
          }}>Delete event</button>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </Modal>
  );
}
