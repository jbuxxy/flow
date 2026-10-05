// One sort for every "Recurring" list — bills, debt payments, and P2P
// patterns interleaved in a single order. Both surfaces (a bucket page's
// BucketBillsSection and the household-wide /bills RecurringList) used to
// sort bills+debts together and then append patterns as their own block
// below, so a pattern due on the 1st still rendered under a bill due the
// 28th with "Due Date" selected (household report, 2026-09-30). Each caller
// maps its rows onto a RecurringSortable and sorts with sortRecurring; the
// rows' own kinds never matter here.

export type RecurringSortOrder = "dueDate" | "alphabetical";

export type RecurringSortable = {
  sortName: string;
  // Day of month (1–31) this row sorts under, or null when it has no date
  // at all (an unscheduled, windowless pattern) — those go after every
  // dated row.
  dueDay: number | null;
  // Pinned to the bottom regardless of order (a cancelled bill/pattern, and
  // on /bills a paid-off debt too — each caller decides).
  sinks: boolean;
};

// Due-date sort means "which day of the month," not the literal date —
// nextDueDate rolls forward to next month the moment a bill/payment is
// confirmed paid, so a full chronological sort would shove every
// already-paid item to the bottom instead of keeping a stable
// 1st-through-31st reading regardless of paid status. Read straight off the
// "YYYY-MM-DD" string (no Date object, so no timezone to get wrong).
export function dueDayOf(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const day = Number(isoDate.slice(8, 10));
  return Number.isFinite(day) && day > 0 ? day : null;
}

// A P2P pattern's due day: its scheduled nextDueDate when it has one (the
// date its card shows), else the start of its day-of-month match window,
// else none.
export function patternDueDay(p: { nextDueDate: string | null; dayOfMonthStart: number | null }): number | null {
  return dueDayOf(p.nextDueDate) ?? p.dayOfMonthStart ?? null;
}

export function compareRecurring(a: RecurringSortable, b: RecurringSortable, order: RecurringSortOrder): number {
  if (a.sinks !== b.sinks) return a.sinks ? 1 : -1;
  const byName = a.sortName.localeCompare(b.sortName);
  if (order === "alphabetical") return byName;
  const da = a.dueDay ?? 99;
  const db = b.dueDay ?? 99;
  return da - db || byName;
}

export function sortRecurring<T extends RecurringSortable>(items: T[], order: RecurringSortOrder): T[] {
  return [...items].sort((a, b) => compareRecurring(a, b, order));
}
