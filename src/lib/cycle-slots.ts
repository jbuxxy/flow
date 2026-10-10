import type { BillCadence } from "@prisma/client";
import { stepCadence } from "@/lib/cadence-step";
import { MATCH_WINDOW_DAYS } from "@/lib/bill-match-window";
import { DAY_MS } from "@/lib/date";


// Pure cadence<->calendar-month math, shared by every "This cycle" ledger
// display (RecurringBill/DebtPayment alike) — no `db` import, so it's safe
// for both server components and (if ever needed) client code. Consolidates
// what used to be two independent copies: buckets.ts's private
// occurrencesInPeriod (Date-based, fed pace math only) and
// debt-payment-row.tsx's ISO-string reimplementation (expectedDatesInMonth,
// gated to WEEKLY/BIWEEKLY only). Neither was actually cadence-specific
// internally — the gating happened at each call site — so one shared,
// cadence-agnostic version covers every cadence.

// Every occurrence of a bill/debt-payment's cadence that lands inside
// [periodStart, periodEnd) — usually exactly one for MONTHLY, sometimes
// several for WEEKLY/BIWEEKLY, or zero most periods for ANNUAL. Walks
// outward from nextDueDate (the next *unpaid* occurrence) rather than
// assuming it's the only occurrence relevant to the current period:
// nextDueDate rolls into the *next* period the moment this one's bill is
// confirmed paid, so the backward walk is what still finds "this period's,
// now paid" occurrence.
export function occurrencesInPeriod(nextDueDate: Date, cadence: BillCadence, periodStart: Date, periodEnd: Date): Date[] {
  const dates: Date[] = [];
  // Safety net, not expected to trigger in practice — nextDueDate is kept
  // fresh by matchBillPayments/matchDebtPayments — but caps the walk for a
  // long-neglected WEEKLY item rather than looping unbounded.
  // Every date is i steps from nextDueDate, not a chain of single steps, so
  // a month-end clamp (Jan 31 -> Feb 28) doesn't stick at the 28th.
  const MAX_STEPS = 60;
  let d = nextDueDate;
  for (let i = 1; i <= MAX_STEPS && d >= periodStart; i++) {
    if (d < periodEnd) dates.unshift(d);
    d = stepCadence(nextDueDate, cadence, -i);
  }
  d = stepCadence(nextDueDate, cadence, 1);
  for (let i = 2; i <= MAX_STEPS + 1 && d < periodEnd; i++) {
    // A stale nextDueDate before the period walks forward through dates
    // that are still before periodStart — those aren't in the period.
    if (d >= periodStart) dates.push(d);
    d = stepCadence(nextDueDate, cadence, i);
  }
  return dates;
}

// Pairs expected occurrence dates against real payments positionally, not by
// closest-date matching — a payment matching engine (matchDebtPayments/
// matchBillPayments) always links in date order, so the Nth real payment
// this period IS the Nth expected slot. Anything beyond the expected count
// is a genuine extra (paid ahead of schedule), not a mismatch to reconcile.
export function assignPaymentsToSlots<T extends { occurredOn: Date }>(
  dates: Date[],
  paymentsInPeriod: T[],
): { date: Date; payment: T | null }[] {
  const sorted = [...paymentsInPeriod].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
  return dates.map((date, i) => ({ date, payment: sorted[i] ?? null }));
}

export type SlotBounds = {
  // Hard floor on the occurrence walk — an occurrence before this genuinely
  // never existed, so buildCycleSlots won't reconstruct one at all.
  occurrenceStart: Date;
  // Soft floor — occurrences before this *did* exist, but an *unpaid* one is
  // a phantom "overdue" line we shouldn't nag about (the tracker just wasn't
  // watching yet). A *paid* pre-cutoff occurrence stays: its linked payment
  // proves the obligation was real, and reads as "Minimum … — paid".
  hideUnpaidBefore?: Date;
  // Hard ceiling on the occurrence walk — an INSTALLMENT/BNPL plan has a
  // *finite* number of payments left; there is no occurrence after the last
  // scheduled installment (nextDueDate + (installmentsRemaining - 1) cadences).
  // Without it, occurrencesInPeriod walks forward from nextDueDate forever and
  // a plan with one payment left still shows a phantom "next" installment (real
  // report, 2026-09-03: Affirm–Dick's, 1 payment left due Sep 15, also showed
  // an unpaid Sep 29). Undefined for a REVOLVING plan (it bills indefinitely).
  occurrenceEnd?: Date;
};

