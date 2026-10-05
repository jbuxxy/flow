// The grace window a payment can land within (either side) of an expected
// due/pay date and still count as that cycle's — shared by matchBillPayments
// (recurring-bills.ts) and matchIncomePayments (income.ts) on the server,
// and by bill-row.tsx on the client for its own "does this look like the
// same cycle" heuristics. Kept in its own leaf module (no `db` import, so
// it's safe for client code) — this constant used to be hand-copied into
// all three files separately (bill-row.tsx's own copy carried a "keep both
// in sync if this ever changes" comment), the same shape of duplication
// budgetTrackedWhere had before its own 2026-09-11 extraction into
// budget-tracked.ts.
export const MATCH_WINDOW_DAYS = 3;

const DAY_MS = 86_400_000;

// The one real search window a "catch up one cycle at a time" matcher walks
// against — shared by matchBillPayments (recurring-bills.ts),
// matchPatternPayments (pattern-payments.ts), and matchIncomePayments
// (income.ts). All three used to hand-copy this exact formula (real finding,
// 2026-09-12 code review: income.ts's copy was missing the widening step
// entirely, letting a late paycheck strand its schedule forever while the
// functionally identical late-bill/late-pattern case widened correctly one
// file over — the very drift this kind of triplication invites).
//
// Tight (`cycleDueDate` +/- matchWindowDays) while a cycle isn't due yet or
// is only recently due; widens up to `now` once the cycle is overdue, so a
// payment that posts more than matchWindowDays late still gets found —
// capped just short of the *next* cycle's own window so an overdue search
// can never bleed into a later cycle's territory (recurring-bills.ts's own
// 2026-08-14 incident this capping exists to prevent). Returns null when
// this cycle isn't due yet even under the loose widening — the caller's
// signal to stop walking rather than guess ahead to a later cycle.
export function catchupCycleWindow(
  cycleDueDate: Date,
  nextCycleDueDate: Date,
  now: Date,
  matchWindowDays: number = MATCH_WINDOW_DAYS,
): { windowStart: Date; windowEnd: Date } | null {
  const windowStart = new Date(cycleDueDate.getTime() - matchWindowDays * DAY_MS);
  const cappedEnd = new Date(nextCycleDueDate.getTime() - matchWindowDays * DAY_MS - 1);
  const uncappedEnd = cycleDueDate < now ? now : new Date(cycleDueDate.getTime() + matchWindowDays * DAY_MS);
  const windowEnd = new Date(Math.min(uncappedEnd.getTime(), cappedEnd.getTime()));
  return windowEnd < windowStart ? null : { windowStart, windowEnd };
}

// A stuck tracker's cycle date can sit behind its own already-recorded
// "paid through" marker with nothing left to search for (its one qualifying
// transaction is already linked to a past cycle) — the normal candidate-
// search loop would never find a reason to advance past it on its own. Walks
// the cadence forward with pure date math (no DB), capped at maxCycles, same
// self-heal shape matchBillPayments (recurring-bills.ts), matchPatternPayments
// (pattern-payments.ts), and matchIncomePayments (income.ts) each hand-copied
// as their own loop — extracted here (2026-09-22 code review) so it has one
// regression test instead of three untested copies, same reasoning that
// already pulled catchupCycleWindow out of all three above.
export function fastForwardCycleDate(
  cycleDate: Date,
  paidThroughMs: number,
  maxCycles: number,
  advance: (date: Date) => Date,
): Date {
  let next = cycleDate;
  for (let i = 0; i < maxCycles && next.getTime() <= paidThroughMs; i++) {
    next = advance(next);
  }
  return next;
}
