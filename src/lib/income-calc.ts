import type { Income, IncomeCalcMethod, PaycheckCadence } from "@prisma/client";

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

// Advances a projected pay date by one cadence period. SEMI_MONTHLY has no
// single fixed period (real-world semi-monthly pay alternates ~15/~16 days
// around fixed calendar anchors like the 1st & 15th) — +15 days matches the
// same approximation classifyCadence in income-detect.ts already uses to
// *identify* a semi-monthly cadence, so detection and projection agree.
// UTC setters, not local — see addCadence's comment in recurring-bills.ts;
// same `@db.Date` convention, same off-by-a-day-at-a-month-boundary bug a
// local setter would reintroduce.
export function addPaycheckCadence(date: Date, cadence: PaycheckCadence): Date {
  const d = new Date(date);
  if (cadence === "MONTHLY") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "SEMI_MONTHLY") d.setUTCDate(d.getUTCDate() + 15);
  else d.setUTCDate(d.getUTCDate() + 14); // BIWEEKLY
  return d;
}

// The inverse step, for walking a projected pay date backward to find the
// most recent payday that's already happened (see debt-payoff.ts's
// mostRecentPaydayOnOrBefore — the payoff plan's extra-payment projection
// anchors there instead of Income.nextPayDate, so a paycheck matching during
// sync and rolling nextPayDate forward doesn't silently jump the current
// cycle's still-pending extra to next cycle). Not a perfect inverse of
// addPaycheckCadence at a MONTHLY/SEMI_MONTHLY month-end (e.g. Mar 31 minus
// "1 month" via setUTCMonth lands on Mar 3, not Feb 28/29) — safe here
// because the caller always walks back from a real, stable day-of-month
// Income.nextPayDate and forward-reconciles any overshoot.
export function subtractPaycheckCadence(date: Date, cadence: PaycheckCadence): Date {
  const d = new Date(date);
  if (cadence === "MONTHLY") d.setUTCMonth(d.getUTCMonth() - 1);
  else if (cadence === "SEMI_MONTHLY") d.setUTCDate(d.getUTCDate() - 15);
  else d.setUTCDate(d.getUTCDate() - 14); // BIWEEKLY
  return d;
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
