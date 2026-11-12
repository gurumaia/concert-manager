import { useEffect, useState } from "react";

/**
 * 0-10 in 0.5 steps: a slider for quick picks and a number box for exact or keyboard entry. null = not rated yet (distinct from 0).
 * `name` makes the controls unambiguous when several are on screen (one per act); `compact` is the row used inside the lineup.
 */
export function ScoreControl({ value, onChange, name, compact }: { value: number | null; onChange: (v: number | null) => void; name?: string; compact?: boolean }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => { setText(value === null ? "" : String(value)); }, [value]);
  const commit = (t: string) => {
    if (t.trim() === "") return onChange(null);
    const x = Math.round(Number(t.replace(",", ".")) * 2) / 2;
    if (Number.isFinite(x)) onChange(Math.min(10, Math.max(0, x)));
    else setText(value === null ? "" : String(value));
  };
  const of = name ? `${name}: ` : "";
  return (
    <div className="row score-row">
      <input type="range" min={0} max={10} step={0.5} aria-label={`${of}Score slider`} value={value ?? 0} className={value === null ? "unrated" : ""}
        onChange={(e) => onChange(Number(e.target.value))} />
      <input inputMode="decimal" className="score-num" aria-label={`${of}Score, 0 to 10`} placeholder="–" value={text}
        onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(text); } }} />
      {!compact && <span className="muted small">/ 10</span>}
      {compact
        // The slot stays reserved when there is nothing to clear, so rows with and without a score line up.
        ? <button type="button" className="icon-btn" aria-label={`Clear score for ${name}`} onClick={() => onChange(null)}
            style={value === null ? { visibility: "hidden" } : undefined} disabled={value === null} tabIndex={value === null ? -1 : undefined} aria-hidden={value === null || undefined}>×</button>
        : value !== null && <button type="button" className="btn small" onClick={() => onChange(null)}>Clear</button>}
    </div>
  );
}

/** The whole-show score with its heading. Changes are saved by the caller as they happen. */
export function ScoreInput({ value, onChange, label = "How was it?" }: { value: number | null; onChange: (v: number | null) => void; label?: string }) {
  return (
    <fieldset className="score">
      <legend>{label}</legend>
      <ScoreControl value={value} onChange={onChange} />
    </fieldset>
  );
}
