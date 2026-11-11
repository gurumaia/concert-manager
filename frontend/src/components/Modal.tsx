import { useEffect, useRef, type ReactNode } from "react";

/** Native <dialog>: focus trap, Esc to close and inert background come for free. */
export function Modal({ title, onClose, children, wide, actions }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="modal-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="modal-body">
        <header className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <div className="modal-head-actions">
            {actions}
            <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>
        {children}
      </div>
    </dialog>
  );
}
