import type { BillCadence, PaycheckCadence } from "@prisma/client";
import { addPaycheckCadence, subtractPaycheckCadence } from "@/lib/income-calc";
import { todayAsUTCDate } from "@/lib/date";

// Pure module — no `db` import. simulatePayoff/projectPaymentCalendar run
// client-side too (live preview in PayoffPlanner), so nothing here may pull
// in server-only code. The one function that used to live here and touched
// the DB (getDebtsPaidOffThisWeek) moved to src/lib/debt-payments.ts.

export type DebtInput = {
  id: string;
  name: string;
  balanceCents: number;
  aprBasisPoints: number; // APR * 100, e.g. 20.15% -> 2015
  minPaymentCents: number;
  // INSTALLMENT (BNPL) plans are a fixed schedule of fixed payments, not a
  // revolving balance — even a nonzero APR doesn't compound on top of that,
  // so they're excluded from interest accrual below (see monthlyRateOf
  // callers). Undefined is treated as REVOLVING for callers that predate
  // this field.
  debtType?: "REVOLVING" | "INSTALLMENT";
  // True when the household has said this debt has no real minimum to
  // track (see Debt.ignoreMinimumPayment in schema.prisma) — its
  // minPaymentCents is 0 by convention while this is set, which
  // debtsWithInsufficientMinimum would otherwise always flag against any
  // positive APR/balance. Undefined is treated as false for callers that
  // predate this field.
  ignoreMinimumPayment?: boolean;
  // How often minPaymentCents is actually owed (DebtPayment.cadence) — used
  // to convert a paid-off debt's minPaymentCents into a true *monthly*
  // figure before it's rolled into the extra-payment pool (see
  // monthlyEquivalentCents below), and to count how many installments a
  // BNPL plan actually bills within one simulated month (see
  // applyInterestAndMinimums). minPaymentCents itself stays the real
  // per-occurrence amount everywhere else (due-event balance depletion,
  // insufficient-minimum checks, …), since that's what actually gets paid
  // and matched against real transactions each cycle. Undefined is treated
  // as MONTHLY, matching every caller that predates this field (where
  // minPaymentCents was already assumed to be a monthly amount).
  paymentCadence?: BillCadence;
  // INSTALLMENT plans only: the next unpaid installment's due date
  // (DebtPayment.nextDueDate) and how many installments are still owed.
  // simulatePayoff's monthly loop uses these to bill each installment in
  // the calendar month it actually lands in — a BIWEEKLY plan bills ~2.17×
  // a month, and its first installment may not be until next month — rather
  // than assuming one flat payment per month starting now (which stretched
  // a biweekly plan's projected payoff to roughly twice its real length).
  // Omit for REVOLVING or when no tracker is active; the loop then falls
  // back to monthlyEquivalentCents.
  nextDueDate?: Date | null;
  installmentsRemaining?: number | null;
};

// How many occurrences of `cadence` fall in the calendar month starting at
// `monthStart` (UTC), walking forward from `anchor` — the next still-owed
// occurrence (DebtPayment.nextDueDate). Occurrences before `anchor` are
// already paid, so the walk never steps back past it: a month earlier than
// `anchor` counts zero (the plan bills nothing that month yet). Same "bill
// each occurrence in the month it lands in" idea projectCyclePlan uses,
// kept local so this stays a dependency-free pure module.
function occurrencesInMonth(anchor: Date, cadence: BillCadence, monthStart: Date): number {
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  let d = new Date(anchor);
  let count = 0;
  while (d < monthEnd) {
    if (d >= monthStart) count++;
    d = addBillCadence(d, cadence);
  }
  return count;
}

function occurrencesPerYearOf(cadence: BillCadence | undefined): number {
  if (cadence === "WEEKLY") return 52;
  if (cadence === "BIWEEKLY") return 26;
  if (cadence === "ANNUAL") return 1;
  return 12; // MONTHLY, and the default for debts with no tracked cadence
}

// A debt's real per-occurrence minPaymentCents, scaled to what it actually
// costs per month — e.g. a BNPL plan billed $50 every two weeks really
// costs ~$108.33/month (50 * 26/12), not $50. Only meaningful for the
// "freed minimum rolls into the next debt" cash-flow figure: a household
// paid biweekly who just cleared that BNPL plan gets its whole monthly
// cost back, not just one fortnight's payment (real household report,
// 2026-08-21 — two paid-off biweekly Afterpay plans were each rolling in
// at half their real freed-up monthly amount).
// Named distinctly from income-calc.ts's monthlyEquivalentCents (same name,
// different signature and domain — that one converts a paycheck by
// IncomeCalcMethod, this one converts a bill/debt-payment BillCadence) —
// the shared name was confusing to grep for and easy to import the wrong
// one of by mistake, even though the two never actually collided at any
// call site.
export function billCadenceToMonthlyCents(amountCents: number, cadence: BillCadence | undefined): number {
  return Math.round((amountCents * occurrencesPerYearOf(cadence)) / 12);
}

// CUSTOM = the household manually reordered debts — computeAttackOrder just
// trusts the input array's order (already sortOrder-sorted by the caller)
// instead of re-sorting by APR/balance.
export type PayoffOrder = "AVALANCHE" | "SNOWBALL" | "CUSTOM";

export type IncomeSchedule = {
  nextPayDate: Date;
  cadence: PaycheckCadence;
  // SEMI_MONTHLY's two pay days (Income.semiMonthlyDays) — see addPaycheckCadence.
  semiMonthlyDays?: readonly number[];
};

// Real paycheck dates, walked forward from a known occurrence via
// addPaycheckCadence (income-calc.ts) — the single source of truth for
// "when is the next payday" everywhere in the payoff planner, replacing the
// old separate PayoffCalendarMode/payoffAnchorDate that duplicated what
// Income.nextPayDate/cadence already know. Any cadence works, unlike the old
// hardcoded 14-day BIWEEKLY-only math.
export function projectPaycheckDates(income: IncomeSchedule, count: number, from?: Date): Date[] {
  const dates: Date[] = [];
  let d = new Date(from ?? income.nextPayDate);
  for (let i = 0; i < count; i++) {
    dates.push(new Date(d));
    d = addPaycheckCadence(d, income.cadence, income.semiMonthlyDays);
  }
  return dates;
}

// Walks income.nextPayDate backward (then forward, to correct any overshoot
// — see subtractPaycheckCadence's month-end caveat) to the most recent real
// payday on or before `onOrBefore`. The result is always within one cadence
// period of `onOrBefore`.
//
// Why this matters: matchIncomePayments (src/lib/income.ts) rolls
// Income.nextPayDate forward the moment a paycheck's real transaction
// matches during sync — often the same day the paycheck lands. Anchoring the
// extra-payment projection at nextPayDate then silently jumps the *current*
// cycle's still-pending extra payments a whole cycle ahead the instant that
// happens (real household report, 2026-09-03/04: extras scheduled for
// today's payday vanished off the calendar, reappearing dated two weeks out,
// even though the real extra payments hadn't posted through SimpleFIN yet —
// SimpleFIN routinely takes a few days). projectCyclePlan uses this instead
// of nextPayDate directly so "this cycle's payday" always means the payday
// that actually just happened, not whichever one Income.nextPayDate happens
// to point at.
export function mostRecentPaydayOnOrBefore(income: IncomeSchedule, onOrBefore: Date): Date {
  let d = new Date(income.nextPayDate);
  while (d.getTime() > onOrBefore.getTime()) d = subtractPaycheckCadence(d, income.cadence, income.semiMonthlyDays);
  while (addPaycheckCadence(d, income.cadence, income.semiMonthlyDays).getTime() <= onOrBefore.getTime()) {
    d = addPaycheckCadence(d, income.cadence, income.semiMonthlyDays);
  }
  return d;
}

// Shared by every path that writes Debt.balanceCents (manual balance edit,
// installment terms update, linking/tracking a synced account, and the
// per-sync balance refresh) so paidOffDate stays correct no matter which one
// fires: stamp it the moment balance crosses from positive to zero, clear it
// if balance ever goes positive again (a correction, a new charge on a
// "paid off" card), and leave it alone otherwise — in particular, don't
// re-stamp "now" on every sync while a debt just sits at zero.
export function nextPaidOffDate(
  oldBalanceCents: number,
  newBalanceCents: number,
  currentPaidOffDate: Date | null,
): Date | null {
  // Debt.paidOffDate is `@db.Date` — the local calendar day the balance hit
  // zero, not a raw UTC instant (which is tomorrow's date after ~6pm here).
  if (newBalanceCents === 0 && oldBalanceCents > 0) return todayAsUTCDate();
  if (newBalanceCents > 0) return null;
  return currentPaidOffDate;
}

// Companion to nextPaidOffDate, same transition, same call sites (always
// called alongside it) — "how much was paid off," captured from the balance
// right before it hit zero so a display that has no linked Transaction to
// read a real dollar amount from yet (a synced balance confirms $0 well
// before the closing charge posts/matches) still has a real figure to show
// instead of a bare star (real report, 2026-09-17: Sam's Club Card).
export function nextPaidOffAmountCents(
  oldBalanceCents: number,
  newBalanceCents: number,
  currentPaidOffAmountCents: number | null,
): number | null {
  if (newBalanceCents === 0 && oldBalanceCents > 0) return oldBalanceCents;
  if (newBalanceCents > 0) return null;
  return currentPaidOffAmountCents;
}

// How close a traced payment's own date must be to a debt's paidOffDate to
// be trusted as the payment that actually closed it.
export const PAYOFF_ATTRIBUTION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// Which one (if any) of a debt's real payments this period gets the payoff
// star — the latest one, but only once it's actually close to paidOffDate
// (stamped above the moment the balance itself crossed zero). A no-minimum/
// BNPL debt can have an ordinary payment land mid-period that ISN'T the
// closer, with the real closing payment arriving separately days later on
// another account (or not synced as a transaction at all yet, only
// confirmed by the balance). Crediting the wrong one as "the payoff" both
// mislabels it and, in every caller with a balance-only fallback line, wrongly
// suppresses that fallback from ever showing the real, still-unconfirmed
// payoff on paidOffDate itself.
//
// Shared by every surface that picks a payoff-star payment — /debts
// (DebtRow, PayoffPlanner's own calendar), the buckets/bills ledger
// (DebtPaymentRow), and the dashboard Payment Calendar
// (getPaymentCalendarThisCycle) — each used to compute this independently
// before this existed, and only some had any safeguard at all (real report,
// 2026-09-07: Sam's Club Card's routine payment kept getting starred
// "Payoff" instead of its real, unconfirmed close, in three different
// places with three different bugs).
export function pickPayoffPaymentTime(
  payments: { occurredOn: Date }[],
  balanceCents: number,
  paidOffDate: Date | null,
): number | null {
  if (balanceCents !== 0 || !paidOffDate || payments.length === 0) return null;
  const latest = Math.max(...payments.map((p) => p.occurredOn.getTime()));
  return Math.abs(latest - paidOffDate.getTime()) <= PAYOFF_ATTRIBUTION_WINDOW_MS ? latest : null;
}

