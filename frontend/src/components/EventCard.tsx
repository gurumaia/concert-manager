import { dateLabel, priceLabel, saleLabel, statusLabel, timeLabel } from "../format";
import type { EventView } from "../types";

export function EventCard({ event, onOpen, onQuick, sharedBy }: {
  event: EventView; onOpen: () => void; onQuick?: (status: "going" | "interested" | "skipped") => void; sharedBy?: string;
}) {
  const [, mon, day] = event.date.split("-");
  const price = priceLabel(event);
  const status = event.rsvp?.status;
  const lineup = (event.lineup ?? []).filter((a) => a.name !== event.title).map((a) => a.name);
  return (
    <li className={`card ${status ?? "undecided"}`}>
      <button className="card-main" onClick={onOpen} aria-label={`${event.title}, ${dateLabel(event.date)}. Open details`}>
        <span className="datebox" aria-hidden="true">
          <span className="dow">{dateLabel(event.date, { weekday: "short" })}</span>
          <span className="day">{day}</span>
          <span className="mon">{dateLabel(`2000-${mon}-01`, { month: "short" })}</span>
        </span>
        <span className="info">
          <span className="title">{event.title}</span>
          {lineup.length > 0 && <span className="sub">with {lineup.slice(0, 3).join(", ")}{lineup.length > 3 ? ` +${lineup.length - 3}` : ""}</span>}
          <span className="sub">{event.venue ? `${event.venue.name}${event.venue.city ? ` · ${event.venue.city}` : ""}` : "Venue TBA"}</span>
          <span className="meta">
            <span>{timeLabel(event)}</span>
            {price && <span>{price}</span>}
            {event.saleStatus && event.saleStatus !== "unknown" && <span className={`tag sale-${event.saleStatus}`}>{saleLabel[event.saleStatus]}</span>}
            {sharedBy && <span className="tag">from {sharedBy}</span>}
          </span>
        </span>
        {status && <span className={`badge ${status}`}>{statusLabel[status]}</span>}
      </button>
      {onQuick && !status && (
        <div className="quick" role="group" aria-label={`Quick RSVP for ${event.title}`}>
          <button className="btn small primary" onClick={() => onQuick("going")}>Going</button>
          <button className="btn small" onClick={() => onQuick("interested")}>Interested</button>
          <button className="btn small ghost" onClick={() => onQuick("skipped")}>Skip</button>
        </div>
      )}
    </li>
  );
}
