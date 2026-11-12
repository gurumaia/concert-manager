import { useCallback, useEffect, useRef, useState } from "react";
import { op } from "./api";
import type { Rsvp } from "./types";

export type SaveState = "idle" | "saving" | "saved" | "error";
type Patch = { score?: number | null; actScores?: Record<string, number | null> };
const DELAY_MS = 500;

/**
 * The scores of a show (overall and per act), saved in the background as they change: edits are batched for half a second,
 * only one request is in flight at a time, and the newest value always wins. Pending edits are sent when the view closes.
 */
export function useShowScores(eventId: string, rsvp: Rsvp | null | undefined, onSaved?: () => void) {
  const [score, setScoreState] = useState<number | null>(rsvp?.score ?? null);
  const [acts, setActs] = useState<Record<string, number>>(rsvp?.actScores ?? {});
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string>();
  const pending = useRef<Patch>({});
  const failed = useRef<Patch>({});
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const has = () => Object.keys(pending.current).length > 0;
  const merge = (into: Patch, from: Patch) => {
    if ("score" in from) into.score = from.score;
    if (from.actScores) into.actScores = { ...into.actScores, ...from.actScores };
  };

  const run = useCallback(async () => {
    if (running.current) return; // the running loop picks up whatever arrived meanwhile
    running.current = true;
    try {
      while (has()) {
        const patch = pending.current;
        pending.current = {};
        if (mounted.current) setState("saving");
        try {
          await op("set_scores", { eventId, ...patch });
          failed.current = {};
          if (mounted.current && !has()) setState("saved");
          onSavedRef.current?.();
        } catch (e) {
          merge(failed.current, patch);
          if (mounted.current) { setState("error"); setError((e as Error).message); }
          return;
        }
      }
    } finally { running.current = false; }
  }, [eventId]);

  const queue = (patch: Patch) => {
    merge(pending.current, patch);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), DELAY_MS);
  };

  const setScore = (v: number | null) => { setScoreState(v); queue({ score: v }); };
  const setActScore = (name: string, v: number | null) => {
    setActs((cur) => { const next = { ...cur }; if (v === null) delete next[name]; else next[name] = v; return next; });
    queue({ actScores: { [name]: v } });
  };
  const retry = () => { merge(pending.current, failed.current); failed.current = {}; void run(); };

  // Follow the show when it changes elsewhere (the RSVP was changed, or reloaded), unless edits are still on their way.
  const actsKey = JSON.stringify(rsvp?.actScores ?? {});
  useEffect(() => {
    if (has() || running.current) return;
    setScoreState(rsvp?.score ?? null);
    setActs(rsvp?.actScores ?? {});
  }, [rsvp?.score, actsKey, rsvp?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); if (has()) void run(); };
  }, [run]);

  return { score, acts, state, error, setScore, setActScore, retry };
}