export type PayoffResult = {
  months: number;
  debtFreeDate: Date | null;
  totalInterestPaidCents: number;
  perDebt: {
    id: string;
    name: string;
    payoffMonth: number | null;
    payoffDate: Date | null;
  }[];
  neverPaysOff: string[];
  timeline: { month: number; totalRemainingCents: number; perDebtRemainingCents: Record<string, number> }[];
};

const MAX_MONTHS = 600; // 50-year safety cap against runaway simulations

export function monthlyRateOf(aprBasisPoints: number): number {
  return aprBasisPoints / 10000 / 12;
}

function addMonths(date: Date, months: number): Date {
  // Snap to the 1st before shifting the month — otherwise starting from a
  // day 29–31 overflows a shorter target month (Aug 31 + 6 → "Feb 31" →
  // Mar 3), pushing every projected payoff / debt-free date a month late
  // whenever "today" is late in a long month. Only the month/year is ever
  // read off the result.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

// How many of `paycheckDates` fall within the calendar month containing
// `monthDate`. Normally 2 for a biweekly household; land on the right
// alignment and a month gets a "bonus" 3rd.
function countPaycheckDatesInMonth(paycheckDates: Date[], monthDate: Date): number {
  const startMs = Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1);
  const endMs = Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1);
  return paycheckDates.filter((d) => {
    const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return ms >= startMs && ms < endMs;
  }).length;
}

// A minimum payment that's already fully freed before a simulation starts —
// a debt elsewhere in the household sitting at $0 balance, whose
// minPaymentCents survives untouched even after payoff (see
// manual-debt-editor.tsx) and so still represents real recurring cash flow
// now available to roll into the next debt in line.
export type FreedMinimumSource = {
  id: string;
  name: string;
  amountCents: number;
  // Calendar month the debt actually paid off (getUTCFullYear()*12 +
  // getUTCMonth()). A freed minimum only rolls into the extra pool in a
  // *strictly later* month — the payoff month's own minimum is considered
  // spent by the early extra payment that cleared the balance (household
  // rule, 2026-09-01: "when Quicksilver is paid off the first extra
  // paycheck, $25 is considered satisfying its minimum for this month").
  // Omit when the debt paid off long enough ago that it should roll from
  // the projection's first month (the common case). simulatePayoff ignores
  // this (its own loop already frees a detected payoff a month later, and a
  // one-month shift is immaterial over its multi-year horizon).
  freedMonthKey?: number;
};

export type FreedMinimumCandidate = {
  id: string;
  name: string;
  balanceCents: number;
  minPaymentCents: number;
  // Debt.freedMinimumCents — the last real minimum, used when the current
  // minPaymentCents has dropped to $0 after payoff.
  freedMinimumCents?: number | null;
  includeInPayoffPlan: boolean;
  paidOffDate?: Date | null;
  paymentCadence?: BillCadence;
};

// What a paid-off debt frees up each cycle: its current minimum, or — once
// that reads $0 (a paid-off card's statement shows nothing due) — the last
// real one it carried (Debt.freedMinimumCents).
export function freedMinimumOf(d: { minPaymentCents: number; freedMinimumCents?: number | null }): number {
  return d.minPaymentCents > 0 ? d.minPaymentCents : (d.freedMinimumCents ?? 0);
}

// Every already-paid-off debt (balanceCents <= 0) whose minPaymentCents
// still represents real freed-up cash flow, ready to feed simulatePayoff/
// projectCyclePlan's alreadyFreedMinimums opt. Pure (no `db` import, see the
// top of this file), so both the client-side live preview
// (payoff-planner.tsx) and the server-side dashboard/ICS projections
// (debt-payments.ts's getAlreadyFreedMinimums) share this one implementation
// instead of each reimplementing the same filter/sort/freedMonthKey math —
// real household report, 2026-09-09: the client copy had drifted to omit
// freedMonthKey entirely, defaulting every already-paid-off debt to "freed
// forever ago" and rolling Capital One Quicksilver's minimum into Amazon
// Card's Sep 17 payoff payment even though Quicksilver paid off earlier that
// same September — the payoff calendar (list + calendar view) disagreed with
// the dashboard's mini calendar as a result. Excludes a debt the household
// switched "counted in debt paydown" off for (real household report,
// 2026-08-21: two excluded biweekly Afterpay plans were rolling into Sam's
// Club Card's payoff calendar despite their own toggle being off).
export function computeAlreadyFreedMinimums(debts: FreedMinimumCandidate[]): FreedMinimumSource[] {
  return debts
    .filter((d) => d.balanceCents <= 0 && freedMinimumOf(d) > 0 && d.includeInPayoffPlan)
    // Earliest payoff first — the rollover waterfall (projectCyclePlan)
    // consumes freed minimums in this order, so a debt paid off longer ago
    // is the first to roll.
    .slice()
    .sort((a, b) => (a.paidOffDate?.getTime() ?? 0) - (b.paidOffDate?.getTime() ?? 0))
    .map((d) => ({
      id: d.id,
      name: d.name,
      amountCents: billCadenceToMonthlyCents(freedMinimumOf(d), d.paymentCadence),
      // A debt that paid off this calendar month had its minimum spent by
      // the payment that cleared it — its freed minimum only rolls next
      // month (see FreedMinimumSource.freedMonthKey). Unknown payoff date
      // (paid off before we tracked it) rolls from month one.
      freedMonthKey: d.paidOffDate ? d.paidOffDate.getUTCFullYear() * 12 + d.paidOffDate.getUTCMonth() : undefined,
    }));
}

// One debt's own slice of a paycheck's extra-payment pool, split by where
// the dollars came from — a strict waterfall in attack order: the flat
// per-paycheck extra the household configured is spent first (down the
// priority list), then each paid-off debt's rolled-in freed minimum in
// turn. So the top-priority debts read as pure "extra" and a rolled-in
// minimum only surfaces on the debt where the base extra ran out — matching
// how a household actually layers "my $200, then Quicksilver's freed $25"
// onto the plan (household request, 2026-09-01). Parts sum exactly to this
// line's own amountCents (not the whole pool). The month's total freed
// minimums are spread evenly across its paydays, and each payday's rollover
// chunk is attributed to the individual freed debts one at a time in payoff
// order — a debt's whole monthly minimum is consumed (possibly spanning two
// paydays) before the next freed debt shows up (see projectCyclePlan).
export type PoolBreakdown = { parts: { kind: "base" | "rolled"; name?: string; amountCents: number }[] };

// See PoolBreakdown. `applied` must already be in attack order —
// allocateExtraPool returns it that way — so the running `sources` cursor
// hands the flat extra to the earliest debts and each freed minimum to
// whoever the pool reaches after it's exhausted.
function waterfallPoolSources(
  applied: Map<string, number>,
  baseCents: number,
  rolled: { name: string; amountCents: number }[],
): Map<string, PoolBreakdown> {
  const sources: { kind: "base" | "rolled"; name?: string; remaining: number }[] = [
    { kind: "base", name: undefined, remaining: baseCents },
    ...rolled.map((r) => ({ kind: "rolled" as const, name: r.name, remaining: r.amountCents })),
  ];
  const out = new Map<string, PoolBreakdown>();
  for (const [debtId, amount] of applied) {
    let need = amount;
    const parts: PoolBreakdown["parts"] = [];
    for (const src of sources) {
      if (need <= 0) break;
      if (src.remaining <= 0) continue;
      const take = Math.min(need, src.remaining);
      src.remaining -= take;
      need -= take;
      parts.push({ kind: src.kind, name: src.name, amountCents: take });
    }
    out.set(debtId, { parts });
  }
  return out;
}

