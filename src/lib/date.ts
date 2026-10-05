// A "@db.Date" field (or any value that only ever means a calendar day, no
// time-of-day — occurredOn, asOfDate, a due/payoff date) is stored as UTC
// midnight. Formatting it with the viewer's local timezone can shift the
// displayed day by one near a day boundary — and in a "use client"
// component, that shift can differ between the server render (this app's
// container runs TZ=America/Denver) and client hydration (browsers default
// to UTC), which React reports as a hydration mismatch. Anchoring to UTC
// keeps the displayed calendar date always matching what was actually
// stored, on both server and client alike.
export function formatDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString("en-US", { ...options, ...twoDigitDay(options), timeZone: "UTC" });
}

// House style: day-of-month is always two digits ("Sep 03", not "Sep 3"), so a
// column of dates stays vertically aligned. Callers keep passing the natural
// `day: "numeric"`; this quietly upgrades it wherever a date runs through
// formatDate / formatISODate.
function twoDigitDay(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return options.day === "numeric" ? { day: "2-digit" } : {};
}

// Same UTC anchoring as formatDate, for a value that arrives as a bare
// "YYYY-MM-DD" (or full-ISO) string rather than a Date — `new Date(iso)`
// parses it to UTC midnight, so formatting without timeZone:"UTC" shifts the
// displayed day by one for any viewer west of UTC (and mismatches between
// the TZ=America/Denver server render and a UTC client). Use this anywhere a
// stored calendar-day string is shown.
export function formatISODate(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleDateString("en-US", { ...options, ...twoDigitDay(options), timeZone: "UTC" });
}

