"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { ordinal } from "@/lib/date";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

// A calendar-grid day-of-month picker — 7 columns like a real month view,
// but month/year-agnostic (see nextOccurrenceOfDay's doc comment) so there's
// no navigation, just 31 tappable cells. Trigger + outside-click-to-close
// pattern mirrors SelectField (src/components/select-field.tsx), which this
// replaces for every recurring due-date field (2026-08-17) — a household
// asked for something that reads as "pick a day" at a glance rather than a
// filtered text list.
//
// `label` is rendered *inside* this component as a `<label htmlFor>` sibling
// of the trigger button, deliberately not left for the caller to wrap
// around it — every call site used to do `<label>Due date<DayOfMonthPicker
// /></label>`, which put the whole 31-cell popover inside the `<label>`'s
// DOM subtree. Per the HTML spec, clicking anywhere inside a `<label>`
// (including a nested day button, not just the caption text) also sends a
// synthetic click to the label's first labelable descendant — the trigger
// `<button>` — the instant the real click finishes. SelectField's trigger
// is an `<input>`, where a forwarded click just refocuses it (harmless),
// which is why that same wrapping pattern never showed this bug there. For
// a `<button>` trigger, that synthetic click re-toggled `open` right back
// open on every single day pick — confirmed via `event.isTrusted === false`
// on the phantom second click. Keeping the label a DOM *sibling* of the
// popover (not an ancestor) avoids the forwarding entirely.
export function DayOfMonthPicker({
  value,
  onChange,
  name,
  label,
  placeholder = "Day of Month",
  small = false,
  large = false,
  className = "",
  unconfirmed = false,
  lastDayLabel = false,
}: {
  value: string; // "1".."31", or "" for none picked
  onChange: (value: string) => void;
  name?: string;
  /** Caption text, e.g. "Due date" — omit for a standalone picker with no caption. */
  label?: string;
  placeholder?: string;
  /** Matches dense inline-edit rows (text-xs, e.g. bill-row.tsx's edit form). */
  small?: boolean;
  /** Matches top-level "Add X" forms (text-base py-2.5, e.g. add-debt-form.tsx's other fields). */
  large?: boolean;
  className?: string;
  /** Red-tints the trigger while the due date is still unconfirmed (a card
   *  showing the red "needs attention" dot) — clears once the form saves. */
  unconfirmed?: boolean;
  /** Shows 31 as "Last Day" — for schedules where 31 means "the last day of
   *  whatever month it is" (Income.semiMonthlyDays). */
  lastDayLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();

  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown — see the identical fix/comment on
    // SelectField's own outside-click listener (select-field.tsx).
    function onPointerDownOutside(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDownOutside);
    return () => document.removeEventListener("pointerdown", onPointerDownOutside);
  }, [open]);

  // Explicit height on the default size — same fix, same reasoning, as
  // SelectField's own triggerCls (see its comment): this trigger is a
  // `<button>`, and a row mixing it with sibling `<input>`-based fields
  // (MoneyInput, PercentInput, a raw `<input type="date">`) needs a pinned
  // height to actually line up, not just matching Tailwind classes.
  const triggerCls = small
    ? "text-xs py-1.5 pl-2 pr-7"
    : large
      ? "text-base py-2.5 pl-3 pr-9"
      : "h-[38px] text-sm py-2 pl-2 pr-7";

  const control = (
    <div className={`relative ${label ? "mt-1" : ""} ${className}`} ref={containerRef}>
      <button
        id={triggerId}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`relative w-full rounded-lg border text-left ${triggerCls} focus:outline-none ${
          unconfirmed
            ? "border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/30 focus:border-red-500"
            : "border-neutral-300 dark:border-neutral-700 focus:border-blue-900"
        }`}
      >
        {value ? (
          lastDayLabel && value === "31" ? (
            "Last Day"
          ) : (
            ordinal(Number(value))
          )
        ) : (
          <span className="text-gray-400 dark:text-neutral-500">{placeholder}</span>
        )}
        <CalendarDays
          size={small ? 12 : large ? 16 : 14}
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-neutral-400 ${large ? "right-3" : "right-2"}`}
        />
      </button>
      {name && <input type="hidden" name={name} value={value} />}

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-2 shadow-lg">
          <div className="grid grid-cols-7 gap-1">
            {DAYS.map((day) => (
              <button
                key={day}
                type="button"
                onClick={() => {
                  onChange(String(day));
                  setOpen(false);
                }}
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs ${
                  String(day) === value
                    ? "bg-blue-900 dark:bg-blue-700 font-medium text-white"
                    : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (!label) return control;
  return (
    <div className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
      <label htmlFor={triggerId}>{label}</label>
      {control}
    </div>
  );
}
