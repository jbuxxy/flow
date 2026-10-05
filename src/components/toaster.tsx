"use client";

import { Check, CircleAlert, Info } from "lucide-react";
import { dismissToast, useToasts, type ToastTone } from "@/lib/toast";

// Tones map onto the app's existing palette — emerald for "done" (same as
// InlineSaveButton's emerald tone), red for failure (RowActions' danger red),
// blue for neutral info. The icon is a redundant, non-colour cue.
const TONE: Record<ToastTone, { className: string; Icon: typeof Check }> = {
  success: { className: "bg-emerald-700 dark:bg-emerald-600", Icon: Check },
  error: { className: "bg-red-600", Icon: CircleAlert },
  info: { className: "bg-blue-900 dark:bg-blue-700", Icon: Info },
};

// Always-mounted fixed live region — renders empty (and announces nothing)
// until showToast() pushes something. Sits above page chrome + the PWA banner
// (--z-toast) but below open dropdowns so a toast firing mid-selection can't
// swallow an option list. Entrance reuses .animate-fade-in-up (already gated
// off under prefers-reduced-motion in globals.css); there's no exit animation,
// the toast just unmounts — matches this repo's zero-animation-runtime rule.
export function Toaster() {
  const toasts = useToasts();

  return (
    <div
      aria-live="polite"
      role="status"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)_+_4.25rem)] z-[var(--z-toast)] flex flex-col items-center gap-2 px-4 lg:bottom-6"
    >
      {toasts.map((t) => {
        const { className, Icon } = TONE[t.tone];
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label={`Dismiss: ${t.title}`}
            className={`animate-fade-in-up pointer-events-auto flex w-fit max-w-sm items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg ${className}`}
          >
            <Icon size={15} aria-hidden />
            {t.title}
          </button>
        );
      })}
    </div>
  );
}
