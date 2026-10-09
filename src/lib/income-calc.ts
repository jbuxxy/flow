import type { Income, IncomeCalcMethod, PaycheckCadence } from "@prisma/client";
import { ordinal } from "@/lib/date";
import { addMonthsClamped, stepCadence } from "@/lib/cadence-step";

export type { IncomeCalcMethod };

export function paychecksPerYear(cadence: PaycheckCadence): number {
  switch (cadence) {
    case "BIWEEKLY":
      return 26;
    case "SEMI_MONTHLY":
      return 24;
    case "MONTHLY":
      return 12;
  }
}

// SEMI_MONTHLY pay lands on two fixed calendar days (1st & 15th, 15th &
// last day, 5th & 20th…), not a fixed period apart — the gaps alternate
// 14/16/17 and "+15 days" projected a phantom 3rd paycheck into any 31-day
// month starting on a payday (Oct 1, 16, 31) and drifted ~5 days earlier a
// year. These step between the household's two days instead. A day past a
// short month's end (31 in April, 30 in February) clamps to that month's
// last day, so 31 reads as "last day of the month".
export type SemiMonthlyDays = readonly number[];

function clampedDay(year: number, month: number, day: number): Date {
  // Date.UTC normalizes month overflow (month 12 → next January); day 0 of
  // the following month is this month's last day.
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last)));
}

function isValidDay(d: number) {
  return Number.isInteger(d) && d >= 1 && d <= 31;
}

// The two pay days to step between: the stored pair when it's valid,
// otherwise a pair guessed from `reference`'s own day of month — the 1st
// pairs with the 15th, a day near month-end with the 15th + last day,
// anything else with the day 15 apart. Only a defensive fallback: every
// write path stores a pair, and the migration that added the column
// backfilled one with this same rule (a guess re-made from each stepped
// date isn't stable — the 31st guesses [15, 31], the 15th then [1, 15]).
export function semiMonthlyDaysOrDefault(days: SemiMonthlyDays | null | undefined, reference: Date): [number, number] {
  const valid = [...new Set((days ?? []).filter(isValidDay))].sort((a, b) => a - b);
  if (valid.length === 2) return [valid[0], valid[1]];
  const d = reference.getUTCDate();
  if (d === 1 || d === 15 || d === 16) return [1, 15];
  if (d >= 28) return [15, 31];
  return d < 15 ? [d, d + 15] : [d - 15, d];
}

// Infers the two pay days from real deposit dates. Weekend/holiday shifts
// move a payday a few days *earlier* (the 1st can land on the prior month's
// 30th), so the two most frequent days win, ties going to the later day;
// a month's actual last day counts as 31. The second day must be at least
// 10 days from the first (around the month), or this falls back to
// semiMonthlyDaysOrDefault of the latest deposit.
export function inferSemiMonthlyDays(dates: readonly Date[]): [number, number] {
  const counts = new Map<number, number>();
  for (const date of dates) {
    const lastOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const day = date.getUTCDate() === lastOfMonth ? 31 : date.getUTCDate();
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([day]) => day);
  const first = ranked[0];
  const second = ranked.find((day) => {
    const apart = Math.abs(day - first);
    return Math.min(apart, 31 - apart) >= 10;
  });
  if (first === undefined) return [1, 15];
  if (second === undefined) return semiMonthlyDaysOrDefault(null, dates[dates.length - 1]);
  return first < second ? [first, second] : [second, first];
}

// "1st & 15th", "15th & Last Day" — the pay-day pair as UI text.
export function formatSemiMonthlyDays(days: readonly [number, number]): string {
  return days.map((d) => (d === 31 ? "Last Day" : ordinal(d))).join(" & ");
}

function nextSemiMonthly(date: Date, days: SemiMonthlyDays | null | undefined): Date {
  const [a, b] = semiMonthlyDaysOrDefault(days, date);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const candidates = [m, m + 1].flatMap((month) => [clampedDay(y, month, a), clampedDay(y, month, b)]);
  return candidates.find((c) => c.getTime() > date.getTime())!;
}

function previousSemiMonthly(date: Date, days: SemiMonthlyDays | null | undefined): Date {
  const [a, b] = semiMonthlyDaysOrDefault(days, date);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const candidates = [m, m - 1].flatMap((month) => [clampedDay(y, month, b), clampedDay(y, month, a)]);
  return candidates.find((c) => c.getTime() < date.getTime())!;
}

// Advances a projected pay date by one cadence period (SEMI_MONTHLY: to the
// next of the income's two pay days — pass Income.semiMonthlyDays). An
// off-schedule date (a hand-typed pay date, a row projected by the old
// "+15 days") snaps onto the schedule at its next step.
// MONTHLY clamps to the target month's last day (cadence-step.ts) — a raw
// setUTCMonth(+1) took a paycheck on the 31st from Jan 31 to Mar 3, so
// February never projected. A walk over several cycles passes its starting
// day as `anchorDay` so the clamp doesn't stick at the 28th.
export function addPaycheckCadence(
  date: Date,
  cadence: PaycheckCadence,
  semiMonthlyDays?: SemiMonthlyDays | null,
  anchorDay?: number,
): Date {
  if (cadence === "SEMI_MONTHLY") return nextSemiMonthly(date, semiMonthlyDays);
  if (cadence === "MONTHLY") return addMonthsClamped(date, 1, anchorDay);
  return stepCadence(date, "BIWEEKLY");
}

// The inverse step, for walking a projected pay date backward to find the
// most recent payday that's already happened (see debt-payoff.ts's
// mostRecentPaydayOnOrBefore — the payoff plan's extra-payment projection
// anchors there instead of Income.nextPayDate, so a paycheck matching during
// sync and rolling nextPayDate forward doesn't silently jump the current
// cycle's still-pending extra to next cycle). MONTHLY clamps the same way
// addPaycheckCadence does (Mar 31 back one month is Feb 28/29), and takes
// the same `anchorDay` for multi-step walks.
export function subtractPaycheckCadence(
  date: Date,
  cadence: PaycheckCadence,
  semiMonthlyDays?: SemiMonthlyDays | null,
  anchorDay?: number,
): Date {
  if (cadence === "SEMI_MONTHLY") return previousSemiMonthly(date, semiMonthlyDays);
  if (cadence === "MONTHLY") return addMonthsClamped(date, -1, anchorDay);
  return stepCadence(date, "BIWEEKLY", -1);
}

// method defaults to MONTHLY_AVERAGE (the annualized-average approach this
// always used) — every caller that shows a single income's own "/mo avg"
// (IncomeRow) wants that fixed average regardless of the household's
// setting; only the household-wide totals (getIncomeSummary) pass the
// household's actual incomeCalcMethod through.
export function monthlyEquivalentCents(
  income: Pick<Income, "amountCents" | "cadence">,
  method: IncomeCalcMethod = "MONTHLY_AVERAGE",
): number {
  if (method === "BIWEEKLY_CONSERVATIVE" && income.cadence === "BIWEEKLY") {
    return income.amountCents * 2;
  }
  return Math.round((income.amountCents * paychecksPerYear(income.cadence)) / 12);
}