// "Today" as a `@db.Date`-style value: the viewer's (or server's) current
// *local* calendar day, re-anchored to UTC midnight so it lines up with every
// stored `@db.Date` field and reads back correctly through getUTC* getters.
// Use this instead of a bare `new Date()` anywhere the value feeds
// calendar-day math — month bucketing, an "is this in the current month"
// check, a CycleCalendarView `monthDate`. A raw `new Date()` instant read via
// getUTC* is a calendar day (and, at a month edge, a whole month) ahead for
// any viewer west of UTC in their own evening, which repeatedly put
// payoff-calendar rows under the wrong month header — the /debts "next month"
// grid rendering the current month, empty, and the dashboard calendar
// dropping this month's real payments (2026-08-31).
export function todayAsUTCDate(now = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

// "3rd", "21st" — for a due date's day-of-month (e.g. "Due on the 3rd").
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// A monthly-recurring due date (card/loan minimum, most bills) only really
// needs a day-of-month from a household — picking a full mm/dd/yyyy every
// time is needless precision that reads as more decision than it is
// (2026-08-17). This resolves a chosen day into the actual next occurrence:
// this calendar month if that day hasn't passed yet, otherwise next month.
// "Has it passed" is judged in the household's own local calendar day (see
// period.ts's identical reasoning — the server runs TZ=America/Denver), but
// the returned Date is UTC midnight for that day, matching how every other
// `@db.Date` field in this app is stored (see formatDate's doc comment
// above). Clamps to the shorter month's real last day instead of
// overflowing into the next one (the 31st picked in a 30-day month lands on
// the 30th, not May 1st).
export function nextOccurrenceOfDay(day: number, now = new Date()): Date {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = now.getDate();
  const daysInThisMonth = new Date(y, m + 1, 0).getDate();
  const clampedThisMonth = Math.min(day, daysInThisMonth);
  if (clampedThisMonth >= today) return new Date(Date.UTC(y, m, clampedThisMonth));
  const daysInNextMonth = new Date(y, m + 2, 0).getDate();
  return new Date(Date.UTC(y, m + 1, Math.min(day, daysInNextMonth)));
}

// The current calendar month's occurrence of `day` (local month, clamped to
// its real length), as UTC midnight — nextOccurrenceOfDay without the
// roll-forward. For confirming an *existing* bill/payment's due date while
// its current cycle is still unpaid: rolling to next month there silently
// skips a real, now-overdue cycle, dropping the bill off every "this month"
// surface and making its row read "Paid <stale date>" via BillRow's
// future-month heuristic (2026-08-30 Fairview Water Improvement District
// incident).
export function currentMonthOccurrenceOfDay(day: number, now = new Date()): Date {
  const y = now.getFullYear();
  const m = now.getMonth();
  const daysInThisMonth = new Date(y, m + 1, 0).getDate();
  return new Date(Date.UTC(y, m, Math.min(day, daysInThisMonth)));
}

// Shared day-math for a "how far away is this date" badge — BillRow's
// dueStatus and IncomeRow's expectedStatus both computed the identical
// `Math.round((date - today) / 86_400_000)` split into the same 4 buckets
// (overdue / today / within a week / further out), differing only in copy
// and color. Callers supply both so e.g. an overdue bill can read as a red
// warning while a late paycheck (nobody's fault) reads as amber.
export function dayCountStatus(
  targetDate: Date,
  copy: { overdue: (daysAgo: number) => string; today: string; upcoming: (daysUntil: number) => string; later: (date: Date) => string },
  colors: { overdue: string; today: string; upcoming: string; later: string },
): { label: string; className: string } {
  // targetDate is a `@db.Date` (UTC midnight for its calendar day); anchor
  // "today" the same way — `new Date()` + setHours(0,0,0,0) is *local*
  // midnight, ~7h off a UTC-midnight target here (TZ=America/Denver), which
  // Math.round could tip to the wrong day ("Due in 6 days" vs 7).
  const today = todayAsUTCDate();
  const daysUntil = Math.round((targetDate.getTime() - today.getTime()) / 86_400_000);

  if (daysUntil < 0) return { label: copy.overdue(-daysUntil), className: colors.overdue };
  if (daysUntil === 0) return { label: copy.today, className: colors.today };
  if (daysUntil <= 7) return { label: copy.upcoming(daysUntil), className: colors.upcoming };
  return { label: copy.later(targetDate), className: colors.later };
}

// IncomeRow's "Expected in N days" badge. A plain function here (not in
// income-row.tsx, a "use client" file) so income/page.tsx — a Server
// Component — can call it directly while building each row's props; a
// Server Component may only ever render a client module's Component
// exports, never call a plain function from one directly (Next.js throws
// "Attempted to call X() from the server but X is on the client" if you
// try). Computing it server-side also sidesteps a real hydration risk: a
// client component re-running this against `new Date()` during hydration
// could land on a different calendar day than the server did (household
// runs on TZ=America/Denver; a viewer's browser can be on any TZ), especially
// right around the UTC date rollover.
export function expectedStatus(nextPayDate: Date | null): { label: string; className: string } | null {
  if (!nextPayDate) return null;
  return dayCountStatus(
    nextPayDate,
    {
      overdue: (daysAgo) => `Expected ${daysAgo} Day${daysAgo === 1 ? "" : "s"} Ago`,
      today: "Expected Today",
      upcoming: (daysUntil) => `Expected in ${daysUntil} Day${daysUntil === 1 ? "" : "s"}`,
      later: (date) => `Not Expected Until ${formatDate(date, { month: "short", day: "numeric" })}`,
    },
    {
      overdue: "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400",
      today: "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400",
      upcoming: "bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300",
      later: "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300",
    },
  );
}

// BillRow's "Due in N days" pill. A plain function here, not in bill-row.tsx
// (a "use client" file) — see expectedStatus's comment just above for why a
// Server Component (bills/page.tsx, buckets/[id]/page.tsx) can't call a
// plain function exported from a client module directly, and why computing
// "today" server-side is also the more correct behavior regardless.
export function dueStatus(nextDueDate: string): { label: string; className: string } {
  return dayCountStatus(
    new Date(nextDueDate),
    {
      overdue: (daysAgo) => `Overdue by ${daysAgo} day${daysAgo === 1 ? "" : "s"}`,
      today: "Due today",
      upcoming: (daysUntil) => `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
      later: (date) => `Not due until ${formatDate(date, { month: "short", day: "numeric" })}`,
    },
    {
      overdue: "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400",
      today: "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400",
      upcoming: "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400",
      later: "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300",
    },
  );
}

// Text-only sibling of bill-row.tsx's `dueStatus` (which returns pill
// background classes for the /bills page). Same 4-bucket day math as
// dayCountStatus — overdue / due today / due within a week / later — but
// mapped to plain text colours for a bare "Sep 3" date in a unified
// entry row (EntryLine, src/components/entry-line.tsx), with the relative
// "Due in N days" phrasing carried as the tooltip. Used on the bucket-page
// bill/debt rows and the /debts payoff ledger.
export function dueDateProximity(targetDate: Date): { label: string; textClassName: string } {
  const today = todayAsUTCDate();
  const daysUntil = Math.round((targetDate.getTime() - today.getTime()) / 86_400_000);
  if (daysUntil < 0) {
    return {
      label: `Overdue by ${-daysUntil} day${daysUntil === -1 ? "" : "s"}`,
      textClassName: "text-red-700 dark:text-red-400",
    };
  }
  if (daysUntil === 0) return { label: "Due today", textClassName: "text-amber-700 dark:text-amber-400" };
  if (daysUntil <= 7) {
    return {
      label: `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
      textClassName: "text-amber-700 dark:text-amber-400",
    };
  }
  return {
    label: `Not due until ${formatDate(targetDate, { month: "short", day: "numeric" })}`,
    textClassName: "text-neutral-600 dark:text-neutral-400",
  };
}

// The day-of-month a stored "YYYY-MM-DD" due date falls on, for pre-filling
// a day-of-month picker — getUTCDate, not getDate, since the string always
// parses to UTC midnight (see formatDate's doc comment above); a
// local-timezone getter here would read the wrong day for a server ever
// east of UTC.
export function dayOfMonthUTC(isoDate: string): number {
  return new Date(isoDate).getUTCDate();
}
