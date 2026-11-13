import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "../reviewFont.css";
import { fitCaption, type FittedCaption } from "../fitCaption";
import { preload } from "../preload";
import { PHOTO_MS, buildDeck, SLIDESHOW_AHEAD, firstScreenImages, slideDuration, slideImages, type Count, type Pic, type Slide } from "../review";
import type { ReviewData } from "../types";

const TICK_MS = 100;
/** Holding a finger (or the mouse) this long on the screen pauses the story, like tapping the pause button. */
const HOLD_MS = 350;
const TILTS = [-4, 3, -2, 5, -5, 2];
const tilt = (i: number) => TILTS[i % TILTS.length]!;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const isYear = (range: string) => /^\d{4}$/.test(range);
const PAPER = "#f3eadb";
// Starts loading the handwriting as soon as the story's code arrives, before the first slide asks for it.
if (typeof document !== "undefined") void document.fonts?.load?.('1em "Architects Daughter"');
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The tap-through story (Spotify Wrapped style, scrapbook look): vertical, one slide at a time.
 * Slides advance on their own; pausing is sticky until the play button is pressed. Tap the left third to go back, the rest to go on.
 * The same component shows the owner's preview and the public page.
 */
export function ReviewStory({ data, onClose, today, fullscreenOnStart }: { data: ReviewData; onClose?: () => void; today?: string; fullscreenOnStart?: boolean }) {
  const slides = useMemo(() => buildDeck(data, today), [data, today]);
  const [index, setIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(reducedMotion);
  const root = useRef<HTMLDivElement>(null);
  const last = slides.length - 1;
  const slide = slides[Math.min(index, last)];

  // The clock lives in a ref so the interval never runs side effects inside a state updater.
  const clock = useRef(0);
  const setClock = useCallback((ms: number) => { clock.current = ms; setElapsed(ms); }, []);
  const go = useCallback((i: number) => { setIndex(Math.max(0, Math.min(last, i))); setClock(0); }, [last, setClock]);

  // The clock: counts up while playing, moves on at the end of a slide, and stops on the last one.
  useEffect(() => {
    if (paused || !slide) return;
    const t = setInterval(() => {
      const next = clock.current + TICK_MS;
      if (next < slideDuration(slide)) setClock(next);
      else if (index < last) go(index + 1);
      else setClock(slideDuration(slide));
    }, TICK_MS);
    return () => clearInterval(t);
  }, [paused, slide, index, last, go, setClock]);

  useEffect(() => { root.current?.focus(); }, []);

  // Full screen (not available on iPhone Safari, where the button is simply not shown). It also tints the browser bar like the paper while the story is open.
  const canFullscreen = typeof document !== "undefined" && !!document.fullscreenEnabled;
  const [full, setFull] = useState(false);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  useEffect(() => { if (fullscreenOnStart && canFullscreen) void root.current?.requestFullscreen?.().catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); }, []);
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "theme-color"; meta.content = PAPER;
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  // Hold to pause: it stays paused until play is pressed (same as the button). The tap that ends a hold must not also change slide.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const startHold = () => { held.current = false; clearTimeout(holdTimer.current); holdTimer.current = setTimeout(() => { held.current = true; setPaused(true); }, HOLD_MS); };
  const endHold = () => clearTimeout(holdTimer.current);
  useEffect(() => endHold, []);
  const tapProps = (onTap: () => void) => ({
    onPointerDown: startHold, onPointerUp: endHold, onPointerLeave: endHold, onPointerCancel: endHold,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(), // a long press on a phone must not open the browser's menu
    onClick: () => { if (held.current) { held.current = false; return; } onTap(); },
  });

  // Load ahead: the next photos of the slideshow that is playing, and everything each of the next two slides shows when it appears.
  const here = slide && (slide.kind === "best" || slide.kind === "gallery") && slide.pics.length > 1 ? Math.min(slide.pics.length - 1, Math.floor(elapsed / PHOTO_MS)) : 0;
  useEffect(() => {
    if (!slide) return;
    if (slide.kind === "best" || slide.kind === "gallery") preload(slideImages(slide).slice(here + 1, here + 1 + SLIDESHOW_AHEAD));
    for (const next of slides.slice(index + 1, index + 3)) preload(firstScreenImages(next));
  }, [slides, slide, index, here]);

  if (!slide) return <p className="muted">Nothing to show yet.</p>;
  const pics = slide.kind === "best" || slide.kind === "gallery" ? slide.pics : [];
  const photoIdx = pics.length > 1 ? Math.min(pics.length - 1, Math.floor(elapsed / PHOTO_MS)) : 0;
  const showPhoto = (i: number) => setClock(Math.max(0, Math.min(pics.length - 1, i)) * PHOTO_MS);
  const pct = Math.min(100, (elapsed / slideDuration(slide)) * 100);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === " " && e.target === e.currentTarget) { e.preventDefault(); setPaused((p) => !p); }
    else if (e.key === "Escape" && onClose) onClose();
  };

  return (
    <div className="rv" ref={root} tabIndex={-1} onKeyDown={onKey} role="region" aria-label="Year in review">
      <div className="rv-bars" aria-hidden="true">
        {slides.map((_, i) => <i key={i} className={i < index ? "on" : i === index ? "cur" : ""}>{i === index && <b style={{ width: `${pct}%` }} />}</i>)}
      </div>
      <p className="rv-sr" aria-live="polite">Slide {index + 1} of {slides.length}</p>
      <div className="rv-top">
        <span className="rv-who">{[data.owner, rangeOf(slides)].filter(Boolean).join(" · ")}</span>
        <span className="rv-ctl">
          <button className="rv-round" onClick={() => setPaused(!paused)} aria-label={paused ? "Play" : "Pause"} aria-pressed={paused}>
            {paused
              ? <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
              : <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>}
          </button>
          {canFullscreen && (
            <button className="rv-round" onClick={toggleFull} aria-label={full ? "Exit full screen" : "Full screen"} aria-pressed={full}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
              </svg>
            </button>
          )}
          {onClose && <button className="rv-round" onClick={onClose} aria-label="Close"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>}
        </span>
      </div>
      <button className="rv-tap rv-tap-prev" {...tapProps(() => go(index - 1))} aria-label="Previous slide" tabIndex={-1} />
      <button className="rv-tap rv-tap-next" {...tapProps(() => go(index + 1))} aria-label="Next slide" tabIndex={-1} />
      <div className="rv-slide" key={index}>
        <SlideView slide={slide} photoIdx={photoIdx} onPhoto={showPhoto} />
      </div>
    </div>
  );
}