// How far back buildCycleSlots should look for one tracker, given when it
// really started watching:
//   - INSTALLMENT (BNPL): the plan did not exist before its purchase date, so
//     a pre-purchase occurrence is pure phantom — a hard floor. (A mid-month
//     purchase otherwise projects a phantom occurrence one cadence back that
//     steals the real payment positionally.)
//   - REVOLVING card/loan: the debt and its payment schedule existed and were
//     running long before the tracker row got auto-created on first sync —
//     its occurrences are real. Only an *unpaid* occurrence from before the
//     row existed is a phantom (a hand-added debt whose first due date is
//     next month). A real payment linked to a pre-createdAt occurrence is
//     genuine history — a mortgage/auto-loan payment that posted a few days
//     before first sync — and should read "Minimum … — paid", not vanish
//     (household report, 2026-08-30: Home/Voyager/Amazon payments hidden).
export function slotBounds(
  monthStart: Date,
  opts: {
    debtType?: string | null;
    purchaseDate?: Date | null;
    trackerCreatedAt?: Date | null;
    // INSTALLMENT only — the plan's own tracker state, used to bound the
    // occurrence walk on both ends:
    //  - an un-started plan (no payment matched yet, lastPaidDate null) has no
    //    occurrence before its first installment, which is nextDueDate itself
    //    — floor there, not at the purchase date (a plan bought Sep 3 whose
    //    first payment is Oct 3 must not project a phantom Sep 3 line).
    //  - the series ends after `installmentsRemaining` more payments — ceiling
    //    at nextDueDate + (installmentsRemaining - 1) cadences.
    cadence?: BillCadence | null;
    nextDueDate?: Date | null;
    lastPaidDate?: Date | null;
    installmentsRemaining?: number | null;
    // REVOLVING only — DebtPayment.cycleRestartDueDate: a paid-off card that
    // regained a balance owes nothing before its restarted cycle's first due
    // date, so no occurrence (open, paid or covered) is walked before it.
    cycleRestartDueDate?: Date | null;
  },
): SlotBounds {
  if (opts.debtType === "INSTALLMENT") {
    const floors = [monthStart];
    if (opts.purchaseDate) floors.push(opts.purchaseDate);
    if (opts.lastPaidDate == null && opts.nextDueDate) floors.push(opts.nextDueDate);
    const occurrenceStart = new Date(Math.max(...floors.map((d) => d.getTime())));

    let occurrenceEnd: Date | undefined;
    if (opts.nextDueDate && opts.cadence && opts.installmentsRemaining != null) {
      // Walk from the cycle *before* nextDueDate so `installmentsRemaining: 1`
      // lands exactly on nextDueDate and `0` lands before it (nothing left).
      occurrenceEnd = stepCadence(opts.nextDueDate, opts.cadence, Math.max(0, opts.installmentsRemaining) - 1);
    }
    return { occurrenceStart, occurrenceEnd };
  }
  return {
    occurrenceStart:
      opts.cycleRestartDueDate && opts.cycleRestartDueDate > monthStart ? opts.cycleRestartDueDate : monthStart,
    hideUnpaidBefore:
      opts.trackerCreatedAt && opts.trackerCreatedAt > monthStart ? opts.trackerCreatedAt : undefined,
  };
}