// How many of `paycheckDates` land in each calendar month — used to split a
// month's rolled-in freed minimums evenly across its paychecks (2 paychecks
// a month get half each, 3 get a third each) rather than dumping the whole
// monthly figure onto just the first one.
function paydaysPerMonth(paycheckDates: Date[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const d of paycheckDates) {
    const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export type InsufficientMinimumDebt = {
  id: string;
  name: string;
  minPaymentCents: number;
  aprBasisPoints: number;
  monthlyInterestCents: number;
};

// A debt whose minimum payment doesn't even cover its own first month's
// interest will only grow under minimums alone, no matter what attack
// order/extra-payment strategy is configured elsewhere — this is a
// standalone data-quality signal ("check this debt's minimum/APR"), not
// tied to any one simulation scenario. Installment/BNPL plans don't accrue
// interest (see DebtInput.debtType) so they can never trip this.
export function debtsWithInsufficientMinimum(debts: DebtInput[]): InsufficientMinimumDebt[] {
  const flagged: InsufficientMinimumDebt[] = [];
  for (const d of debts) {
    if (d.debtType === "INSTALLMENT" || d.balanceCents <= 0 || d.ignoreMinimumPayment) continue;
    const monthlyInterestCents = Math.round(d.balanceCents * monthlyRateOf(d.aprBasisPoints));
    if (d.minPaymentCents <= monthlyInterestCents) {
      flagged.push({
        id: d.id,
        name: d.name,
        minPaymentCents: d.minPaymentCents,
        aprBasisPoints: d.aprBasisPoints,
        monthlyInterestCents,
      });
    }
  }
  return flagged;
}

export function computeAttackOrder(
  debts: DebtInput[],
  order: PayoffOrder,
): string[] {
  if (order === "CUSTOM") return debts.map((d) => d.id);
  return [...debts]
    .sort((a, b) =>
      order === "AVALANCHE"
        ? b.aprBasisPoints - a.aprBasisPoints
        : a.balanceCents - b.balanceCents,
    )
    .map((d) => d.id);
}

type WorkingDebt = DebtInput & { remaining: number; minPayment: number };

function toWorkingMap(debts: DebtInput[]): Map<string, WorkingDebt> {
  return new Map(debts.map((d) => [d.id, { ...d, remaining: d.balanceCents, minPayment: d.minPaymentCents }]));
}

// What one debt owes in minimum payments during the calendar month starting
// at `tickMonthStart`. `d.minPayment` is always the real *per-occurrence*
// amount (see DebtInput.paymentCadence's own doc comment) — never a monthly
// figure on its own — for REVOLVING and INSTALLMENT alike, so both need the
// same conversion:
//   - A known schedule (nextDueDate + cadence): bill each real occurrence
//     in the month it actually lands in. A BIWEEKLY BNPL plan bills
//     ~2.17×/month and its next installment may not be until next month, so
//     a flat one-per-month assumption stretched its projected payoff to
//     roughly twice its real length (household report, 2026-08-30) — the
//     same gap existed for a BIWEEKLY *REVOLVING* tracker's minimum
//     (2026-09-11 fix: this function used to special-case REVOLVING as
//     always "one minimum per month," undercounting a non-monthly cadence's
//     real minimum by however many occurrences actually fall in the month).
//     INSTALLMENT additionally never bills more than what's still owed.
//   - No known schedule (a REVOLVING debt with no active tracker, or an
//     INSTALLMENT with nothing tracked yet): fall back to the cadence's
//     monthly-equivalent — billCadenceToMonthlyCents(minPayment, undefined)
//     is a no-op (assumes MONTHLY), so this preserves prior behavior exactly
//     for a schedule-less REVOLVING debt.
function monthlyMinimumDue(d: WorkingDebt, tickMonthStart: Date | undefined): number {
  if (tickMonthStart && d.nextDueDate && d.paymentCadence) {
    let occ = occurrencesInMonth(d.nextDueDate, d.paymentCadence, tickMonthStart);
    if (d.debtType === "INSTALLMENT" && d.installmentsRemaining != null) {
      occ = Math.min(occ, Math.max(0, d.installmentsRemaining));
    }
    return occ * d.minPayment;
  }
  return billCadenceToMonthlyCents(d.minPayment, d.paymentCadence);
}

// Interest accrual + minimum payments — the monthly-cadence half of the
// simulation, applied once per calendar month regardless of how many real
// paychecks land in it. Installment/BNPL plans are a fixed payment
// schedule, not a revolving balance, so they're skipped for interest (see
// DebtInput.debtType) but still bill their installments (see monthlyMinimumDue).
// `tickMonthStart` (UTC first-of-month for this tick) lets an INSTALLMENT
// plan bill each installment in the month it lands in; omit it and the
// installment path falls back to a cadence monthly-equivalent.
function applyInterestAndMinimums(
  working: Map<string, WorkingDebt>,
  tickMonthStart?: Date,
  // Debts whose *current real cycle's* minimum has already posted — the
  // live balanceCents this simulation starts from already reflects that
  // real payment, so re-deducting a fresh minimum for them on top of it
  // double-counts (real report, 2026-09-14: Amazon Card's $35 minimum
  // posted for real on the 10th, but the payoff chart still subtracted
  // another $35 on top of the already-reduced balance, pulling its
  // projected payoff a full month earlier than projectCyclePlan's own,
  // correct projection — that engine has always guarded against this via
  // its own identical minimumSatisfiedThisCycleIds; simulatePayoff never
  // had the equivalent). Only meaningful for the tick representing the
  // household's current real cycle (simulatePayoff only ever passes this
  // for month 1) — every later tick is a genuinely fresh cycle and bills
  // its minimum normally regardless of this set.
  skipMinimumIds?: Set<string>,
): {
  interestCents: number;
  clearedIds: Set<string>;
  // Per-debt amount actually applied as this month's minimum payment
  // (capped at remaining balance) — surfaced for projectCyclePlan, which
  // needs the real dollar figure, not just "this debt got a minimum
  // payment."
  minimumPayments: Map<string, number>;
  // Per-debt interest charged this tick — lets the caller absorb a
  // sub-tick trailing-interest residual into the payment that clears a
  // debt this month rather than carrying it to the next tick (see the
  // matching absorbTrailingInterest in projectCyclePlan).
  interestByDebtId: Map<string, number>;
} {
  let interestCents = 0;
  const interestByDebtId = new Map<string, number>();
  for (const d of working.values()) {
    // ignoreMinimumPayment: no real amortization schedule exists to project —
    // the household pays this in full every statement, so `minPayment` is
    // pinned at $0 and nothing here would ever apply toward it either way.
    // Compounding interest against it anyway turned a temporary mid-cycle
    // balance (a purchase made before the next full payoff) into a runaway
    // exponential "Projected Payoff" chart (real report, 2026-09-16: Sam's
    // Club Card, restored to a small balance and excluded from the payoff
    // plan — with $0 minimum ever paid and no extra pool eligibility, its
    // simulated balance just compounded, unchecked, for the full 600-month
    // horizon). Same exclusion debtsWithInsufficientMinimum already applies
    // for the identical reason, just never carried over to the actual tick
    // loop that does the compounding.
    if (d.remaining <= 0 || d.debtType === "INSTALLMENT" || d.ignoreMinimumPayment) continue;
    const interest = Math.round(d.remaining * monthlyRateOf(d.aprBasisPoints));
    d.remaining += interest;
    interestCents += interest;
    interestByDebtId.set(d.id, interest);
  }
  const clearedIds = new Set<string>();
  const minimumPayments = new Map<string, number>();
  for (const d of working.values()) {
    if (d.remaining <= 0) continue;
    if (skipMinimumIds?.has(d.id)) continue;
    const payment = Math.min(monthlyMinimumDue(d, tickMonthStart), d.remaining);
    d.remaining -= payment;
    if (payment > 0) minimumPayments.set(d.id, payment);
    if (d.remaining === 0) clearedIds.add(d.id);
  }
  return { interestCents, clearedIds, minimumPayments, interestByDebtId };
}

// Cascades `poolCents` across debts in attack order, each getting up to its
// own remaining balance before the pool moves to the next one — shared by
// simulatePayoff's monthly loop and projectPaymentCalendar's per-paycheck
// loop so the "where does extra money go" rule only lives in one place.
// Mutates `working`; returns how much actually landed on each debt.
export function allocateExtraPool(
  orderedIds: string[],
  working: Map<string, WorkingDebt>,
  poolCents: number,
  opts?: {
    // Compute the same cascade (still capped at each debt's own remaining
    // balance, still consuming the pool in order) without actually
    // depleting `working` — projectCyclePlan's past-payday branch uses this
    // to show what a not-yet-posted extra payment *would* pay down without
    // letting a payment nobody's actually confirmed made yet affect the
    // simulated balance every future payday projects from.
    dryRun?: boolean;
  },
): Map<string, number> {
  const applied = new Map<string, number>();
  let pool = poolCents;
  for (const id of orderedIds) {
    if (pool <= 0) break;
    const d = working.get(id);
    if (!d || d.remaining <= 0) continue;
    const payment = Math.min(pool, d.remaining);
    if (!opts?.dryRun) d.remaining -= payment;
    pool -= payment;
    if (payment > 0) applied.set(id, payment);
  }
  return applied;
}

// Pure, deterministic month-by-month amortization. Attack order is fixed
// once at the start (from initial balances/APRs), matching how the
// household's own plan document works — not re-sorted as balances shift.
export function simulatePayoff(
  debts: DebtInput[],
  opts: {
    order: PayoffOrder;
    // Whether a paid-off debt's freed minimum payment rolls into the extra
    // pool for the rest of the simulation (the "debt snowball" cash-flow
    // effect) — replaces the old MINIMUM_ONLY/FLAT_EXTRA/ROLLING_EXTRA
    // PayoffMode. extraPerPaycheckCents: 0 combined with this false is the
    // old MINIMUM_ONLY.
    rollFreedMinimums: boolean;
    extraPerPaycheckCents: number;
    startDate?: Date;
    // The household's real pay schedule, used to size how much extra lands
    // in each simulated month (some months get a "bonus" paycheck). Omit to
    // fall back to a flat smoothed monthly amount (extraPerPaycheckCents *
    // 26/12) — used when no income with a pay schedule is configured yet.
    income?: IncomeSchedule;
    // Stop after this many months even if debts remain (still bounded by
    // MAX_MONTHS either way). Lets a caller compare two scenarios' interest
    // cost over the same window — e.g. "how much interest would minimums
    // alone cost during the time this plan takes to pay off" — instead of
    // letting a scenario that never clears run the full 50-year safety cap
    // and rack up decades of compounding interest that was never a fair
    // comparison to begin with.
    horizonMonths?: number;
    // Minimum-payment dollars already freed before this simulation even
    // starts — debts elsewhere in the household that are already paid off
    // (balanceCents 0) and so no longer owe their minPaymentCents anywhere.
    // Without this, a card paid off before "now" never contributes its
    // freed minimum to the rolling pool at all: it's not part of `debts`
    // (already filtered out as $0-balance), so nothing in the tick loop
    // below ever adds it to freedMinimumsCents on its own.
    alreadyFreedMinimums?: FreedMinimumSource[];
    // Restricts which debts the extra-payment pool can cascade onto —
    // everything in `debts` still accrues interest and takes its own
    // minimum payment either way. Lets a caller simulate debts outside the
    // household's payoff plan (Debt.includeInPayoffPlan false) alongside the
    // in-plan ones, so the projection reflects every debt's own natural
    // payoff trajectory without extra money leaking onto a debt the
    // household deliberately excluded. Omit to make every debt eligible
    // (the pre-existing behavior).
    extraEligibleIds?: Set<string>;
    // Which debts' *current real cycle's* minimum has already posted — see
    // applyInterestAndMinimums' own comment on skipMinimumIds (only applied
    // to month 1's tick, below). projectCyclePlan has always taken this
    // (as minimumSatisfiedThisCycleIds); simulatePayoff never did, so its
    // month-1 tick double-counted an already-paid minimum on top of the
    // live balance it starts from, projecting a payoff up to a cycle
    // earlier than the household's real numbers support (real report,
    // 2026-09-14). Omit to keep the old (buggy) always-apply behavior —
    // no caller should actually do that; payoff-planner.tsx already
    // computes this same set for its own projectCyclePlan call.
    minimumSatisfiedThisCycleIds?: Set<string>;
    // Household-skipped (debtId, paycheckDate) pairs, `${debtId}:${YYYY-MM-DD}`
    // — see PayoffExtraSkip. Only ever meaningful for month 1 (a skip only
    // ever exists for a real, already-close payday, this cycle's own — see
    // the month-1-only per-payday cascade below); every later month keeps
    // the fast flat-monthly-pool shortcut, unaffected. Omitting this
    // reproduces the old (buggy) behavior of still counting a skipped
    // payday's extra as if it landed — projectCyclePlan has always
    // respected skips; simulatePayoff never did, so a skipped payday could
    // make the "Projected Payoff" chart show a payoff a full cycle earlier
    // than the Payoff Calendar's own, correct projection (real report,
    // 2026-09-14: Amazon Card's Sep 3 payday, skipped, still counted here).
    skippedExtraPairs?: Set<string>;
  },
): PayoffResult {
  // UTC-midnight-anchored to the *local* calendar day (see todayAsUTCDate) —
  // every date this simulation buckets by month (due dates, paycheck dates)
  // is itself UTC midnight, so the "start month" must be read the same way or
  // an evening-west-of-UTC caller keys the whole plan a month ahead.
  const startDate = opts.startDate ?? todayAsUTCDate();
  const monthCap = opts.horizonMonths !== undefined ? Math.min(MAX_MONTHS, opts.horizonMonths) : MAX_MONTHS;
  const flatMonthlyExtraCents = Math.round((opts.extraPerPaycheckCents * 26) / 12);
  // Enough real paycheck dates to cover the full MAX_MONTHS horizon, sized
  // off the income's own cadence rather than assuming biweekly. Anchored at
  // the current cycle's own payday (mostRecentPaydayOnOrBefore), not
  // income.nextPayDate directly — same reasoning as projectCyclePlan's own
  // use of this anchor (see its comment): nextPayDate rolls forward the
  // instant matchIncomePayments sees the real paycheck land, which can be
  // days before its own extra payment posts through SimpleFIN. Anchoring on
  // nextPayDate here undercounted this month's extra pool by a full pending
  // paycheck whenever "today" falls between a just-received payday and the
  // next one — a real case, 2026-09-06: Amazon Card's month-end balance in
  // this chart's "Remaining balance by month" table didn't match the $0 by
  // Sep 17 the Payoff Calendar/ledger (projectCyclePlan) already showed,
  // because that engine correctly counted both the Sep 3 (just-received,
  // still-pending) and Sep 17 paydays' extra within September while this one
  // only counted Sep 17.
  const paycheckDates = opts.income
    ? projectPaycheckDates(
        opts.income,
        Math.ceil((MAX_MONTHS * paychecksPerYearOf(opts.income.cadence)) / 12) + 4,
        mostRecentPaydayOnOrBefore(opts.income, startDate),
      )
    : null;

  const isExtraEligible = (id: string) => !opts.extraEligibleIds || opts.extraEligibleIds.has(id);
  const orderedIds = computeAttackOrder(debts, opts.order).filter(isExtraEligible);
  const working = toWorkingMap(debts);

  const minimumOnly = opts.extraPerPaycheckCents === 0 && !opts.rollFreedMinimums;
  const neverPaysOff: string[] = minimumOnly ? debtsWithInsufficientMinimum(debts).map((d) => d.name) : [];

  const payoffMonth = new Map<string, number>();
  const timeline: PayoffResult["timeline"] = [];
  let totalInterestPaidCents = 0;
  // A source with no freedMonthKey (paid off long enough before this
  // simulation starts that which exact month doesn't matter) is available
  // from tick 1, same as always. A source *with* one only joins once the
  // tick reaches a calendar month strictly after it — same "the payoff
  // month's own minimum is spent by the early extra payment that cleared
  // it" rule FreedMinimumSource.freedMonthKey documents, previously only
  // honored by projectCyclePlan; simulatePayoff folded every source in
  // unconditionally from month 1 regardless of freedMonthKey; harmless for
  // a debt that closed a while ago (the "immaterial one-month shift" the
  // old comment here described), but wrong for one that closed *this same*
  // calendar month — its freed minimum isn't real spare cash yet, that
  // month's minimum is still considered spent by the payment that just
  // cleared it (real report, 2026-09-14: Amazon Card's projected payoff
  // still landed in September partly because Quicksilver's freed $25/mo —
  // Quicksilver having *just* closed that same month — was already being
  // counted as available extra from day one of the simulation).
  const deferredFreedMinimums = (opts.alreadyFreedMinimums ?? []).filter((f) => f.freedMonthKey !== undefined);
  const deferredFreedIdsAdded = new Set<string>();
  let freedMinimumsCents = (opts.alreadyFreedMinimums ?? [])
    .filter((f) => f.freedMonthKey === undefined)
    .reduce((s, f) => s + f.amountCents, 0);
  let month = 0;
  const startMonthKey = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth();

  // A debt that's ignoreMinimumPayment (no real minimum — the household
  // pays it off ad hoc as charges come in, e.g. Sam's Club Card) AND not
  // extra-eligible (excluded from the payoff plan, or the plan isn't
  // cascading to it) has nothing in this simulation that will ever reduce
  // its balance — applyInterestAndMinimums already exempts it from both
  // interest and a minimum payment (same reasoning, see its own comment),
  // so its `remaining` just sits static forever. Left in `stillOwing`'s
  // count, that static balance blocked `allPaidOff`/`debtFreeDate` for the
  // *whole household* — every other debt could clear on schedule and the
  // "Projected Payoff" card would still say "Not projected to pay off
  // within 50 years" because of one card the household demonstrably keeps
  // paying down through ordinary real-world spending, just never inside
  // this model (real report, 2026-09-21). Excluding it from the gate here
  // mirrors debtsWithInsufficientMinimum's identical exclusion for the
  // identical reason, and doesn't change anything about how the debt is
  // simulated — its `remaining` is still reported honestly in the timeline
  // and per-debt payoff month (`payoffMonth` stays unset for it, same as
  // before), just no longer gates every OTHER debt's projected date.
  const simulationCanProgress = (d: WorkingDebt) => !d.ignoreMinimumPayment || isExtraEligible(d.id);
  const stillOwing = () => [...working.values()].some((d) => d.remaining > 0 && simulationCanProgress(d));

  while (stillOwing() && month < monthCap) {
    month++;
    const tickMonthKey = startMonthKey + (month - 1);
    for (const f of deferredFreedMinimums) {
      if (!deferredFreedIdsAdded.has(f.id) && f.freedMonthKey! < tickMonthKey) {
        freedMinimumsCents += f.amountCents;
        deferredFreedIdsAdded.add(f.id);
      }
    }

    // Tick 1 is "this calendar month" (see the `month - 1` offset notes
    // below) — UTC first-of-month so an INSTALLMENT plan's installments get
    // billed in the month they actually land in.
    const tickMonthStart = new Date(
      Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + (month - 1), 1),
    );
    const {
      interestCents,
      clearedIds: clearedThisRound,
      interestByDebtId,
    } = applyInterestAndMinimums(
      working,
      tickMonthStart,
      // Only tick 1 represents the household's actual current cycle — a
      // later tick's "minimum already paid" question doesn't exist yet,
      // that cycle hasn't happened.
      month === 1 ? opts.minimumSatisfiedThisCycleIds : undefined,
    );
    totalInterestPaidCents += interestCents;

    // Month 1's own paycheck dates, individually — only computed when
    // there's actually a skip to honor (the common case has none, so the
    // fast flat-pool path below stays untouched for it too).
    const skipsThisMonth =
      month === 1 && paycheckDates && opts.skippedExtraPairs?.size ? opts.skippedExtraPairs : null;

    const applied = new Map<string, number>();
    if (skipsThisMonth) {
      // Per-payday cascade, month 1 only — a skip is pinned to one specific
      // (debt, payday) pair, so the flat "just multiply by how many
      // paychecks land this month" shortcut can't tell a skipped payday
      // from an ordinary one. Cascading real paycheck dates one at a time
      // lets each get checked against the skip set individually; a skipped
      // debt's share for that date is computed normally (so it doesn't
      // silently inflate what's available to cascade further) and then
      // reversed — forfeited entirely, never handed to the next debt in
      // line, same rule projectCyclePlan's own skip handling already
      // documents.
      const monthEndMs = Date.UTC(tickMonthStart.getUTCFullYear(), tickMonthStart.getUTCMonth() + 1, 1);
      const datesThisMonth = paycheckDates!.filter(
        (d) => d.getTime() >= tickMonthStart.getTime() && d.getTime() < monthEndMs,
      );
      for (const date of datesThisMonth) {
        if (opts.extraPerPaycheckCents <= 0) continue;
        const dayApplied = allocateExtraPool(orderedIds, working, opts.extraPerPaycheckCents);
        const dateKey = date.toISOString().slice(0, 10);
        for (const [id, amt] of dayApplied) {
          if (skipsThisMonth.has(`${id}:${dateKey}`)) {
            working.get(id)!.remaining += amt; // forfeited, not redistributed
          } else {
            applied.set(id, (applied.get(id) ?? 0) + amt);
          }
        }
      }
      // Freed-minimum rollover isn't tied to any one payday, so it isn't
      // skippable the same way — applied as one lump after the real
      // paydays' own (skip-aware) cascade above. Coarser than
      // projectCyclePlan's own per-payday waterfall spread, but this engine
      // never tracked *which* rolled dollar came from which source anyway.
      if (opts.rollFreedMinimums && freedMinimumsCents > 0) {
        const rolled = allocateExtraPool(orderedIds, working, freedMinimumsCents);
        for (const [id, amt] of rolled) applied.set(id, (applied.get(id) ?? 0) + amt);
      }
    } else {
      const monthlyExtraCents = paycheckDates
        ? opts.extraPerPaycheckCents * countPaycheckDatesInMonth(paycheckDates, addMonths(startDate, month - 1))
        : flatMonthlyExtraCents;
      const pool = monthlyExtraCents + (opts.rollFreedMinimums ? freedMinimumsCents : 0);
      if (pool > 0) for (const [id, amt] of allocateExtraPool(orderedIds, working, pool)) applied.set(id, amt);
    }
    for (const id of applied.keys()) {
      const d = working.get(id)!;
      // Absorb a sub-tick trailing-interest scrap into the payment that
      // all but cleared the debt this month, so its payoff lands this
      // month rather than slipping to the next tick over a few cents left
      // by the statement-then-payment interest ordering — same reasoning
      // (and bound: never more than this tick's own interest charge) as
      // projectCyclePlan's absorbTrailingInterest.
      if (d.remaining > 0 && d.remaining <= (interestByDebtId.get(id) ?? 0)) {
        d.remaining = 0;
      }
      if (d.remaining === 0) clearedThisRound.add(id);
    }

    for (const id of clearedThisRound) {
      if (!payoffMonth.has(id)) payoffMonth.set(id, month);
      // Only an extra-eligible (in-plan) debt's freed minimum joins the
      // rolling pool — a debt the household excluded from the payoff plan
      // (extraEligibleIds) paying itself off from its own minimum alone
      // shouldn't then hand that freed cash to an in-plan debt, same
      // reasoning as extraEligibleIds restricting orderedIds/allocateExtraPool
      // and the identical guard in projectCyclePlan (real household report,
      // 2026-08-21 — excluded Afterpay plans kept showing as "rolled" money).
      if (!isExtraEligible(id)) continue;
      const cleared = working.get(id)!;
      freedMinimumsCents += billCadenceToMonthlyCents(cleared.minPayment, cleared.paymentCadence);
    }

    timeline.push({
      month,
      totalRemainingCents: [...working.values()].reduce((s, d) => s + Math.max(d.remaining, 0), 0),
      perDebtRemainingCents: Object.fromEntries([...working.entries()].map(([id, d]) => [id, Math.max(d.remaining, 0)])),
    });
  }

  const allPaidOff = !stillOwing();

  return {
    months: month,
    // Tick `month` applies calendar-month-offset `month - 1` from
    // startDate's own interest/minimum/extra (see the identical `month - 1`
    // a few lines up, in monthlyExtraCents' countPaycheckDatesInMonth call —
    // tick 1 is "this calendar month," not "one month from now"). Using a
    // bare `addMonths(startDate, month)` here previously reported every
    // payoff a full month later than it actually lands (a debt clearing via
    // this cycle's own extra payment, tick 1, showed as next month).
    debtFreeDate: allPaidOff ? addMonths(startDate, month - 1) : null,
    totalInterestPaidCents,
    perDebt: debts.map((d) => {
      const m = payoffMonth.get(d.id) ?? null;
      return { id: d.id, name: d.name, payoffMonth: m, payoffDate: m ? addMonths(startDate, m - 1) : null };
    }),
    neverPaysOff,
    timeline,
  };
}

function paychecksPerYearOf(cadence: PaycheckCadence): number {
  if (cadence === "MONTHLY") return 12;
  if (cadence === "SEMI_MONTHLY") return 24;
  return 26; // BIWEEKLY
}

export type CyclePaymentLine = {
  date: Date;
  kind: "minimum" | "extra";
  amountCents: number;
  // True when this specific payment is the one that brings the debt's
  // remaining balance to exactly 0 — set from the simulation's own
  // remaining-balance check at the moment the payment is applied (payments
  // are always capped at whatever's still owed, so the payment that clears
  // a debt is unambiguous), not re-derived from the line list afterward.
  isPayoff: boolean;
  // Present only on kind: "extra" lines — this debt's own slice of that
  // paycheck's pool split by source (see PoolBreakdown). Parts sum to
  // amountCents above.
  poolBreakdown?: PoolBreakdown;
  // True only for an "extra" line on the current cycle's own payday (the
  // most recent one on or before today — see mostRecentPaydayOnOrBefore),
  // when that payday's extra hasn't actually posted through SimpleFIN yet.
  // It's still simulated for real — subtracted from the working balance,
  // eligible for a real isPayoff — same as any future payday's line: a
  // scheduled extra is assumed to go through on schedule unless the
  // household explicitly skips it (household correction, 2026-09-04:
  // "yesterday's still going through," not stuck in limbo until a sync
  // catches up). Once the real payment posts, this line is netted against it
  // server-side (see projectCyclePlan's past-payday branch) and stops being
  // emitted — the real payment renders as its own "paid" line instead. If
  // it's never made and never skipped, it simply stops being emitted once
  // the next payday's anchor rolls past it — no catch-up, no accumulation.
  pending?: boolean;
  // True when the household explicitly skipped this pending extra (see
  // PayoffExtraSkip) — still emitted (so the UI can show it struck-through
  // with an Undo), but unlike every other pending line, a skipped one is
  // never applied to the simulated balance and can't carry isPayoff.
  skipped?: boolean;
};

export type CycleDebtEntry = {
  debtId: string;
  // Balance at the moment this cycle starts (for the first cycle, this is
  // just the live current balance — already reflects whatever's been paid
  // so far this real cycle) and at the moment it ends, after every line
  // below has landed. endBalanceCents === 0 (with a positive start) means
  // this debt is projected to clear during this cycle.
  startBalanceCents: number;
  endBalanceCents: number;
  lines: CyclePaymentLine[];
};

export type CyclePlanMonth = {
  monthKey: number;
  monthDate: Date;
  debts: CycleDebtEntry[];
};

// Per-cycle (calendar month) breakdown of every attack-order debt's starting
// balance and full payment line list — every minimum and every extra
// allocation landing in that month, not just the first — for "this cycle"
// plus however many predictive cycles ahead are requested. Shares
// simulatePayoff/projectPaymentCalendar's interest/minimum/allocation rules
// (via applyInterestAndMinimums/allocateExtraPool) so this view never
// disagrees with them — same continuous simulation, just captured at finer
// grain and split by month. The attack order (and therefore which debt an
// overflowing extra-payment pool cascades to) is fixed once at the start,
// same as simulatePayoff — a debt that clears mid-cycle still hands its
// leftover pool to the next debt in that same tick, automatically.
// UTC setters, not local — nextDueDate is a `@db.Date` value, UTC midnight
// for a specific calendar day (see src/lib/date.ts). Deliberately a
// separate function from recurring-bills.ts's addCadence (same BillCadence
// enum, same one-cadence-step logic) rather than importing it: that module
// pulls in `db`/`ai`, and this one is a pure client-safe module (see the
// file-level comment above) used from "use client" PayoffPlanner.
export function addBillCadence(date: Date, cadence: BillCadence): Date {
  const d = new Date(date);
  if (cadence === "MONTHLY") {
    // Raw setUTCMonth(+1) on a day-29/30/31 anchor overflows into the
    // *following* month when the target month is shorter (Jan 31 -> Mar 3,
    // since February has no 31st) — silently skipping that month's
    // occurrence entirely wherever this gets walked one month at a time
    // (occurrencesInMonth below). Real finding, 2026-09-12 code review: a
    // REVOLVING debt due on the 29th-31st read a $0 minimum for the
    // skipped month in the payoff simulation. Clamp to the target month's
    // real last day instead, same fix nextBillDueDate (recurring-bills.ts)
    // already applies for its own MONTHLY step.
    const day = d.getUTCDate();
    // Date.UTC's own month-overflow normalization (not day-overflow) is
    // exactly what's safe to rely on for the year-rollover case (December
    // -> January) — set day 1 first so only the month/year carries.
    const firstOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const daysInTargetMonth = new Date(
      Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return new Date(
      Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth(), Math.min(day, daysInTargetMonth)),
    );
  }
  if (cadence === "ANNUAL") {
    // Same overflow this function's own MONTHLY branch was just fixed for
    // (real finding, 2026-09-12 code review, filed against this exact
    // function): a raw setUTCFullYear(+1) on a Feb 29 anchor silently
    // overflows to March 1 once it rolls into a non-leap year, since that
    // year has no Feb 29. Clamp to the target year's real last day of the
    // same month instead — for every month but February this is a no-op
    // (every other month has the same day count every year).
    const day = d.getUTCDate();
    const targetYear = d.getUTCFullYear() + 1;
    const daysInTargetMonth = new Date(Date.UTC(targetYear, d.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(targetYear, d.getUTCMonth(), Math.min(day, daysInTargetMonth)));
  }
  if (cadence === "BIWEEKLY") d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCDate(d.getUTCDate() + 7); // WEEKLY
  return d;
}

// Single source of truth for "the real next due date, once this cycle is
// already known to be satisfied" — shared by debt-payments.ts's
// correctedDueDateByDebtId (server, dashboard/ICS) and payoff-planner.tsx's
// own dueDateByDebtId (client, payoff-plan simulation), which independently
// hand-wrote the identical formula twice (using two different cadence-math
// functions, nextBillDueDate vs addBillCadence) rather than sharing one —
// real finding, 2026-09-12 code review: both call sites' own comments
// already warned this exact pair has drifted once before (2026-09-06,
// Quicksilver) and must stay in sync, yet it was hand-copied a second time
// rather than consolidated when the Amazon Card fix (2026-09-11) added it.
//
// `trackedNextDueDate` only ever advances once its own due date is already
// behind today (matchDebtPayments' rollover grace, see debt-payments.ts) —
// it never jumps ahead early just because this cycle's payment already
// posted, so a minimum paid a few days *before* its due date leaves it
// still pointing at that same, already-satisfied date. One cadence past
// the actual satisfied occurrence (`satisfiedOccurrence` — each caller's
// own "last real occurrence this period" anchor) is always the correct
// next due date regardless of whether trackedNextDueDate has technically
// rolled over yet; take whichever of the two is later so a debt already
// paid ahead by more than one cadence (ordinary rollover) keeps its real,
// further-out date. When the cycle isn't paid at all, there's nothing to
// correct — `satisfiedOccurrence` is just the still-owed due date itself.
export function correctedNextDueDate(
  cyclePaid: boolean,
  trackedNextDueDate: Date,
  satisfiedOccurrence: Date,
  cadence: BillCadence,
): Date {
  if (!cyclePaid) return satisfiedOccurrence;
  return new Date(Math.max(trackedNextDueDate.getTime(), addBillCadence(satisfiedOccurrence, cadence).getTime()));
}

// One point in the projection timeline — either a real payday (the
// extra-payment pool cascades) or a debt's own real minimum-due date
// (that debt's own interest + minimum applies). Merged and sorted below
// into one chronological sequence, so a debt whose due date falls *after*
// an early-month payday correctly still owes its full balance against that
// payday's extra — not already reduced by a minimum that, in reality,
// hasn't happened yet (the bug this replaced a fixed "minimum always
// happens first" per-month assumption to fix: household report — Capital
// One Quicksilver is due the 27th, but the household's first payday of the
// month is the 20th; treating the minimum as already-applied by the 20th
// overstated how far that payday's extra payment would actually stretch).
type SimEvent =
  | { kind: "paycheck"; date: Date }
  | { kind: "due"; date: Date; debtId: string; visible: boolean };

export function projectCyclePlan(
  debts: DebtInput[],
  opts: {
    order: PayoffOrder;
    rollFreedMinimums: boolean;
    extraPerPaycheckCents: number;
    income: IncomeSchedule;
    monthsCount: number;
    startDate?: Date;
    // Debt ids whose current cycle's minimum has already been paid, per
    // the real ledger (not this simulation) — for these, the due date
    // below already points at *next* cycle's occurrence (see
    // dueDateByDebtId), so every occurrence generated from it is a normal
    // visible future line. For everything else, the very first occurrence
    // is this cycle's own still-outstanding minimum — simulated (so the
    // balance carried into later cycles is correct) but not rendered as
    // its own line, since the real cycleMinimum tracker already shows it
    // in the UI for the live cycle.
    minimumSatisfiedThisCycleIds?: Set<string>;
    // Per debt, the real due date currently being tracked (DebtPayment.
    // nextDueDate — "next unpaid occurrence") plus its billing cadence.
    // Without this, every debt's minimum falls back to a generic "first
    // payday of the month" date instead of its own actual due day, and
    // every debt lands on the same date regardless of when it's really
    // due.
    dueDateByDebtId?: Map<string, { date: Date; cadence: BillCadence }>;
    // See simulatePayoff's opts field of the same name — a debt already
    // paid off elsewhere in the household before this cycle starts.
    alreadyFreedMinimums?: FreedMinimumSource[];
    // See simulatePayoff's opts field of the same name — restricts which
    // debts the extra-payment pool cascades onto. Everything in `debts`
    // still gets its own "due" line and interest/minimum simulated either
    // way (so a household-excluded debt still shows its normal payment
    // schedule on the calendar), it just never receives a rolled-in extra.
    // Omit to make every debt eligible (unchanged behavior).
    extraEligibleIds?: Set<string>;
    // Real extra payments (beyond the minimum slots) already posted this
    // cycle, per debt, in absolute cents — from buildCycleSlots'
    // extraPayments (src/lib/debt-payments.ts's correctedDueDateByDebtId).
    // Nets against the current cycle's own (past-payday, "pending") extra
    // line below so a real synced payment isn't double-counted on top of
    // the display line it should instead be covering/replacing.
    extraPaidThisCycleByDebtId?: Map<string, number>;
    // Out-param: filled per debt with how much of extraPaidThisCycleByDebtId
    // the past-payday branch actually netted away (that money has already
    // replaced a display line, so it must not also confirm a future one —
    // see confirmProjectedExtras' nettedByPlanCents).
    postedExtraNettedOut?: Map<string, number>;
    // Household-skipped (debtId, payday) pairs — see PayoffExtraSkip — keyed
    // `${debtId}:${YYYY-MM-DD}`. A skipped pending line is still emitted
    // (skipped: true) so the UI can show it struck-through with an Undo, but
    // never applied to the simulated balance, same as any other pending line.
    skippedExtraPairs?: Set<string>;
    // How a month's rolled-in freed minimums (see FreedMinimumSource) reach
    // the plan once `rollFreedMinimums` is on — household setting,
    // Household.payoffRollFreedMinimumsSplit. `true`/omitted (default): the
    // existing behavior, spread evenly across the month's paydays. `false`:
    // the whole month's freed total moves in one lump, timed to the current
    // priority debt's own minimum due date instead of any payday — same
    // total money, different cash-flow shape (household request, 2026-09-17:
    // "apply full rolled minimum to priority debt's minimum due date").
    rollFreedMinimumsSplit?: boolean;
  },
): CyclePlanMonth[] {
  // UTC-midnight-anchored to the *local* calendar day (see todayAsUTCDate) —
  // every date this simulation buckets by month (due dates, paycheck dates)
  // is itself UTC midnight, so the "start month" must be read the same way or
  // an evening-west-of-UTC caller keys the whole plan a month ahead.
  const startDate = opts.startDate ?? todayAsUTCDate();
  const orderedIds = computeAttackOrder(debts, opts.order);
  const isExtraEligible = (id: string) => !opts.extraEligibleIds || opts.extraEligibleIds.has(id);
  const extraEligibleOrderedIds = orderedIds.filter(isExtraEligible);
  const working = toWorkingMap(debts);
  const minimumSatisfied = opts.minimumSatisfiedThisCycleIds ?? new Set<string>();

  // Per debt, the interest charged at its most recent "due" event in this
  // walk. A "due" event posts a full billing cycle's interest at the
  // statement date; an extra payment days later then clears the debt but
  // leaves the cycle's *trailing* interest (accrued between the statement and
  // the payoff) sitting as a sub-dollar balance. A bare month-boundary model
  // carries that scrap a whole cycle to the debt's next due date and only
  // then calls it "Paid Off" — a month after the payment that actually
  // cleared it (real household report, 2026-09-07: Amazon Card "$0.45 — Pays
  // It Off!" on Oct 1, when the $200 payment on Sep 17 is what finished it).
  //
  // Instead, when a payday's extra lands a debt within that last interest
  // charge of $0, the household pays the few extra dollars to be done with
  // it right then: the residual is folded into that payday's payment (so the
  // plan stays penny-exact — nothing is silently forgiven) and the debt is
  // retired on that date. Bounded by the interest just charged, so this only
  // ever absorbs what is genuinely the cycle's own trailing interest, never a
  // real scheduled payment.
  const lastInterestByDebtId = new Map<string, number>();
  // Which calendar month (the same monthKey the outer loop already computes)
  // each REVOLVING debt last had interest charged in — a "due" event fires
  // once per DebtPayment cadence occurrence, which for a WEEKLY/BIWEEKLY
  // tracked debt is more than once a month, but interest is a monthly
  // charge regardless of how often the minimum is paid. Without this, a
  // BIWEEKLY debt accrued a full monthlyRateOf tick at *every* due event —
  // 2-4x its real monthly interest (2026-09-11 fix; see simulatePayoff's
  // monthlyMinimumDue for the matching fix on the minimum-payment side of
  // this same non-monthly-cadence gap).
  const interestChargedMonthByDebtId = new Map<string, number>();
  const absorbTrailingInterest = (debtId: string, paymentCents: number): number => {
    const d = working.get(debtId);
    if (!d || d.remaining <= 0) return paymentCents;
    if (d.remaining <= (lastInterestByDebtId.get(debtId) ?? 0)) {
      const residual = d.remaining;
      d.remaining = 0;
      lastInterestByDebtId.set(debtId, 0);
      return paymentCents + residual;
    }
    return paymentCents;
  };

  // Anchored at the current cycle's own payday (the most recent one on or
  // before today), not Income.nextPayDate directly — see
  // mostRecentPaydayOnOrBefore's own comment for why. Enough real paycheck
  // dates from there to be sure we cross monthsCount month boundaries even
  // for a MONTHLY cadence (1/mo), plus buffer.
  const paycheckAnchor = mostRecentPaydayOnOrBefore(opts.income, startDate);
  const paycheckDates = projectPaycheckDates(
    opts.income,
    Math.ceil(((opts.monthsCount + 2) * paychecksPerYearOf(opts.income.cadence)) / 12) + 3,
    paycheckAnchor,
  );
  const occurrencesNeeded = opts.monthsCount + 2;
  const paydayCounts = paydaysPerMonth(paycheckDates);

  const events: SimEvent[] = paycheckDates.map((date) => ({ kind: "paycheck", date }));
  for (const id of orderedIds) {
    const info = opts.dueDateByDebtId?.get(id);
    // No tracked due date for this debt (e.g. still needs setup) — fall
    // back to treating "now" as its next occurrence, same rough
    // approximation the old month-crossing model used everywhere.
    let dueDate = info?.date ?? startDate;
    const cadence: BillCadence = info?.cadence ?? "MONTHLY";
    // A debt whose current-cycle minimum is already paid per the real ledger
    // must not have a due occurrence simulated on or before today — that
    // payment is already reflected in the balance we start from, so
    // re-deducting it here (plus the interest tick the "due" branch accrues)
    // understates what's still owed. The caller normally passes next cycle's
    // date for these (dueDateByDebtId keys off the same paidThisCycle flag),
    // but during the post-due-date sync-lag grace window matchDebtPayments
    // deliberately holds nextDueDate un-rolled for a few days, so it can
    // still be sitting a day or two in the past, in this same calendar month
    // (real household report, 2026-08-29: a $25-minimum card paid 2 days ago
    // showed its remaining ~$40 balance projected as ~$15 — one extra
    // minimum + interest tick — then "paid off" by the next paycheck's
    // extra pool). Roll forward to the genuine next occurrence.
    if (minimumSatisfied.has(id)) {
      while (dueDate <= startDate) dueDate = addBillCadence(dueDate, cadence);
    }
    let visible = minimumSatisfied.has(id);
    for (let i = 0; i < occurrencesNeeded; i++) {
      events.push({ kind: "due", date: dueDate, debtId: id, visible });
      visible = true;
      dueDate = addBillCadence(dueDate, cadence);
    }
  }
  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  const newMonth = (monthKey: number, monthDate: Date): CyclePlanMonth => ({
    monthKey,
    monthDate,
    debts: orderedIds.map((id) => ({
      debtId: id,
      startBalanceCents: working.get(id)!.remaining,
      endBalanceCents: working.get(id)!.remaining,
      lines: [],
    })),
  });
  const linesFor = (month: CyclePlanMonth, debtId: string) => month.debts.find((d) => d.debtId === debtId)!.lines;
  const finalize = (month: CyclePlanMonth): CyclePlanMonth => {
    for (const entry of month.debts) entry.endBalanceCents = Math.max(0, working.get(entry.debtId)!.remaining);
    return month;
  };
  // Every date here — "due" events (a real `@db.Date` value) and "paycheck"
  // events (addPaycheckCadence, itself UTC-setter arithmetic now) alike — is
  // UTC-midnight-anchored, so both read the same way. They used to be read
  // differently (UTC for "due", local for "paycheck"), which is exactly what
  // put a real payoff-plan line under the wrong month header: a paycheck
  // landing on the actual 1st of a month read back as the last day of the
  // *previous* month through a local getter on this server's TZ.
  const monthKeyOf = (event: SimEvent) => event.date.getUTCFullYear() * 12 + event.date.getUTCMonth();

  const startMonthKey = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth();
  // The anchor payday (mostRecentPaydayOnOrBefore) can land in the *previous*
  // calendar month for a household paid early in the month (e.g. MONTHLY on
  // the 1st, today the 3rd) — drop any event before this month so month
  // bucketing below stays monotonic starting at startMonthKey. That household
  // simply gets no "this cycle's payday" pending line; its prior cycle is
  // already settled and nothing else here renders a month-old date anyway.
  const filteredEvents = events.filter((e) => monthKeyOf(e) >= startMonthKey);
  const months: CyclePlanMonth[] = [];
  let current = newMonth(startMonthKey, startDate);
  let lastMonthKey = startMonthKey;
  // Month-level rollover-waterfall state (see the paycheck branch) — the
  // month's total freed minimums are spread evenly across its paydays, then
  // attributed to the individual freed debts one-at-a-time in payoff order.
  // Payday-indexed, so it keeps its own month cursor rather than riding
  // `lastMonthKey` (which also advances on "due" events).
  let rolloverMonthKey = startMonthKey;
  let paydayIndexThisMonth = -1;
  let rolloverConsumedThisMonthCents = 0;
  const rolledTakenBySourceThisMonth = new Map<string, number>();
  // LUMP mode's own once-per-month cursor (rollFreedMinimumsSplit === false)
  // — the whole month's freed total is stable for the whole month (a payoff
  // recorded *this* month only ever joins `freedMinimums` with this same
  // `monthKey`, which the `< monthKey` filter below excludes until next
  // month), so one application per month is all there ever is to do; this
  // just stops a BIWEEKLY-tracked priority debt's second due event that same
  // month from re-applying it.
  const rollFreedMinimumsSplit = opts.rollFreedMinimumsSplit !== false;
  let lumpAppliedMonthKey = Number.NaN;
  // Each currently-freed debt's own monthly minimum, tracked separately (not
  // summed into one number) so the UI can show which specific paid-off debt
  // an extra payment's dollars came from (see PoolBreakdown).
  const freedMinimums = new Map<string, { name: string; cents: number; freedMonthKey: number }>();
  for (const f of opts.alreadyFreedMinimums ?? [])
    freedMinimums.set(f.id, {
      name: f.name,
      cents: f.amountCents,
      freedMonthKey: f.freedMonthKey ?? Number.NEGATIVE_INFINITY,
    });

  // Mutable running balance of real posted extra, per debt — consumed as
  // past-payday lines net against it below (see the past-payday branch).
  // Copied so the caller's own map is never mutated.
  const postedExtraRemaining = new Map(opts.extraPaidThisCycleByDebtId ?? []);
  const noteNetted = (debtId: string, cents: number) => {
    if (cents > 0 && opts.postedExtraNettedOut)
      opts.postedExtraNettedOut.set(debtId, (opts.postedExtraNettedOut.get(debtId) ?? 0) + cents);
  };

  for (const event of filteredEvents) {
    const monthKey = monthKeyOf(event);
    if (monthKey !== lastMonthKey) {
      months.push(finalize(current));
      if (months.length >= opts.monthsCount) return months;
      lastMonthKey = monthKey;
      current = newMonth(monthKey, event.date);
    }

    if (event.kind === "due") {
      const d = working.get(event.debtId);
      if (!d || d.remaining <= 0) continue;
      if (d.debtType !== "INSTALLMENT" && interestChargedMonthByDebtId.get(event.debtId) !== monthKey) {
        const interestCents = Math.round(d.remaining * monthlyRateOf(d.aprBasisPoints));
        d.remaining += interestCents;
        lastInterestByDebtId.set(event.debtId, interestCents);
        interestChargedMonthByDebtId.set(event.debtId, monthKey);
      }
      const amountCents = Math.min(d.minPayment, d.remaining);
      d.remaining -= amountCents;
      const isPayoff = d.remaining === 0;
      // Only an extra-eligible (in-plan) debt's freed minimum joins the
      // rolling pool — an excluded debt paying itself off from its own
      // minimum alone shouldn't hand its freed-up cash to an in-plan debt
      // it was never cascading extra money to or from (same reasoning as
      // extraEligibleIds restricting allocateExtraPool below).
      if (isPayoff && isExtraEligible(event.debtId)) {
        freedMinimums.set(event.debtId, {
          name: d.name,
          cents: billCadenceToMonthlyCents(d.minPayment, d.paymentCadence),
          freedMonthKey: monthKeyOf(event),
        });
      }
      // A debt whose tracked minimum is $0 (a card paid in full each cycle,
      // or one with ignoreMinimumPayment set) produces a $0 "due" occurrence
      // every cycle — real, but nothing anyone owes. Don't emit it as a line:
      // it surfaced as a "$0.00 min payment" event on the synced Google
      // Calendar feed and a $0 row on the in-app calendar (household report,
      // 2026-08-31). isPayoff can't be true here (we `continue` above when
      // remaining is already 0), so nothing downstream needs the empty line.
      if (event.visible && amountCents > 0) {
        linesFor(current, event.debtId).push({ date: event.date, kind: "minimum", amountCents, isPayoff });
      }
      // --- LUMP mode's rolled-minimum payment ---
      // Only when the household picked "apply full rolled minimum to
      // priority debt's minimum due date" over the default split (above).
      // `event.debtId` matching the *current* top-of-attack-order still-open
      // eligible debt is what "priority debt" means — recomputed fresh here
      // (not cached at month start) since a debt at the top of `orderedIds`
      // can itself pay off between two due dates, promoting the next one
      // mid-month; `extraEligibleOrderedIds.find` picking the first entry
      // still in `working` always answers "who's the target right now."
      // `lumpAppliedMonthKey` caps this at once per month even for a
      // BIWEEKLY-tracked priority debt with two due events in the same
      // month — the money already moved on the first one.
      if (!rollFreedMinimumsSplit && opts.rollFreedMinimums && monthKey !== lumpAppliedMonthKey) {
        const priorityDebtId = extraEligibleOrderedIds.find((id) => (working.get(id)?.remaining ?? 0) > 0);
        if (priorityDebtId === event.debtId) {
          lumpAppliedMonthKey = monthKey;
          const freedSources = [...freedMinimums.entries()]
            .filter(([, v]) => v.freedMonthKey < monthKey)
            .map(([id, v]) => ({ id, name: v.name, monthlyCents: v.cents }));
          const totalFreedThisMonthCents = freedSources.reduce((s, x) => s + x.monthlyCents, 0);
          if (totalFreedThisMonthCents > 0) {
            const applied = allocateExtraPool(extraEligibleOrderedIds, working, totalFreedThisMonthCents);
            const breakdownByDebt = waterfallPoolSources(
              applied,
              0,
              freedSources.map((s) => ({ name: s.name, amountCents: s.monthlyCents })),
            );
            for (const [debtId, amountCents] of applied) {
              const shownAmount = absorbTrailingInterest(debtId, amountCents);
              const lumpIsPayoff = working.get(debtId)!.remaining === 0;
              linesFor(current, debtId).push({
                date: event.date,
                kind: "extra",
                amountCents: shownAmount,
                isPayoff: lumpIsPayoff,
                poolBreakdown: breakdownByDebt.get(debtId),
              });
              if (lumpIsPayoff) {
                const paidOff = working.get(debtId)!;
                freedMinimums.set(debtId, {
                  name: paidOff.name,
                  cents: billCadenceToMonthlyCents(paidOff.minPayment, paidOff.paymentCadence),
                  freedMonthKey: monthKey,
                });
              }
            }
          }
        }
      }
      continue;
    }

    // --- Rollover waterfall for this payday ---
    // The month's total freed minimums (only debts whose payoff month is
    // fully behind us — freedMonthKey < monthKey, see
    // FreedMinimumSource.freedMonthKey) are spread evenly across the month's
    // paydays via a running cumulative target (so rounding lands on the last
    // payday and each payday's chunk is total/paydays). That chunk is then
    // attributed to the freed debts as a strict waterfall in payoff order —
    // a debt's whole monthly minimum is consumed across successive paydays
    // before the next freed debt contributes anything (household model,
    // 2026-09-01: "once a card's minimum is exhausted it rolls to the next").
    // Only in SPLIT mode — in LUMP mode the same money already moved (or
    // will move) as a single payment on the priority debt's own due date
    // (the "due" branch above), so it contributes nothing to any payday's
    // pool here; `freedSources` reducing to `[]` collapses everything below
    // to `pool = opts.extraPerPaycheckCents` alone, unchanged.
    if (monthKey !== rolloverMonthKey) {
      rolloverMonthKey = monthKey;
      paydayIndexThisMonth = 0;
      rolloverConsumedThisMonthCents = 0;
      rolledTakenBySourceThisMonth.clear();
    } else {
      paydayIndexThisMonth += 1;
    }
    const paydaysThisMonth = paydayCounts.get(monthKey) ?? 1;
    const freedSources = opts.rollFreedMinimums && rollFreedMinimumsSplit
      ? [...freedMinimums.entries()]
          .filter(([, v]) => v.freedMonthKey < monthKey)
          .map(([id, v]) => ({ id, name: v.name, monthlyCents: v.cents }))
      : [];
    const totalFreedThisMonthCents = freedSources.reduce((s, x) => s + x.monthlyCents, 0);
    const rolloverTargetCents = Math.round(
      (totalFreedThisMonthCents * (paydayIndexThisMonth + 1)) / paydaysThisMonth,
    );
    const rolloverThisPaydayCents = Math.max(0, rolloverTargetCents - rolloverConsumedThisMonthCents);
    rolloverConsumedThisMonthCents = rolloverTargetCents;

    const rolled: { id: string; name: string; amountCents: number }[] = [];
    let rolloverToPlace = rolloverThisPaydayCents;
    for (const src of freedSources) {
      if (rolloverToPlace <= 0) break;
      const taken = rolledTakenBySourceThisMonth.get(src.id) ?? 0;
      const take = Math.min(rolloverToPlace, src.monthlyCents - taken);
      if (take > 0) {
        rolled.push({ id: src.id, name: src.name, amountCents: take });
        rolledTakenBySourceThisMonth.set(src.id, taken + take);
        rolloverToPlace -= take;
      }
    }
    const rolledCents = rolled.reduce((s, r) => s + r.amountCents, 0);
    // Computed for every payday, past or future: a today-or-earlier payday
    // used to drop its rolled-in share entirely *and* skip advancing these
    // cursors, so the month's later paydays re-split only the remainder —
    // a freed minimum lost a payday's worth of rollover every month once
    // that payday passed (real report, 2026-10-02: Quicksilver's freed $25
    // vanished from Amazon Card's Oct 1 extra the day after payday).

    // --- The current cycle's own payday (on or before today) ---
    // Assumed to go through on schedule — same as any future payday — unless
    // the household explicitly skips it (household correction, 2026-09-04:
    // "yesterday's still going through" — a scheduled extra isn't in doubt
    // just because SimpleFIN hasn't caught up to it yet; skip is the only
    // way to say otherwise). So this debt's balance IS depleted and a real
    // isPayoff/star DOES land on this real payday, not deferred to whichever
    // future payday happens to catch up once the real transaction posts.
    // The one thing still special about this branch: net against whatever's
    // *already* posted this cycle so a real synced payment never gets
    // counted twice (once via the live balance it already reduced, once via
    // this assumed-through simulation) — once fully covered, nothing is
    // simulated at all; the real payment renders as its own "paid" line via
    // each caller's own payments loop instead. This payday's rolled-in
    // freed-minimum chunk (computed above) rides in the pool exactly as on a
    // future payday; a debt that pays off here still joins freedMinimums for
    // the *next* payday's rollover, same as normal.
    if (event.date.getTime() <= startDate.getTime()) {
      // A debt that paid off entirely this cycle is already gone from
      // `working` (debtInputs only carries balanceCents > 0) — but whatever
      // it actually received toward this payday's extra was real money, not
      // money that's still sitting in the pool waiting to be handed to the
      // next attack-order debt. Without this, the instant a debt's real
      // payment clears it, the *whole* payday's extra re-cascades onto
      // whoever's next, as if the just-closed debt received nothing at all —
      // effectively spending the same paycheck's extra twice. Netted off the
      // top here (rather than left to the per-debt netting loop below, which
      // only ever sees debts still present in `working`) and cleared from
      // `postedExtraRemaining` so a later past-payday tick in this same run
      // can't subtract it again.
      // isExtraEligible gate: a closed debt's real extra only came out of
      // *this* pool if the debt was actually in-plan — an excluded debt can
      // still pay off this cycle from money that has nothing to do with the
      // cascade (a plain purchase-driven restore-and-payoff, real report,
      // 2026-09-17: Sam's Club Card, excluded 2026-09-16, closed itself out
      // with a $175.78 payment unrelated to the plan — which then wiped out
      // the entire $100/paycheck pool for every actually in-plan debt, e.g.
      // Amazon Card, on the very next payday).
      let consumedByClosedDebts = 0;
      for (const [debtId, cents] of postedExtraRemaining) {
        if (working.has(debtId) || cents <= 0 || !isExtraEligible(debtId)) continue;
        consumedByClosedDebts += cents;
        postedExtraRemaining.set(debtId, 0);
        noteNetted(debtId, cents);
      }
      const availablePoolCents = Math.max(0, opts.extraPerPaycheckCents + rolledCents - consumedByClosedDebts);
      const dryRunApplied =
        availablePoolCents > 0
          ? allocateExtraPool(extraEligibleOrderedIds, working, availablePoolCents, { dryRun: true })
          : new Map<string, number>();
      const breakdown = waterfallPoolSources(dryRunApplied, opts.extraPerPaycheckCents, rolled);
      const eventDateKey = event.date.toISOString().slice(0, 10);
      for (const [debtId, gross] of dryRunApplied) {
        const posted = postedExtraRemaining.get(debtId) ?? 0;
        const consumed = Math.min(gross, posted);
        postedExtraRemaining.set(debtId, posted - consumed);
        noteNetted(debtId, consumed);
        const net = gross - consumed;
        // Fully covered by a real posted payment — nothing left to show or
        // skip; the real payment renders as its own "paid" line via each
        // caller's own payments loop. Within planExtraRoundingTolerance counts
        // as covered, so a $108.33 payment against a $108.34 line
        // doesn't leave a $0.01 pending line behind.
        if (net <= planExtraRoundingTolerance(gross)) continue;
        const skipped = opts.skippedExtraPairs?.has(`${debtId}:${eventDateKey}`) ?? false;
        const d = working.get(debtId)!;
        // Skipping forfeits net entirely for this payday — not rolled to
        // whoever's next in line, the same as any other payday the household
        // just didn't have the cash for (household correction, 2026-09-06:
        // an earlier cut here redirected a skipped debt's share to the next
        // eligible debt; skipping just means this specific payment doesn't
        // happen, full stop — the skipped debt carries its balance forward,
        // unreduced, to its own next scheduled payday, same as everything
        // else in this branch, with interest still accruing normally in the
        // meantime via the ordinary monthly tick elsewhere in this function).
        let shownNet = net;
        if (!skipped) {
          d.remaining -= Math.min(net, d.remaining);
          shownNet = absorbTrailingInterest(debtId, net);
        }
        const isPayoff = !skipped && d.remaining === 0;
        linesFor(current, debtId).push({
          date: event.date,
          kind: "extra",
          amountCents: shownNet,
          isPayoff,
          poolBreakdown: breakdown.get(debtId),
          pending: true,
          skipped: skipped || undefined,
        });
        if (isPayoff && isExtraEligible(debtId)) {
          freedMinimums.set(debtId, {
            name: d.name,
            cents: billCadenceToMonthlyCents(d.minPayment, d.paymentCadence),
            freedMonthKey: monthKey,
          });
        }
      }
      continue;
    }

    const pool = opts.extraPerPaycheckCents + rolledCents;
    const applied = pool > 0 ? allocateExtraPool(extraEligibleOrderedIds, working, pool) : new Map<string, number>();
    const breakdownByDebt = waterfallPoolSources(applied, opts.extraPerPaycheckCents, rolled);
    for (const [debtId, amountCents] of applied) {
      const shownAmount = absorbTrailingInterest(debtId, amountCents);
      const isPayoff = working.get(debtId)!.remaining === 0;
      linesFor(current, debtId).push({
        date: event.date,
        kind: "extra",
        amountCents: shownAmount,
        isPayoff,
        poolBreakdown: breakdownByDebt.get(debtId),
      });
      if (isPayoff) {
        const paidOff = working.get(debtId)!;
        freedMinimums.set(debtId, {
          name: paidOff.name,
          cents: billCadenceToMonthlyCents(paidOff.minPayment, paidOff.paymentCadence),
          freedMonthKey: monthKey,
        });
      }
    }
  }

  months.push(finalize(current));
  return months;
}

// ---------------------------------------------------------------------------
// Projected-extra "confirmed" reconciliation
// ---------------------------------------------------------------------------

// One PayoffExtraSnapshot row, serialized to plain ISO "YYYY-MM-DD" strings so
// the same shape crosses the server/client boundary unchanged (PayoffPlanner
// already ships snapshot rows down that way). ISO dates compare correctly
// lexicographically, so no Date parsing is needed here.
export type PayoffExtraSnapshotLine = {
  weekStart: string;
  dueDate: string;
  amountCents: number;
  isPayoff: boolean;
};

// How much of a debt's real extra-payment money this month already went
// toward a payoff target that the live plan no longer projects.
//
// PayoffExtraSnapshot keeps one permanent row per debt per week (see
// snapshotPlannedExtraForCurrentWeek, debt-payments.ts) — once a week ends its
// row is never rewritten. So an `isPayoff` row from an *earlier* week than the
// current one names a payoff the plan expected to happen back then. If the
// live plan still projects an extra for this debt this month, that earlier
// target must have been closed out and superseded: projectCyclePlan nets a
// real posted payment against its own target and drops the line entirely when
// `net <= 0`, so the superseded target leaves no trace in today's output.
//
// The reconciliation loop below can't see that on its own — it only sees the
// month's raw real-payment total, which still includes the money that retired
// the old target. Subtracting these rows stops that money being double-credited
// toward a brand-new target (household report, 2026-09-14: Sam's Club Card —
// a no-minimum REVOLVING card that fully paid off mid-month and was then
// reopened by a new purchase; see the regressions block in debt-payoff.test.ts).
//
// Rows are expected to be pre-filtered to the current calendar month by
// `dueDate` (the date the money was expected to move), which is what the
// month's real-payment total is scoped to as well.
export function supersededPayoffExtraCents(
  snapshots: readonly PayoffExtraSnapshotLine[],
  currentWeekStart: string,
): number {
  let cents = 0;
  for (const s of snapshots) {
    if (!s.isPayoff) continue;
    // The current week's own row is the *live* target — it was (re)written by
    // today's own sync and is exactly what the projected lines below describe.
    // Only strictly-earlier weeks are closed history.
    if (s.weekStart >= currentWeekStart) continue;
    cents += s.amountCents;
  }
  return cents;
}

// Same filter as supersededPayoffExtraCents, but keeps each dropped target's
// own amount separate instead of summing them into one pool.
//
// The Payment Calendar's isExtraPaid badge (getPaymentCalendarThisCycle,
// debt-payments.ts) needs to answer "did *this specific* real payment retire
// a dropped target," not just "is there some money left in an aggregate
// pool somewhere" — a shared additive budget doesn't care *which* payment it
// credits, so it happily consumed an earlier, unrelated payment first purely
// because it came first chronologically (real report, 2026-09-17: Sam's Club
// Card's Sep 1 $101.00 — an ordinary payment with no target of its own — got
// badged "Extra Payment" only because it posted before the Sep 8 $140.80
// payment that actually matched the dropped Sep 3 target; the $140.80
// target's own money was gone by the time the payment that really earned the
// badge showed up). Matching each payment against a specific target's own
// amount (see the caller's tolerance check) fixes that: an unrelated
// payment simply doesn't match any target amount and goes unbadged, however
// much aggregate budget happens to remain.
export function supersededPayoffTargetAmounts(
  snapshots: readonly PayoffExtraSnapshotLine[],
  currentWeekStart: string,
): number[] {
  return snapshots.filter((s) => s.isPayoff && s.weekStart < currentWeekStart).map((s) => s.amountCents);
}

// Marks each projected payoff-plan extra line "confirmed" (real money already
// covers it — renders cleared instead of an open pending bullet) by consuming
// the debt's real extra-payment total for the month oldest-line-first, so a
// single $150 lump correctly checks off a projected $50 + $100 pair rather
// than only ever matching a line of the exact amount.
//
// `supersededPayoffCents` (see above) is spent first and never resurfaces:
// that money is already accounted for by an obligation the live plan has
// dropped, so it isn't available to confirm anything still on the board.
//
// Shared by all three readers — buckets/[id]/page.tsx, bills/page.tsx and
// debts/payoff-planner.tsx — deliberately. Three independent copies of this
// same walk is exactly the shape that caused the 2026-09-06 incident
// documented on extraPaymentsBeyondSlots (cycle-slots.ts): the idea was fixed
// in one copy and not the other, and the two silently disagreed.
//
// `nettedByPlanCents` is the slice of the same real money projectCyclePlan's
// past-payday branch already netted against this cycle's own payday line
// (see its postedExtraNettedOut) — that line was dropped because the real
// payment replaced it, so the money is spent. Without this, one real payment
// counted twice (real report, 2026-10-05: Amazon's $108.33 Oct 2 extra
// retired the Oct 1 line *and* checked off the projected Oct 29 line).
//
// Strictly oldest-first: the walk stops at the first line the money can't
// cover, so a later line is never checked off while an earlier one is still
// open (the same report — $108.33 couldn't cover the $108.34 Oct 15 line but
// skipped ahead and confirmed Oct 29's $108.33). "Cover" allows
// planExtraRoundingTolerance of shortfall per line.
// How far short of a projected plan-extra line a real payment can fall and
// still count as covering it. The pool split rounds per payday ($325/3 →
// $108.33 / $108.34), and a household paying the "same" amount each time, or
// rounding to the dollar, shouldn't leave a line open over cents.
// Capped at a tenth of the line itself, so a tiny line (a trailing-interest
// sliver) still needs real money behind it rather than confirming on nothing.
export const PLAN_EXTRA_ROUNDING_TOLERANCE_CENTS = 100;
export function planExtraRoundingTolerance(lineCents: number): number {
  return Math.min(PLAN_EXTRA_ROUNDING_TOLERANCE_CENTS, Math.floor(lineCents / 10));
}

export function confirmProjectedExtras<T extends { amountCents: number }>(
  lines: readonly T[],
  realExtraCents: number,
  supersededPayoffCents = 0,
  nettedByPlanCents = 0,
): (T & { confirmed: boolean })[] {
  // Clamped at zero: a superseded target can legitimately exceed what actually
  // posted this month (a projected payoff that slid to a later week before any
  // money moved). "Nothing left to confirm with" is the honest floor — never a
  // negative that would quietly re-confirm later lines.
  let remainingCents = Math.max(0, realExtraCents - supersededPayoffCents - nettedByPlanCents);
  let open = false;
  return lines.map((line) => {
    const confirmed = !open && remainingCents >= line.amountCents - planExtraRoundingTolerance(line.amountCents);
    if (confirmed) remainingCents = Math.max(0, remainingCents - line.amountCents);
    else open = true;
    return { ...line, confirmed };
  });
}
