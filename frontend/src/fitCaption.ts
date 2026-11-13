export type FittedCaption = { text: string; scale: number; cut: boolean };

const WORD = /[\p{L}\p{N}]/u;
const isWord = (t: string) => WORD.test(t);
/** Punctuation that may not end a shortened caption (a colon, dash, comma, opening bracket...). A closing bracket, quote, ! or ? may. */
const TRAILING_JUNK = /[^\p{L}\p{N})\]!?'"]+$/u;

/** Words with where they sit in the text. Anything made only of punctuation ("·", "-", "&"?) is not a word. */
function tokens(text: string) {
  return [...text.matchAll(/\S+/g)].map((m) => ({ s: m[0], start: m.index!, end: m.index! + m[0].length }));
}

/** Drops what looks bad at the end of a shortened caption: punctuation on its own or after a word, and a lone one-letter word ("Laufey: A…"). */
function tidy(text: string): string {
  let t = text.trimEnd();
  for (;;) {
    const before = t;
    t = t.replace(TRAILING_JUNK, "").trimEnd();
    const last = tokens(t).pop();
    if (last && [...last.s.replace(/[^\p{L}\p{N}]/gu, "")].length === 1 && tokens(t).length > 1) t = t.slice(0, last.start).trimEnd();
    if (t === before) return t;
  }
}

/**
 * Fits a caption on one line without cutting a word in the middle.
 * `measure` is the width of a string at the normal size; `suffix` (for example " · Sep") always stays.
 *  1. If it all fits, show it. 2. If it fits after shrinking the text a little (to `minScale`), shrink it.
 *  3. Otherwise cut at a word: work out where the text would be cut at the normal size; if at least half of that word fit, keep the whole word
 *     (and shrink to make it fit), otherwise leave it out. Then tidy the end and add "…".
 */
export function fitCaption(text: string, suffix: string, avail: number, measure: (s: string) => number, minScale = 0.72): FittedCaption {
  const full = measure(text + suffix);
  if (full <= avail) return { text, scale: 1, cut: false };
  const shrink = avail / full;
  if (shrink >= minScale) return { text, scale: Math.floor(shrink * 100) / 100, cut: false };

  // The longest start of the text that fits at the normal size, with the "…".
  let p = text.length;
  while (p > 0 && measure(text.slice(0, p).trimEnd() + "…" + suffix) > avail) p--;
  const words = tokens(text);
  const hit = words.find((w) => p > w.start && p < w.end);
  let keep: number;
  if (hit) keep = (p - hit.start) / (hit.end - hit.start) >= 0.5 ? hit.end : hit.start;
  else keep = p;

  // Round to whole words; if keeping the last word needs too much shrinking, leave it out.
  for (;;) {
    const cand = tidy(text.slice(0, keep));
    if (!cand || !isWord(cand)) break;
    const need = measure(cand + "…" + suffix);
    const scale = need <= avail ? 1 : avail / need;
    if (scale >= minScale) return { text: cand + "…", scale: Math.floor(scale * 100) / 100, cut: true };
    const last = tokens(text.slice(0, keep)).filter((w) => isWord(w.s)).pop();
    if (!last || last.start === 0) break;
    keep = last.start;
  }
  // A single very long word: cut it where it stops fitting.
  return { text: text.slice(0, p).trimEnd() + "…", scale: 1, cut: true };
}
