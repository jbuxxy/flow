import type { ReactNode } from "react";
import { Check } from "lucide-react";

const TONE_CLASSES = {
  blue: "bg-blue-900 dark:bg-blue-700",
  // Matches the amber/emerald "not yet tracked → track it" call-to-action
  // language elsewhere on the same row (e.g. TrackAsDebtForm) — a plain blue
  // Save there would read as an unrelated, generic action instead of
  // completing the thing the amber prompt just asked for.
  emerald: "bg-emerald-700 dark:bg-emerald-600",
};

// The right-aligned ✓ every inline "edit this row → save" form commits with.
// Non-destructive actions are compact icons; only destructive ones are
// spelled out as words (household rule, 2026-09-07). Drop it at the end of
// the form inside a `flex justify-end` row — it already brings that row
// (any error text via `children` renders to the button's left). The kebab /
// Pencil toggle right above the form carries "Cancel".
export function InlineSaveButton({
  pending,
  // A second, independent disable condition — e.g. "no bucket picked yet" —
  // that should block the submit without claiming a save is in flight (only
  // `pending` drives the "…" swap; `disabled` alone still shows the
  // checkmark, just inert).
  disabled = false,
  // Caller passes useActionToast(...).justSaved / useJustSaved(...) — flashes a
  // brief "✓ Saved" to the button's left for ~2s after a successful save (the
  // toast covers the rest; this is the reference for a row whose editor stays
  // open, matching payoff-planner's "Save Plan" confirmation).
  justSaved = false,
  tone = "blue",
  className = "",
  children,
}: {
  pending: boolean;
  disabled?: boolean;
  justSaved?: boolean;
  tone?: keyof typeof TONE_CLASSES;
  className?: string;
  // Rendered to the button's left — e.g. a form-level error message.
  children?: ReactNode;
}) {
  return (
    <div className={`flex items-center justify-end gap-3 ${className}`}>
      {children}
      {justSaved && (
        <span className="flex items-center gap-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <Check size={16} /> Saved
        </span>
      )}
      <button
        type="submit"
        disabled={pending || disabled}
        aria-label="Save"
        title="Save"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white disabled:opacity-50 ${TONE_CLASSES[tone]}`}
      >
        {pending ? <span aria-hidden>…</span> : <Check size={15} />}
      </button>
    </div>
  );
}
