import type { CSSProperties } from "react";
import { addedLabel, dateLabel, genreHue, priceLabel, saleLabel, statusLabel, timeLabel } from "../format";
import type { EventView } from "../types";
import { usePhotoDrop } from "../usePhotoDrop";
import { Icon } from "./Icon";

const QUICK: Array<["going" | "interested" | "skipped", string]> = [["going", "Going"], ["interested", "Interested"], ["skipped", "Skip"]];

/**
 * Every card has the same slots in the same places: title (+ New) / acts / venue on the left, genre top-right and sale status
 * bottom-right, then a footer with time, price and the RSVP actions. Missing time or price shows a muted "TBA" in its slot.
 */
export function EventCard({ event, onOpen, openLabel = "Open details", onQuick, pending, locked, isNew, now, onPhotosChanged }: {
  event: EventView; /** `"photos"`: open the details already scrolled to the photos. */ onOpen?: (target?: "photos") => void; /** Photos were added by dropping them on the card. */ onPhotosChanged?: () => void; openLabel?: string; onQuick?: (status: "going" | "interested" | "skipped") => void;
  /** The quick RSVP being saved on this card (shown as a spinner), and whether any card is saving (all quick buttons wait). */
  pending?: "going" | "interested" | "skipped"; locked?: boolean;
  /** Added in the last 7 days: gets a New pill and a highlight. */
  isNew?: boolean; now?: number;
}) {
  // Photos can be dropped on your own past shows (the same ones that show a Photos section in the details).
  const drop = usePhotoDrop(event.id, () => onPhotosChanged?.());
  const canDrop = !!onOpen && !!event.past;
  const dropProps = canDrop ? drop.handlers : {};
  const [, mon, day] = event.date.split("-");
  const price = priceLabel(event);
  const hasTime = !!(event.doorsTime || event.startTime);
  const status = event.rsvp?.status;
  const added = isNew ? addedLabel(event.createdAt, now ?? Date.now()) : undefined;
  const lineup = (event.lineup ?? []).filter((a) => a.name !== event.title).map((a) => a.name);
  const sale = event.saleStatus && event.saleStatus !== "unknown" ? event.saleStatus : undefined;
  const genre = event.genre?.trim();
  // Someone tagged you: until you answer, the card says so where the status will be. After that it is just a show, with their name as a quiet detail.
  const taggers = (event.taggedBy ?? []).map((t) => t.name ?? t.email ?? "a friend");
  const undecided = !!event.tagged && !event.rsvp;

  return (
    <li className={`card ev ${event.attended ? "attended" : status ?? "undecided"}${event.tagged ? " tagged" : ""}${isNew ? " isnew" : ""}${canDrop && drop.state.dragging ? " dropping" : ""}`} {...dropProps}>
      <Main className="card-main" onOpen={onOpen && (() => onOpen())} label={`${event.title}, ${dateLabel(event.date)}${added ? `. New, added ${added}` : ""}. ${openLabel}`}>
        <span className="datebox" aria-hidden="true">
          <span className="dow">{dateLabel(event.date, { weekday: "short" })}</span>
          <span className="day">{day}</span>
          <span className="mon">{dateLabel(`2000-${mon}-01`, { month: "short" })}</span>
        </span>
        <span className="info">
          <span className="ttl">
            <span className="title">{event.title}</span>
            {added && <span className="new-pill">New · {added}</span>}
            {undecided && taggers.length > 0 && <span className="tagged-pill">{taggers.join(", ")} tagged you</span>}
          </span>
          {lineup.length > 0 && (
            <span className="line"><Icon name="mic" /><span><span className="muted">with</span> {lineup.slice(0, 3).join(", ")}{lineup.length > 3 ? ` +${lineup.length - 3}` : ""}</span></span>
          )}
          <span className="line sub"><Icon name="pin" />{event.venue ? `${event.venue.name}${event.venue.city ? ` · ${event.venue.city}` : ""}` : <span className="tba">Venue TBA</span>}{taggers.length > 0 && !undecided && <span className="muted"> · with {taggers.join(", ")}</span>}</span>
        </span>
        <span className="side">
          {genre ? <span className="genre-pill" style={{ "--h": genreHue(genre) } as CSSProperties} title={genre}>{genre}</span> : <span />}
          {sale ? <span className={`tag sale-${sale}`}>{saleLabel[sale]}</span> : <span />}
        </span>
      </Main>

      <div className="foot">
        <span className={`line${hasTime ? "" : " tba"}`}><Icon name="clock" />{timeLabel(event)}</span>
        <span className={`line${price ? "" : " tba"}`}><Icon name="ticket" />{price ?? "Price TBA"}</span>
        <span className="acts">
          {canDrop && !!event.photoCount && (
            <button className="photo-count" onClick={() => onOpen!("photos")} aria-label={`${event.photoCount} ${event.photoCount === 1 ? "photo" : "photos"} of ${event.title}. Open photos`}>
              <Icon name="camera" size={14} />{event.photoCount}
            </button>
          )}
          {onQuick && !event.attended ? (
            // All three stay quiet; only the one matching your RSVP is lit, in its status colour.
            <span role="group" aria-label={`RSVP for ${event.title}`} aria-busy={!!pending} className="acts-btns">
              {QUICK.map(([s, label]) => (
                <button key={s} className={`qbtn${status === s ? ` on ${s}` : ""}${pending === s ? " saving" : ""}`} aria-pressed={status === s} aria-label={pending === s ? `${label}, saving` : undefined} disabled={locked} onClick={() => status !== s && onQuick(s)}>{label}</button>
              ))}
            </span>
          ) : status ? (
            <span className={`badge ${event.attended ? "attended" : status}`}>{statusLabel[event.attended ? "attended" : status]}{event.attended && event.topScore !== undefined ? ` · ★ ${event.topScore}` : ""}</span>
          ) : null}
        </span>
      </div>
      {canDrop && drop.state.dragging && <span className="drop-hint" aria-hidden="true">Drop to add photos to {event.title}</span>}
      {canDrop && drop.state.status && <p role="status" className="drop-note muted small">{drop.state.status}</p>}
      {canDrop && drop.state.error && <p role="alert" className="drop-note error small">{drop.state.error} <button className="icon-btn" aria-label="Dismiss" onClick={drop.dismiss}>×</button></p>}
    </li>
  );
}

/** The clickable body of a card; without an action (e.g. inside the Claude app, where there is no details drawer) it is plain content. */
function Main({ className, onOpen, label, children }: { className: string; onOpen?: () => void; label: string; children: React.ReactNode }) {
  return onOpen
    ? <button className={className} onClick={onOpen} aria-label={label}>{children}</button>
    : <div className={`${className} static`}>{children}</div>;
}
