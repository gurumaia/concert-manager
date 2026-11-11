import { useState, type CSSProperties } from "react";

export type GenreOption = {
  key: string;
  label: string;
  hue: number;
  /** Shows with this genre in the current view (tab, search and venue applied). */
  count: number;
};

const VISIBLE = 8;

/**
 * Genre filter: quiet outlined chips with a colour dot; a selected chip fills with its genre colour so the active filter reads
 * at a glance. Several can be selected (a show matches if it has any of them). Selected chips are never hidden by "+N more".
 */
export function GenreChips({ genres, selected, onToggle, onClear }: {
  genres: GenreOption[]; selected: Set<string>; onToggle: (key: string) => void; onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!genres.length) return null;
  const shown = expanded ? genres : genres.filter((g, i) => i < VISIBLE || selected.has(g.key));
  const hidden = genres.length - shown.length;

  return (
    <div className="gchips" role="group" aria-label="Filter by genre">
      <span className="gchips-label" aria-hidden="true">Genre</span>
      <button className="gchip all" aria-pressed={selected.size === 0} onClick={onClear}>All genres</button>
      {shown.map((g) => (
        <button
          key={g.key}
          className={`gchip${g.count === 0 ? " zero" : ""}`}
          style={{ "--h": g.hue } as CSSProperties}
          aria-pressed={selected.has(g.key)}
          aria-label={`${g.label}, ${g.count} ${g.count === 1 ? "show" : "shows"} here`}
          onClick={() => onToggle(g.key)}
        >
          {g.label}<span className="n" aria-hidden="true">{g.count}</span>
        </button>
      ))}
      {hidden > 0 && <button className="gchip more" onClick={() => setExpanded(true)}>+{hidden} more</button>}
      {expanded && genres.length > VISIBLE && <button className="gchip more" onClick={() => setExpanded(false)}>Show fewer</button>}
    </div>
  );
}