// Every expected occurrence this period (oldest first, one slot each) paired
// positionally against real payments landing in the same period; whatever's
// left over past the expected count comes back separately as extraPayments,
// so a ledger reads "Minimum … — paid <date>" then one "· Extra" line per
// payment after it.
//
// `bounds` (see slotBounds): `occurrenceStart` hard-limits the backward walk;
// `hideUnpaidBefore` then drops any still-open slot before that cutoff (a
// phantom pre-tracker "overdue" line) while keeping paid ones. Defaults to
// walking from `periodStart` with nothing hidden.
export function buildCycleSlots<T extends { occurredOn: Date }>(
  nextDueDate: Date,
  cadence: BillCadence,
  periodStart: Date,
  periodEnd: Date,
  allPayments: T[],
  bounds?: SlotBounds,
): { slots: { date: Date; payment: T | null }[]; extraPayments: T[] } {
  const occStart = bounds?.occurrenceStart ?? periodStart;
  let occurrences = occurrencesInPeriod(nextDueDate, cadence, occStart, periodEnd);
  if (bounds?.occurrenceEnd) {
    const end = bounds.occurrenceEnd;
    occurrences = occurrences.filter((d) => d <= end);
  }

  // A bill/debt payment can legitimately post up to MATCH_WINDOW_DAYS after
  // its own due date (matchBillPayments/matchDebtPayments' own grace window,
  // bill-match-window.ts) — for an occurrence that lands within that many
  // days of a calendar-month boundary, its real payment crosses into the
  // *next* month, and plain calendar bounding then double-counts that one
  // payment: once (correctly) for the occurrence it actually paid, and again
  // for the following period's own untouched occurrence, since the payment's
  // calendar date happens to fall in that month's window too. Real household
  // report, 2026-09-25: Cedar Creek Irrigation is due the 30th but its charge
  // reliably posts the 1st-3rd, so every month's row read "paid" off a
  // payment that had already satisfied the *previous* month.
  //
  // The fix reattaches a boundary-adjacent payment to the occurrence it
  // actually satisfies (near periodStart, excluding it here in favor of the
  // prior period's own call; near periodEnd, including it here even though
  // its date is technically next month) instead of trusting calendar date
  // alone — narrowly, only within MATCH_WINDOW_DAYS of the boundary, so an
  // ordinary payment safely in the middle of its own month (e.g. a genuine
  // early/duplicate payment toward an upcoming, not-yet-due cycle) is
  // untouched — see the "genuine second payment this same month" test.
  const graceMs = MATCH_WINDOW_DAYS * DAY_MS;
  const priorOccurrence = occurrences.length > 0 ? stepCadence(occurrences[0], cadence, -1) : null;
  const lastOccurrence = occurrences.length > 0 ? occurrences[occurrences.length - 1] : null;
  const priorLeakCutoffMs = priorOccurrence ? priorOccurrence.getTime() + graceMs : null;
  const forwardLeakCutoffMs = lastOccurrence ? lastOccurrence.getTime() + graceMs : null;

  const inPeriod = [...allPayments]
    .filter((p) => {
      const t = p.occurredOn.getTime();
      if (t >= periodStart.getTime() && t < periodEnd.getTime()) {
        const leaksToPriorPeriod = priorLeakCutoffMs != null && priorLeakCutoffMs >= periodStart.getTime() && t <= priorLeakCutoffMs;
        return !leaksToPriorPeriod;
      }
      return forwardLeakCutoffMs != null && t >= periodEnd.getTime() && t <= forwardLeakCutoffMs;
    })
    .sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
  let slots = assignPaymentsToSlots(occurrences, inPeriod);
  if (bounds?.hideUnpaidBefore) {
    const cutoff = bounds.hideUnpaidBefore;
    slots = slots.filter((s) => s.payment !== null || s.date >= cutoff);
  }
  const consumed = slots.filter((s) => s.payment !== null).length;
  return { slots, extraPayments: inPeriod.slice(consumed) };
}

