import type { CSSProperties } from "react";
import { addedLabel, dateLabel, genreHue, priceLabel, saleLabel, statusLabel, timeLabel } from "../format";
import type { EventView } from "../types";
import { Icon } from "./Icon";

/**
 * Every card has the same slots in the same places: title (+ New) / acts / venue on the left, genre top-right and sale status
 * bottom-right, then a footer with time, price and the RSVP actions. Missing time or price shows a muted "TBA" in its slot.
 */
export function EventCard({ event, onOpen, onQuick, sharedBy, isNew, now }: {
  event: EventView; onOpen: () => void; onQuick?: (status: "going" | "interested" | "skipped") => void; sharedBy?: string;
  /** Added in the last 7 days: gets a New pill and a highlight. */
  isNew?: boolean; now?: number;
}) {
  const [, mon, day] = event.date.split("-");
  const price = priceLabel(event);
  const hasTime = !!(event.doorsTime || event.startTime);
  const status = event.rsvp?.status;
  const added = isNew ? addedLabel(event.createdAt, now ?? Date.now()) : undefined;
  const lineup = (event.lineup ?? []).filter((a) => a.name !== event.title).map((a) => a.name);
  const sale = event.saleStatus && event.saleStatus !== "unknown" ? event.saleStatus : undefined;
  const genre = event.genre?.trim();

  return (
    <li className={`card ev ${status ?? "undecided"}${isNew ? " isnew" : ""}`}>
      <button className="card-main" onClick={onOpen} aria-label={`${event.title}, ${dateLabel(event.date)}${added ? `. New, added ${added}` : ""}. Open details`}>
        <span className="datebox" aria-hidden="true">
          <span className="dow">{dateLabel(event.date, { weekday: "short" })}</span>
          <span className="day">{day}</span>
          <span className="mon">{dateLabel(`2000-${mon}-01`, { month: "short" })}</span>
        </span>
        <span className="info">
          <span className="ttl">
            <span className="title">{event.title}</span>
            {added && <span className="new-pill">New · {added}</span>}
          </span>
          {lineup.length > 0 && (
            <span className="line"><Icon name="mic" /><span><span className="muted">with</span> {lineup.slice(0, 3).join(", ")}{lineup.length > 3 ? ` +${lineup.length - 3}` : ""}</span></span>
          )}
          <span className="line sub"><Icon name="pin" />{event.venue ? `${event.venue.name}${event.venue.city ? ` · ${event.venue.city}` : ""}` : <span className="tba">Venue TBA</span>}</span>
        </span>
        <span className="side">
          {genre ? <span className="genre-pill" style={{ "--h": genreHue(genre) } as CSSProperties} title={genre}>{genre}</span> : <span />}
          {sale ? <span className={`tag sale-${sale}`}>{saleLabel[sale]}</span> : <span />}
        </span>
      </button>

      <div className="foot">
        <span className={`line${hasTime ? "" : " tba"}`}><Icon name="clock" />{timeLabel(event)}</span>
        <span className={`line${price ? "" : " tba"}`}><Icon name="ticket" />{price ?? "Price TBA"}</span>
        <span className="acts">
          {status ? (
            <span className={`badge ${status}`}>{statusLabel[status]}</span>
          ) : onQuick ? (
            <span role="group" aria-label={`Quick RSVP for ${event.title}`} className="acts-btns">
              <button className="btn small primary" onClick={() => onQuick("going")}>Going</button>
              <button className="btn small" onClick={() => onQuick("interested")}>Interested</button>
              <button className="btn small ghost" onClick={() => onQuick("skipped")}>Skip</button>
            </span>
          ) : sharedBy ? (
            <span className="tag">from {sharedBy}</span>
          ) : null}
        </span>
      </div>
    </li>
  );
}