const rangeOf = (slides: Slide[]) => { const i = slides[0]; return i?.kind === "intro" ? i.range : ""; };

function SlideView({ slide, photoIdx, onPhoto }: { slide: Slide; photoIdx: number; onPhoto: (i: number) => void }) {
  switch (slide.kind) {
    case "intro": {
      const where = [slide.venues ? plural(slide.venues, "venue") : "", slide.cities ? plural(slide.cities, "city", "cities") : ""].filter(Boolean).join(" & ");
      return (
        <Page>
          <h2 className="rv-hand rv-lead">{slide.people.length ? `With ${list(slide.people)}, you went to` : isYear(slide.range) ? `In ${slide.range} you went to` : `${slide.range}: you went to`}</h2>
          <div className="rv-big rv-red" aria-label={plural(slide.count, "show")}>{slide.count}</div>
          <p className="rv-hand rv-line">{slide.count === 1 ? "show." : "shows."}{slide.every ? ` That's one every ${plural(slide.every, "day")}.` : ""}</p>
          {where && <Note rot={-3}>across {where}</Note>}
          <Stamp>{isYear(slide.range) ? slide.range : "REWIND"}</Stamp>
        </Page>
      );
    }
    case "months": {
      const max = Math.max(...slide.byMonth);
      return (
        <Page>
          <h2 className="rv-hand rv-lead">Your busiest month was</h2>
          <div className="rv-word rv-red">{slide.best}</div>
          <Note rot={2}>{plural(slide.count, "show")}</Note>
          <div className="rv-chart" aria-hidden="true">
            {slide.byMonth.map((n, i) => (
              <span key={i} className={n === max ? "hi" : ""}><i style={{ height: `${Math.max(4, (n / max) * 100)}%` }} />{"JFMAMJJASOND"[i]}</span>
            ))}
          </div>
        </Page>
      );
    }
    case "collage":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">Best nights, in pictures</h2>
          <div className={`rv-collage n${slide.pics.length}`}>
            {slide.pics.map((p, i) => <Polaroid key={p.id} pic={p} src={p.thumbUrl} rot={tilt(i)} />)}
          </div>
          {slide.more > 0 && <p className="rv-hand rv-faint">+ {plural(slide.more, "more photo")}</p>}
        </Page>
      );
    case "artists":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">The ones you couldn't stop seeing</h2>
          <Ranking top={slide.top} unit="show" />
          {slide.pic && <Polaroid pic={slide.pic} src={slide.pic.thumbUrl} rot={4} small />}
        </Page>
      );
    case "genres":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">Your sound this time</h2>
          <div className="rv-stickers">
            {slide.top.map((g, i) => <span key={g.name} className={`rv-sticker s${i}`} style={{ transform: `rotate(${tilt(i + 1)}deg)` }}>{g.name}<small>{plural(g.count, "show")}</small></span>)}
          </div>
        </Page>
      );
    case "venue":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">You kept coming back to</h2>
          <div className="rv-word">{slide.name}</div>
          <Note rot={-2}><b>{slide.count}</b>nights there</Note>
          {slide.withCompany > 0 && <Note rot={3} pink><b>{slide.withCompany}</b>with company</Note>}
          {slide.pic && <Polaroid pic={slide.pic} src={slide.pic.thumbUrl} rot={-4} small />}
          <Stamp left>MOST VISITED</Stamp>
        </Page>
      );
    case "people":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">Your partners in crime</h2>
          <Ranking top={slide.top} unit="show" />
        </Page>
      );
    case "best":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">Your highest score<br /><span className="rv-red">{slide.score} · {slide.title}</span></h2>
          {slide.pics.length ? <Slideshow pics={slide.pics} idx={photoIdx} onPhoto={onPhoto} /> : <><Note rot={-2}><b>{slide.score}</b>out of 10</Note><Stamp>TOP SCORE</Stamp></>}
          <p className="rv-hand rv-faint">{slide.when}{slide.venue ? ` · ${slide.venue}` : ""}</p>
        </Page>
      );
    case "song":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">You caught this one live</h2>
          <div className="rv-word rv-song">{slide.name}</div>
          <p className="rv-hand rv-line">by <strong>{slide.act}</strong></p>
          <Note rot={2}><b>{slide.count}</b>different nights</Note>
        </Page>
      );
    case "gallery":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">Moments you kept</h2>
          <Slideshow pics={slide.pics} idx={photoIdx} onPhoto={onPhoto} />
        </Page>
      );
    case "bookends":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">It started with</h2>
          <Note rot={-2}><strong>{slide.first.title}</strong>{slide.first.when}</Note>
          <h2 className="rv-hand rv-lead">and the last one was</h2>
          <Note rot={3} pink><strong>{slide.last.title}</strong>{slide.last.when}</Note>
        </Page>
      );
    case "outro":
      return (
        <Page>
          <h2 className="rv-hand rv-lead">That's a wrap</h2>
          <div className="rv-word rv-red">{slide.range}</div>
          <p className="rv-hand rv-line">{plural(slide.count, "show")}{slide.photos ? ` · ${plural(slide.photos, "photo")}` : ""}</p>
          <Stamp>SEE YOU NEXT YEAR</Stamp>
        </Page>
      );
  }
}