// The single "is this cycle paid, and which real payments belong to it"
// primitive every RecurringBill/RecurringPattern row should read from,
// instead of each re-deriving its own answer from nextDueDate/lastPaidDate
// with a client-side date-comparison heuristic (bill-row.tsx's
// paidOnSchedule/stuckCyclePaid, and pattern-row.tsx's now-identical copy —
// see WORKING_ON.md for the real household reports that heuristic got wrong
// twice, months apart, once per row type). Calendar-month-bounded matching
// (buildCycleSlots) sidesteps almost the whole class of bug: a payment that
// landed in a *different* month never counts as "this cycle's," with no
// separate "has nextDueDate rolled over yet" question to get wrong — this is
// exactly the primitive DebtPaymentRow/DebtRow have used from the start
// (debts/page.tsx, bills/page.tsx's debtPaymentCards) and were never
// vulnerable to that bug class as a result. The one deliberate exception is
// the narrow MATCH_WINDOW_DAYS boundary reattachment inside buildCycleSlots
// itself (see its own comment) — for an occurrence within a few days of
// periodStart/periodEnd, "which month did the payment land in" and "which
// cycle did it pay" can disagree, and the latter is what a household
// actually wants to see.
export function cyclePaymentStatus<T extends { amountCents: number; occurredOn: Date }>(
  nextDueDate: Date,
  cadence: BillCadence,
  allPayments: T[],
  periodStart: Date,
  periodEnd: Date,
  bounds?: SlotBounds,
): { cyclePaid: boolean; currentCyclePayments: T[] } {
  const { slots, extraPayments } = buildCycleSlots(nextDueDate, cadence, periodStart, periodEnd, allPayments, bounds);
  // Vacuously true when nothing's expected this period at all (an ANNUAL
  // bill due a different month, or every occurrence filtered out as a
  // phantom pre-tracker one via hideUnpaidBefore) — same convention
  // debts/page.tsx's CycleMinimum.paidThisCycle already uses.
  const cyclePaid = slots.every((s) => s.payment !== null);
  const currentCyclePayments = [...slots.flatMap((s) => (s.payment ? [s.payment] : [])), ...extraPayments].sort(
    (a, b) => a.occurredOn.getTime() - b.occurredOn.getTime(),
  );
  return { cyclePaid, currentCyclePayments };
}

// buildCycleSlots' own `extraPayments` only ever catches a *whole extra
// payment* beyond the expected occurrence count — never the case for a debt
// that just closed out this same period, where the one payment that paid it
// off matches its one slot exactly, so buildCycleSlots itself sees nothing
// "extra" there at all, even though there's no ongoing minimum left to
// preserve accounting for once the debt is done. Once that's true, treat
// every real payment landing in the period as extra, not just what spilled
// past the slot count — the entire closing payment, not the sliver one
// slot's own minimum couldn't absorb.
//
// Shared by src/lib/debt-payments.ts's correctedDueDateByDebtId (dashboard/
// ICS feed) and debts/page.tsx's own identical need (feeding the payoff
// planner's client-side simulation) — real case, 2026-09-06: fixing this
// logic in the first of those two and not the second left them disagreeing
// about Quicksilver's payoff, one correct and one still re-cascading the
// stale figure onto the next debt in priority order. One implementation
// here means that can't happen again.
export function extraPaymentsBeyondSlots<T extends { amountCents: number; occurredOn: Date }>(
  slotExtraPayments: T[],
  allPaymentsAbs: T[],
  periodStart: Date,
  periodEnd: Date,
  opts: {
    paidOffDate?: Date | null;
    // A no-minimum debt has nothing for buildCycleSlots' one expected
    // occurrence to legitimately "consume" — there's no real minimum being
    // preserved by treating the chronologically-first payment as the slot
    // fill, so every payment this period is extra unconditionally, not just
    // once paidOffDate happens to land in this period. (paidOffDate itself
    // gets nulled the moment a debt's balance goes positive again, so a
    // no-minimum debt that pays off and is then restored mid-period — a real
    // purchase after a payoff — can't rely on that flag anyway; real report,
    // 2026-09-14: Sam's Club Card.)
    tracksMinimum: boolean;
  },
): T[] {
  if (!opts.tracksMinimum) return allPaymentsAbs.filter((p) => p.occurredOn >= periodStart && p.occurredOn < periodEnd);
  const paidOffThisPeriod =
    !!opts.paidOffDate && opts.paidOffDate >= periodStart && opts.paidOffDate < periodEnd;
  if (!paidOffThisPeriod) return slotExtraPayments;
  return allPaymentsAbs.filter((p) => p.occurredOn >= periodStart && p.occurredOn < periodEnd);
}

