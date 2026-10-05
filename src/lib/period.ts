// All budget periods are calendar months, evaluated in the household's local
// time (the deployed container's TZ) — pace math ("it's the 10th and you're
// already at 70%") only makes sense against the household's own clock.

export function currentPeriodKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// The "YYYY-MM" period a stored @db.Date value (always UTC midnight for its
// calendar day — occurredOn, nextDueDate, lastPaidDate, ...) falls in. Local
// getters (currentPeriodKey's default param shape) are correct for "now"
// (an instant, correctly read via the household's local clock) but wrong
// for one of these: reading occurredOn's UTC-midnight day through a
// getFullYear()/getMonth() pair re-interprets it in the server's TZ, which
// walks a 1st-of-the-month value back into the *previous* month for any
// household west of UTC (2026-09-11 incident: budget-plan.ts was grouping
// history by calling currentPeriodKey(t.occurredOn) directly). UTC getters
// on an already-UTC-midnight value need no such re-interpretation.
export function periodKeyOfUTCDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// "YYYY-MM-DD" in the household's local time — local getFullYear/getMonth/
// getDate, not toISOString (which is UTC and would land on the wrong day
// for anything after ~6pm local, since the server runs TZ=America/Denver,
// behind UTC). Used by NetWorthSnapshot to key one row per calendar day.
export function currentDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function periodBounds(periodKey: string): { start: Date; end: Date } {
  const [y, m] = periodKey.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1); // exclusive
  return { start, end };
}

// UTC calendar-month bounds for the given "YYYY-MM" period key — deliberately
// separate from periodBounds (local time, for filtering Transaction.occurredOn)
// because nextDueDate/lastPaidDate are `@db.Date` columns, always UTC midnight
// for their calendar day — comparing one against a local-time boundary
// misclassifies dates right at a month edge. Use this whenever "this cycle"
// needs to be intersected against a RecurringBill/DebtPayment's own due-date
// fields, not a Transaction's occurredOn.
export function utcPeriodBounds(periodKey: string): { start: Date; end: Date } {
  const [y, m] = periodKey.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

// Fraction of the current month elapsed, e.g. day 10 of 30 -> 0.33.
export function monthElapsedFraction(date = new Date()): number {
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const dayOfMonth = date.getDate();
  return Math.min(dayOfMonth / daysInMonth, 1);
}

// N days before now — factored out so callers (server components in
// particular) never call Date.now()/new Date() directly in a render body,
// which trips the react-hooks/purity lint rule.
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// Calendar week, Sunday through Saturday. The *weekday* is taken from the
// household's local time (getDay — "what day of the week is it here"), but
// the bounds are UTC-midnight Dates, same as utcPeriodBounds: every field
// this is ever compared against — nextDueDate / lastPaidDate / paidOffDate /
// paycheckDate / occurredOn — is a `@db.Date` column (UTC midnight for its
// calendar day), so local-midnight bounds were ~7h late here (TZ=America/
// Denver), dropping a bill due on the week's opening Sunday and pulling in
// the following Sunday's. `end` is exclusive (the following Sunday).
export function currentWeekBounds(date = new Date()): { start: Date; end: Date } {
  const sundayOffset = date.getDate() - date.getDay();
  const start = new Date(Date.UTC(date.getFullYear(), date.getMonth(), sundayOffset));
  const end = new Date(Date.UTC(date.getFullYear(), date.getMonth(), sundayOffset + 7));
  return { start, end };
}

// "YYYY-MM-DD" of the current week's Sunday — dedup key for GoalReminder/
// GoalInsight, same role currentDateKey plays for NetWorthSnapshot. Reads
// `start` (now a UTC-midnight Date, see currentWeekBounds) with UTC getters,
// not currentDateKey's local ones, so the key names the actual Sunday.
export function currentWeekKey(date = new Date()): string {
  const { start } = currentWeekBounds(date);
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, "0");
  const d = String(start.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
