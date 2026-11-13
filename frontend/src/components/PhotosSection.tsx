import { useCallback, useEffect, useId, useRef, useState } from "react";
import { op } from "../api";
import { MAX_PHOTOS, uploadPhoto } from "../photos";
import type { EventView, PhotoView } from "../types";
import { Modal } from "./Modal";

/** Photos of a show. Mine are private until I share them; `ownerId` shows what someone else shared with me. */
export function PhotosSection({ event, ownerId, readOnly, sharedBy, scrollTo, onChange }: { event: EventView; ownerId?: string; readOnly?: boolean; /** Who shared these (heading of the read-only section). */ sharedBy?: string; /** Bring the section into view once its photos have loaded. */ scrollTo?: boolean; /** Photos were added or deleted (so counts elsewhere can refresh). */ onChange?: () => void }) {
  const heading = useId();
  const [photos, setPhotos] = useState<PhotoView[]>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number>();
  const input = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (scrollTo && photos) section.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, [scrollTo, !!photos]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    op<PhotoView[]>("list_photos", { eventId: event.id, ...(ownerId ? { ownerId } : {}) }).then(setPhotos, (e) => setError(e.message));
  }, [event.id, ownerId]);
  useEffect(load, [load]);

  const merge = (updated: PhotoView[]) => setPhotos((cur) => cur?.map((p) => updated.find((u) => u.id === p.id) ?? p));

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(undefined);
    const list = [...files].slice(0, MAX_PHOTOS - (photos?.length ?? 0));
    const failures: string[] = [];
    for (const [i, f] of list.entries()) {
      setStatus(`Uploading ${i + 1} of ${list.length}…`);
      try { const p = await uploadPhoto(event.id, f); setPhotos((cur) => [...(cur ?? []), p]); }
      catch (e) { failures.push((e as Error).message); }
    }
    if (files.length > list.length) failures.push(`A show holds at most ${MAX_PHOTOS} photos, so ${files.length - list.length} were skipped.`);
    setStatus(undefined); setBusy(false);
    if (failures.length) setError(failures.join(" "));
    if (input.current) input.current.value = "";
    if (failures.length < list.length) onChange?.();
  }

  if (!photos && !error) return null;
  if (readOnly && !photos?.length) return null;
  const mine = !readOnly;
  const full = (photos?.length ?? 0) >= MAX_PHOTOS;

  return (
    <section ref={section} aria-labelledby={heading} className="photos-section">
      <h3 id={heading}>{readOnly && sharedBy ? `Photos from ${sharedBy}` : "Photos"} {photos?.length ? <span className="muted small">{photos.length}{mine ? ` / ${MAX_PHOTOS}` : ""}</span> : null}</h3>
      {mine && <p className="muted small">{photos?.some((p) => p.sharedWith.length || p.publicUrl) ? "Only you can see photos you haven’t shared." : "Only you can see these photos. You choose who else can."}</p>}
      {photos && photos.length > 0 && (
        <ul className="photo-grid">
          {photos.map((p, i) => (
            <li key={p.id}>
              <button className="photo-tile" onClick={() => setOpen(i)} aria-label={`Open photo ${i + 1}${p.caption ? `: ${p.caption}` : ""}`}>
                <img src={p.thumbUrl} alt={p.caption ?? `Photo ${i + 1} of ${event.title}`} loading="lazy" />
                {mine && (p.publicUrl ? <span className="photo-badge" title="Public link on">Public</span> : p.sharedWith.length ? <span className="photo-badge" title={`Shared with ${p.sharedWith.join(", ")}`}>Shared</span> : null)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {mine && (
        <div className="actions">
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files)} />
          <button className="btn" disabled={busy || full} onClick={() => input.current?.click()}>{full ? "Photo limit reached" : "Add photos"}</button>
          {status && <span role="status" className="muted small">{status}</span>}
        </div>
      )}
      {mine && photos && photos.length > 0 && (
        <details className="photo-share-all">
          <summary>Share all photos</summary>
          <SharePanel eventId={event.id} targets={photos} onUpdated={merge} />
        </details>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {open !== undefined && photos?.[open] && (
        <Lightbox
          photos={photos} index={open} mine={mine} eventId={event.id}
          onIndex={setOpen} onClose={() => setOpen(undefined)} onUpdated={merge}
          onDeleted={(id) => { setPhotos((cur) => cur?.filter((p) => p.id !== id)); setOpen(undefined); onChange?.(); }}
        />
      )}
    </section>
  );
}

function Lightbox({ photos, index, mine, eventId, onIndex, onClose, onUpdated, onDeleted }: {
  photos: PhotoView[]; index: number; mine: boolean; eventId: string;
  onIndex: (i: number) => void; onClose: () => void; onUpdated: (p: PhotoView[]) => void; onDeleted: (id: string) => void;
}) {
  const p = photos[index]!;
  const [caption, setCaption] = useState(p.caption ?? "");
  const [error, setError] = useState<string>();
  useEffect(() => { setCaption(p.caption ?? ""); setError(undefined); }, [p.id, p.caption]);
  const go = (d: number) => onIndex((index + d + photos.length) % photos.length);

  async function saveCaption() {
    if ((caption.trim() || undefined) === p.caption) return;
    try { onUpdated([await op<PhotoView>("update_photo", { eventId, photoId: p.id, caption: caption.trim() || null })]); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <Modal title={`Photo ${index + 1} of ${photos.length}`} onClose={onClose} wide>
      <div className="lightbox" onKeyDown={(e) => { if (e.target instanceof HTMLInputElement) return; if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); }}>
        <div className="lightbox-stage">
          {photos.length > 1 && <button className="icon-btn nav" aria-label="Previous photo" onClick={() => go(-1)}>‹</button>}
          <img src={p.url} alt={p.caption ?? "Photo"} />
          {photos.length > 1 && <button className="icon-btn nav" aria-label="Next photo" onClick={() => go(1)}>›</button>}
        </div>
        {mine ? (
          <label>Caption
            <input value={caption} maxLength={300} onChange={(e) => setCaption(e.target.value)} onBlur={() => void saveCaption()} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </label>
        ) : p.caption ? <p>{p.caption}</p> : null}
        <p className="links"><a href={p.url} target="_blank" rel="noreferrer">Open full size</a></p>
        {mine && (
          <>
            <h4>Who can see this photo</h4>
            <SharePanel eventId={eventId} targets={[p]} onUpdated={onUpdated} />
            <div className="actions">
              <button className="btn danger" onClick={async () => {
                if (!confirm("Delete this photo for good?")) return;
                try { await op("delete_photo", { eventId, photoId: p.id }); onDeleted(p.id); } catch (e) { setError((e as Error).message); }
              }}>Delete photo</button>
            </div>
          </>
        )}
        {error && <p role="alert" className="error">{error}</p>}
      </div>
    </Modal>
  );
}

/** Visibility controls for one photo or for all of a show's photos: specific people, or a public link. */
export function SharePanel({ eventId, targets, onUpdated }: { eventId: string; targets: PhotoView[]; onUpdated: (p: PhotoView[]) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const ids = targets.map((t) => t.id);
  const everyone = [...new Set(targets.flatMap((t) => t.sharedWith))].sort();
  const onAll = (e: string) => targets.every((t) => t.sharedWith.includes(e));
  const publicCount = targets.filter((t) => t.publicUrl).length;
  const single = targets.length === 1 ? targets[0]! : undefined;

  async function run(name: string, input: Record<string, unknown>) {
    setBusy(true); setError(undefined);
    try { onUpdated(await op<PhotoView[]>(name, { eventId, photoIds: ids, ...input })); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }

  return (
    <div className="share-panel">
      <p className="muted small">{everyone.length || publicCount ? "" : "Private: only you."}</p>
      {everyone.length > 0 && (
        <ul className="chips">
          {everyone.map((e) => (
            <li key={e} className="chip">{e}{!onAll(e) ? <span className="muted small">&nbsp;(some)</span> : null}
              <button aria-label={`Stop sharing with ${e}`} className="icon-btn" disabled={busy} onClick={() => void run("unshare_photos", { emails: [e] })}>×</button>
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={async (ev) => { ev.preventDefault(); if (email && await run("share_photos", { emails: [email] })) setEmail(""); }}>
        <input type="email" aria-label="Email to share photos with" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn" disabled={busy || !email}>Share</button>
      </form>
      <label className="check">
        <input type="checkbox" checked={publicCount === targets.length} ref={(el) => { if (el) el.indeterminate = publicCount > 0 && publicCount < targets.length; }} disabled={busy}
          onChange={(e) => {
            if (e.target.checked && !confirm(`Anyone with the link will be able to see ${single ? "this photo" : "these photos"}, no sign-in needed. You can turn the link off at any time.`)) return;
            void run("set_photos_public", { enabled: e.target.checked });
          }} />
        Public link: anyone who has it can see {single ? "this photo" : "these photos"}
      </label>
      {single?.publicUrl && (
        <div className="row">
          <input readOnly aria-label="Public link" value={single.publicUrl} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn" onClick={async () => { await navigator.clipboard?.writeText(single.publicUrl!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      )}
      {!single && publicCount > 0 && <p className="muted small">Open a photo to copy its link.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
