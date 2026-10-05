"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

// Thin wrapper over the native <dialog> element — gets focus trapping,
// Escape-to-close, and a real backdrop for free instead of hand-rolling
// them. `open` is a prop (not just mount/unmount) so callers can animate
// state transitions around it if they ever want to; this version just
// shows/hides synchronously.
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // `hidden open:flex` (not a bare `flex`) is load-bearing: an
      // unconditional `display` utility on <dialog> is an author-origin
      // rule, which beats the UA stylesheet's `dialog:not([open]) {
      // display: none }` regardless of specificity (author always wins
      // over user-agent for equal importance) — that silently broke the
      // close state entirely (the dialog stayed visible, positioned by the
      // browser's plain non-modal `position: absolute` fallback instead of
      // `dialog:modal`'s `position: fixed` centering, since it was never
      // actually opened via showModal()). Scoping our own display to the
      // `open:` variant keeps us in charge of the open case while leaving
      // UA rules in control of hiding it when closed.
      className="m-auto hidden max-h-[85dvh] w-[calc(100%-2rem)] max-w-sm open:flex flex-col overflow-hidden rounded-2xl border border-blue-100 dark:border-neutral-800 bg-[var(--background)] p-5 text-neutral-900 dark:text-neutral-100 backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-blue-900 dark:text-blue-300">{title}</h2>
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="text-neutral-400 dark:text-neutral-500 transition-transform hover:rotate-90 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          <X size={18} />
        </button>
      </div>
      <div className="mt-3 -mr-3 overflow-y-auto overflow-x-hidden pr-3">{children}</div>
    </dialog>
  );
}
