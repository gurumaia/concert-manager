import { useEffect, useRef, useState, type DragEvent } from "react";
import { uploadPhoto } from "./photos";

const hasFiles = (e: DragEvent | globalThis.DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

export type DropState = { dragging: boolean; busy: boolean; status?: string; error?: string };

/**
 * Drop image files on an element to attach them to a show. Returns the state to render and the handlers to spread on the target.
 * Uploads go one after another (each is resized in the browser first) and report progress; the server enforces the per-show limit.
 */
export function usePhotoDrop(eventId: string, onUploaded?: (count: number) => void) {
  const [state, setState] = useState<DropState>({ dragging: false, busy: false });
  const depth = useRef(0); // dragenter/dragleave also fire for children, so count them
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clear.current), []);

  const set = (s: Partial<DropState>) => setState((cur) => ({ ...cur, ...s }));

  async function upload(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const skipped = files.length - images.length;
    clearTimeout(clear.current);
    if (!images.length) { set({ error: "Only photos can be added here (JPEG, PNG or WebP).", status: undefined }); return; }
    set({ busy: true, error: undefined, status: undefined });
    let done = 0;
    const problems: string[] = [];
    for (const [i, f] of images.entries()) {
      set({ status: `Uploading ${i + 1} of ${images.length}…` });
      try { await uploadPhoto(eventId, f); done++; }
      catch (e) {
        problems.push((e as Error).message);
        if (/at most \d+ photos/.test((e as Error).message)) break; // the show is full: the rest would fail the same way
      }
    }
    if (skipped) problems.push(`${skipped} ${skipped === 1 ? "file was" : "files were"} not a photo.`);
    set({
      busy: false,
      status: done ? `Added ${done} ${done === 1 ? "photo" : "photos"}.` : undefined,
      error: problems.length ? [...new Set(problems)].join(" ") : undefined,
    });
    if (done) onUploaded?.(done);
    clear.current = setTimeout(() => set({ status: undefined }), 6000);
  }

  const handlers = {
    onDragEnter: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; set({ dragging: true }); },
    onDragOver: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; },
    onDragLeave: (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) set({ dragging: false }); },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      depth.current = 0; set({ dragging: false });
      if (state.busy) { set({ error: "Wait for the current upload to finish." }); return; }
      void upload([...e.dataTransfer.files]);
    },
  };
  return { state, handlers, dismiss: () => set({ error: undefined, status: undefined }) };
}

/** A file dropped beside a drop target would make the browser leave the app and open the image; swallow those. */
export function useBlockStrayFileDrops() {
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, []);
}