const Page = ({ children }: { children: ReactNode }) => <div className="rv-page">{children}</div>;
const Note = ({ children, rot, pink }: { children: ReactNode; rot: number; pink?: boolean }) => (
  <div className={`rv-note rv-hand${pink ? " pink" : ""}`} style={{ transform: `rotate(${rot}deg)` }}>{children}</div>
);
const Stamp = ({ children, left }: { children: ReactNode; left?: boolean }) => <div className={`rv-stamp${left ? " left" : ""}`} aria-hidden="true">{children}</div>;

function Ranking({ top, unit }: { top: Count[]; unit: string }) {
  return (
    <ol className="rv-rank">
      {top.map((t, i) => (
        <li key={t.name} className="rv-note rv-hand" style={{ transform: `rotate(${tilt(i)}deg)` }}>
          <b>{i + 1}</b><span>{t.name}<small>{plural(t.count, unit)}</small></span>
        </li>
      ))}
    </ol>
  );
}

/** `tail` is what follows the show's name in the caption, such as " · 3 / 12" in a slideshow. A caption typed on the photo is shown as it is. */
function Polaroid({ pic, src, rot, small, tail = "" }: { pic: Pic; src: string; rot: number; small?: boolean; tail?: string }) {
  const [broken, setBroken] = useState(false);
  const base = pic.caption ?? pic.title ?? pic.label;
  const suffix = pic.caption ? "" : `${pic.title && pic.month ? ` · ${pic.month}` : ""}${tail}`;
  return (
    <figure className={`rv-pol${small ? " small" : ""}`} style={{ "--rot": `${rot}deg` } as CSSProperties}>
      <span className="rv-tape" aria-hidden="true" />
      {broken ? <div className="rv-pic-missing" /> : <img src={src} alt={base + suffix} decoding="async" draggable={false} onError={() => setBroken(true)} />}
      <FitLine text={base} suffix={suffix} />
    </figure>
  );
}

