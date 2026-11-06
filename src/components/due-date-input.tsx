"use client";

// The one due-date field for bills and debt payments (2026-11-06) — a plain
// calendar date, replacing DayOfMonthPicker for every due date. A bare
// day-of-month couldn't express a first payment more than a month out (a new
// HELOC first due Dec 30) and made every already-passed day ambiguous between
// "this cycle" and "next cycle". DayOfMonthPicker stays for genuinely
// day-of-month schedules (semi-monthly pay days).
//
// Submits as `nextDueDate` (YYYY-MM-DD) by default — see parseDateInput.
export function DueDateInput({
  value,
  onChange,
  name = "nextDueDate",
  label = "Next Due Date",
  required = false,
  small = false,
  unconfirmed = false,
}: {
  value: string; // YYYY-MM-DD, or "" for none picked
  onChange: (value: string) => void;
  name?: string;
  label?: React.ReactNode;
  required?: boolean;
  /** Matches dense inline-edit rows (text-xs). */
  small?: boolean;
  /** Red-tints the field while the due date is still unconfirmed (a card
   *  showing the red "needs attention" dot) — clears once the form saves. */
  unconfirmed?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
      {label}
      <input
        name={name}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className={`mt-1 block w-full min-w-0 appearance-none rounded-lg border px-2 focus:outline-none ${
          small ? "h-[38px] py-1.5 text-xs" : "py-2 text-sm"
        } ${
          unconfirmed
            ? "border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/30 focus:border-red-500"
            : "border-neutral-300 dark:border-neutral-700 focus:border-blue-900"
        }`}
      />
    </label>
  );
}
