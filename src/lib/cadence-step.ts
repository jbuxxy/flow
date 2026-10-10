import type { BillCadence } from "@prisma/client";
import { DAY_MS } from "@/lib/date";

// The one cadence step every bill, debt-payment, paycheck and BNPL schedule
// walks with. Pure and client-safe (type-only Prisma import), so server
// modules, the payoff engine and "use client" forms all share it.
//
// There used to be four copies of this math (recurring-bills.ts addCadence,
// income-calc.ts addPaycheckCadence, cadence-label.ts addCadenceISO and
// debt-payoff.ts addBillCadence). Only the last one clamped the month: the
// other three used a raw setUTCMonth(+1), which overflows a day-29/30/31
// anchor into the month after next (Jan 31 -> Mar 3), so February vanished
// from the ledgers, calendars and matchers while the payoff projection still
// showed it (2026-10-08 review).
//
// UTC arithmetic throughout: these are `@db.Date` values, UTC midnight for a
// calendar day (src/lib/date.ts). Any time-of-day on the input is kept.


function daysInUtcMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

// `months` calendar months from `date` (negative goes back), landing on
// `anchorDay` clamped to the target month's real last day — Jan 31 + 1 is
// Feb 28/29, never Mar 3. A walk over several cycles should pass its
// starting day as `anchorDay` (or step from the start by an index): a chained
// clamp would otherwise stick at the shorter day (Jan 31 -> Feb 28 -> Mar 28).
export function addMonthsClamped(date: Date, months: number, anchorDay = date.getUTCDate()): Date {
  const timeOfDay =
    date.getTime() - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const year = first.getUTCFullYear();
  const month = first.getUTCMonth();
  return new Date(Date.UTC(year, month, Math.min(anchorDay, daysInUtcMonth(year, month))) + timeOfDay);
}

// `steps` cadence periods from `date` (negative steps go back). ANNUAL is 12
// clamped months, so a Feb 29 anchor lands on Feb 28 in a non-leap year
// rather than Mar 1.
export function stepCadence(date: Date, cadence: BillCadence, steps = 1, anchorDay?: number): Date {
  if (cadence === "MONTHLY") return addMonthsClamped(date, steps, anchorDay);
  if (cadence === "ANNUAL") return addMonthsClamped(date, 12 * steps, anchorDay);
  const days = (cadence === "BIWEEKLY" ? 14 : 7) * steps;
  return new Date(date.getTime() + days * DAY_MS);
}