let canvas: CanvasRenderingContext2D | null | undefined;
const measurer = (): CanvasRenderingContext2D | null => {
  if (canvas === undefined) { try { canvas = document.createElement("canvas").getContext("2d"); } catch { canvas = null; } }
  return canvas;
};

/**
 * A one-line caption that never cuts a word in half: it shrinks a little to fit, or ends at a whole word with "…" (see fitCaption).
 * Measured with the real font and the real width, again whenever either changes. Without a canvas (old browsers, tests) the plain CSS ellipsis applies.
 */
function FitLine({ text, suffix }: { text: string; suffix: string }) {
  const el = useRef<HTMLElement>(null);
  const [fit, setFit] = useState<FittedCaption>();
  useLayoutEffect(() => {
    const node = el.current;
    const ctx = measurer();
    if (!node || !ctx) return;
    const run = () => {
      const cs = getComputedStyle(node);
      const width = node.clientWidth;
      if (!width) return;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      setFit(fitCaption(text, suffix, width, (s) => ctx.measureText(s).width));
    };
    run();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(run) : undefined;
    ro?.observe(node);
    void document.fonts?.ready.then(run);
    return () => ro?.disconnect();
  }, [text, suffix]);
  return <figcaption ref={el} className="rv-hand" style={fit && fit.scale < 1 ? { fontSize: `calc(5cqw * ${fit.scale})` } : undefined}>{(fit?.text ?? text) + suffix}</figcaption>;
}

/** One photo at a time with previous/next arrows and dots. It keeps moving on its own until paused. */
function Slideshow({ pics, idx, onPhoto }: { pics: Pic[]; idx: number; onPhoto: (i: number) => void }) {
  const pic = pics[idx]!;
  return (
    <div className="rv-show">
      <Polaroid key={pic.id} pic={pic} src={pic.url} rot={tilt(idx)} tail={pics.length > 1 ? ` · ${idx + 1} / ${pics.length}` : ""} />
      {pics.length > 1 && (
        <div className="rv-nav">
          <button className="rv-round light" onClick={() => onPhoto(idx - 1)} disabled={idx === 0} aria-label="Previous photo">‹</button>
          <span aria-hidden="true">{pics.map((p, i) => <i key={p.id} className={i === idx ? "on" : ""} />)}</span>
          <button className="rv-round light" onClick={() => onPhoto(idx + 1)} disabled={idx === pics.length - 1} aria-label="Next photo">›</button>
        </div>
      )}
    </div>
  );
}
