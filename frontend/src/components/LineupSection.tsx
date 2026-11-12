import type { CSSProperties } from "react";
import { genreHue } from "../format";
import type { EventView } from "../types";
import { useShowScores, type SaveState } from "../useShowScores";
import { ScoreControl } from "./ScoreInput";

const ROLE: Record<string, string> = { headliner: "Headliner", support: "Support", opener: "Opener", guest: "Guest" };
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";

/**
 * The bill, one row per act (initial, role, set time), and for a show you attended a score per act plus one for the whole night.
 * Scores save as you move them. With a single act (or none) there is just the one score, "How was it?".
 */
export function LineupSection({ event, readOnly, onSaved }: { event: EventView; readOnly?: boolean; onSaved?: () => void }) {
  const lineup = event.lineup ?? [];
  const canScore = !readOnly && !!event.past && event.rsvp?.status === "going";
  const sc = useShowScores(event.id, event.rsvp, onSaved);
  const several = lineup.length > 1;
  if (!lineup.length && !canScore) return null;
  const shared = readOnly ? event.rsvp?.actScores : undefined;

  return (
    <section aria-labelledby="lineup-h" className="lineup">
      {(lineup.length > 0 || canScore) && <h3 id="lineup-h">{lineup.length ? "Lineup" : "Your score"}</h3>}
      {lineup.length > 0 && (
        <ul className="lineup-list">
          {lineup.map((a, i) => {
            const value = sc.acts[a.name] ?? null;
            return (
              <li key={`${a.name}-${i}`} className={`lineup-row${canScore && several ? " scored" : ""}`}>
                <span className="lineup-av" aria-hidden="true" style={{ "--h": genreHue(a.name) } as CSSProperties}>{initial(a.name)}</span>
                <span className="lineup-who">
                  {a.role && <span className="role">{ROLE[a.role] ?? a.role}</span>}
                  <span className="nm">{a.name}</span>
                  {a.startTime && <span className="muted small">{a.startTime}</span>}
                </span>
                {canScore && several && <ScoreControl compact name={a.name} value={value} onChange={(v) => sc.setActScore(a.name, v)} />}
                {shared?.[a.name] !== undefined && <span className="tag" aria-label={`Score ${shared[a.name]} out of 10`}>★ {shared[a.name]}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {canScore && (
        <div className={`lineup-total${several ? "" : " alone"}`}>
          <b id="overall-h">{several ? "Whole night" : "How was it?"}</b>
          <ScoreControl compact={several} name={several ? "Whole night" : undefined} value={sc.score} onChange={sc.setScore} />
        </div>
      )}
      {canScore && <SaveNote state={sc.state} error={sc.error} onRetry={sc.retry} hasScore={sc.score !== null || Object.keys(sc.acts).length > 0} />}
    </section>
  );
}

export function SaveNote({ state, error, onRetry, hasScore }: { state: SaveState; error?: string; onRetry: () => void; hasScore: boolean }) {
  if (state === "error") {
    return <p role="alert" className="error small">Couldn’t save: {error}. <button className="btn small" onClick={onRetry}>Try again</button></p>;
  }
  return (
    <p role="status" aria-live="polite" className="muted small save-note">
      {state === "saving" ? "Saving…" : state === "saved" ? <><span className="ok">✓</span> Saved automatically</> : hasScore ? "Scores save automatically." : "Not rated yet. Drag a slider or type a number in 0.5 steps."}
    </p>
  );
}