// A payment that is the payoff plan's own extra for a payday — not a
// minimum. buildCycleSlots pairs payments to minimum slots positionally, so
// an extra paid the day after payday (and before the minimum's due date)
// used to fill the minimum slot: the minimum read "paid," the extra read
// "still owed," and every view that nets the plan against real money showed
// the extra twice (real report, 2026-10-03: Amazon Card's Oct 1 $108.33
// extra, paid Oct 2, sat in the Oct 10 minimum slot). A payment is claimed as
// a plan extra when it lands within [payday − 1 day, payday + 6 days] of one
// of this debt's planned extras (PayoffExtraSnapshot) and within
// max($10, 15%) of its amount — the plan's own number, give or take a
// rollover cent or a fee. Each planned extra claims at most one payment,
// earliest first; everything unclaimed goes through the normal slot pairing.
const PLAN_EXTRA_LEAD_MS = 1 * 86_400_000;
const PLAN_EXTRA_LAG_MS = 6 * 86_400_000;

export function splitPlanExtraPayments<T extends { amountCents: number; occurredOn: Date }>(
  payments: T[],
  planExtras: { date: Date; amountCents: number }[],
): { planExtraPayments: T[]; rest: T[] } {
  if (planExtras.length === 0) return { planExtraPayments: [], rest: payments };
  const remaining = [...payments].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
  const claimed: T[] = [];
  for (const extra of [...planExtras].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    const tolerance = Math.max(1_000, Math.round(extra.amountCents * 0.15));
    const idx = remaining.findIndex(
      (p) =>
        p.occurredOn.getTime() >= extra.date.getTime() - PLAN_EXTRA_LEAD_MS &&
        p.occurredOn.getTime() <= extra.date.getTime() + PLAN_EXTRA_LAG_MS &&
        Math.abs(Math.abs(p.amountCents) - extra.amountCents) <= tolerance,
    );
    if (idx >= 0) claimed.push(...remaining.splice(idx, 1));
  }
  return { planExtraPayments: claimed, rest: remaining };
}

// The occurrence a cycle is "due" on: the first still-unpaid slot this
// period, else the last slot, else the tracker's own nextDueDate (nothing
// lands this period — an ANNUAL debt due in another month). The first
// unpaid, not the last: a BIWEEKLY BNPL billing twice a month would
// otherwise read its later installment (Sep 17) while the earlier one
// (Sep 3) sat unpaid (real report, 2026-09-01: Klarna–Puma). Shared by the
// server calendars (correctedDueDateByDebtId) and /debts' CycleMinimum —
// /debts used to keep the last slot, so its planner disagreed with the
// dashboard on exactly that case (2026-10-09 review).
export function cycleDueDate(slots: { date: Date; payment: unknown }[], nextDueDate: Date): Date {
  const firstUnpaid = slots.find((s) => s.payment === null);
  return firstUnpaid?.date ?? (slots.length > 0 ? slots[slots.length - 1].date : nextDueDate);
}

// How far back a ledger loads a tracker's payments. Every ledger view reads
// this cycle and last (and an ANNUAL bill its prior payment, ~a year back);
// none needs a tracker's whole history, which used to load on every render
// and grew forever (2026-10-09 review). Same 400-day reach bill detection
// already uses.
export const PAYMENT_HISTORY_DAYS = 400;

export function recentPaymentsWhere() {
  return { occurredOn: { gte: new Date(Date.now() - PAYMENT_HISTORY_DAYS * DAY_MS) } };
}

