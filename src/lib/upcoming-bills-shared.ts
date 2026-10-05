// Client-safe helpers shared between the server-side "this week's bills"
// readers (src/lib/recurring-bills.ts, src/lib/debt-payments.ts) and the
// client UpcomingBillsCard. No DB / Node imports here so the card can use it.

// Money that went toward debt principal this week: true surplus beyond what
// was expected, plus the payoff plan's planned extra once it has actually
// landed (until then it's still an obligation, counted in expectedCents).
// Shared so the dashboard's "extra to debt" stat and the card's footer total
// can't drift apart.
export function principalTowardDebtCents(b: {
  extraCents: number;
  plannedExtraCents: number;
  paid: boolean;
}): number {
  return b.extraCents + (b.paid ? b.plannedExtraCents : 0);
}

// Real surplus beyond this week's own obligation, badged as "$X Extra" once
// it lands — the amount `principalTowardDebtCents` (above) adds to
// `plannedExtraCents`. Extracted from getDebtPaymentsThisWeek
// (src/lib/debt-payments.ts) so it's independently unit-testable (that
// function is a DB reader, not covered by the pure-`src/lib` unit suite).
//
// `tracksMinimum` decides which "money received" figure grounds the
// surplus: a debt with a REAL minimum can legitimately pay it in one week
// and its payoff-plan extra in a LATER week of the same billing cycle — the
// whole-cycle `receivedThisCycleCents` (minus the cycle's one-time
// `cycleMinimumCents`) is what lets that later week's extra read correctly
// without re-subtracting a minimum that already posted earlier (2026-08-28,
// Trailer Loan: "$92 posted weeks before the payoff — must not come off the
// extra again"). A no-minimum (`ignoreMinimumPayment`) debt has no such
// cross-week minimum to protect — `cycleMinimumCents` is always 0 for one —
// so grounding it in the same whole-cycle total let an *unrelated* ad hoc
// payment from an earlier week (one that never itself qualified for its own
// week's card — see getDebtPaymentsThisWeek's OR-filtered query) leak into a
// later week's badge merely because that later week's own payment happened
// to be large enough to absorb it (real report, 2026-09-21: Sam's Club
// Card's Sep 8 $140.80 — its own week never showed it — read as part of a
// Sep 16 week's "$316.58 Extra", when the real answer was $0: that week's
// own $175.78 payment exactly matched its own plan target, nothing more).
// For `!tracksMinimum`, grounding the surplus in `rawReceivedCents` (this
// week's own money only) fixes that leak with no effect on the
// `tracksMinimum` (real-minimum) path above, which keeps its original,
// separately battle-tested behavior untouched.
export function extraTowardPrincipalCents(opts: {
  tracksMinimum: boolean;
  minimumMet: boolean;
  receivedThisCycleCents: number;
  rawReceivedCents: number;
  cycleMinimumCents: number;
  plannedExtraCents: number;
  extraFloorCents: number;
  planDriven: boolean;
}): number {
  if (!opts.minimumMet) return 0;
  const cycleReceivedForSurplus = opts.tracksMinimum ? opts.receivedThisCycleCents : opts.rawReceivedCents;
  const surplusThisCycleCents = Math.max(0, cycleReceivedForSurplus - opts.cycleMinimumCents - opts.plannedExtraCents);
  // Still capped at this week's own money even on the tracksMinimum path —
  // belt-and-suspenders, matches the original's own `rawExtraCents` cap.
  const rawExtraCents = Math.min(surplusThisCycleCents, opts.rawReceivedCents);
  return opts.planDriven && rawExtraCents >= opts.extraFloorCents ? rawExtraCents : 0;
}

// Whether a REVOLVING tracker's in-week occurrence (`nextDueDate`, inside
// [weekStart, weekEnd)) was already covered by a payment that posted *after*
// the week closed. matchDebtPayments deliberately leaves nextDueDate parked on
// the occurrence for SYNC_LAG_GRACE_DAYS after it passes, so a payment made a
// few days late links to the tracker while nextDueDate still names the old
// occurrence — and any linked payment on/after that date can only be paying
// it. Without this, the past week's card read the occurrence as unpaid (its
// own window holds no payment) while the following week's card showed the
// same payment as paid: one bill, two weeks (real report, 2026-09-29: a
// personal loan due Sep 25, paid Sep 28, listed unpaid on Last Week's Bills
// and paid on This Week's). A RecurringBill never has this gap — its
// nextDueDate advances the moment it's paid, so it drops out of the earlier
// week on its own; this brings a debt row in line with that.
export function occurrenceSettledAfterWeek(opts: {
  nextDueDate: Date;
  weekEnd: Date;
  owedCents: number;
  payments: { amountCents: number; occurredOn: Date }[];
}): boolean {
  if (opts.owedCents <= 0) return false;
  const lateCents = opts.payments
    .filter((p) => p.occurredOn >= opts.weekEnd && p.occurredOn >= opts.nextDueDate)
    .reduce((s, p) => s + Math.abs(p.amountCents), 0);
  return lateCents >= opts.owedCents;
}

// The mirror image of occurrenceSettledAfterWeek, seen from the *later* week:
// the tracker's nextDueDate is still parked (SYNC_LAG_GRACE_DAYS) on an
// occurrence due *before* this week started, and payments on/after that due
// date already cover it — so this week's payment is that late occurrence's
// minimum, not surplus. getDebtPaymentsThisWeek then opens "this cycle" at
// the parked due date instead of a cadence back from today, which otherwise
// swept in the *previous* occurrence's own late payment and read one whole
// minimum as "Extra To Principal" (real report, 2026-10-05: Voyager Loan due
// Sat Oct 3, paid Mon Oct 5 — its Sep 5 payment for the Sep 3 occurrence
// landed in the same today-minus-a-month window, so $688.51 read as extra).
export function parkedOccurrenceSettledLate(opts: {
  nextDueDate: Date;
  weekStart: Date;
  owedCents: number;
  payments: { amountCents: number; occurredOn: Date }[];
}): boolean {
  if (opts.owedCents <= 0 || opts.nextDueDate >= opts.weekStart) return false;
  const lateCents = opts.payments
    .filter((p) => p.occurredOn >= opts.nextDueDate)
    .reduce((s, p) => s + Math.abs(p.amountCents), 0);
  return lateCents >= opts.owedCents;
}

// The celebratory badge on a debt row the payoff plan closes out this week
// (UpcomingBillsCard). Returns null for a row that isn't a projected payoff.
//
// "+$X For Payoff!" is only used when that $X is genuinely *additional* to a
// minimum being paid on the same row (minimumDueCents > 0) — a $25 minimum
// plus $35 extra to finish reads "+$35.00 For Payoff!". Otherwise it's the
// plain "Paid Off!": a no-minimum card, or one whose minimum was already paid
// earlier in the cycle so the whole closing payment counts as extra — there
// the "+$X" just restated the row's own headline amount ($37.72 payoff badged
// "+$37.72" beside a "$37.72" headline), and read inconsistently next to a
// no-minimum card's plain "Paid Off!" (real report, 2026-09-09: Capital One
// Quicksilver vs. Sam's Club Card).
export function payoffBadgeLabel(
  b: {
    extraCents: number;
    plannedExtraCents: number;
    minimumDueCents: number;
    paid: boolean;
    plannedPayoff: boolean;
  },
  formatCents: (cents: number) => string,
): string | null {
  if (!b.plannedPayoff) return null;
  const principalCents = principalTowardDebtCents(b);
  const payoffAmountCents = principalCents > 0 ? principalCents : b.plannedExtraCents;
  return payoffAmountCents > 0 && b.minimumDueCents > 0
    ? `+${formatCents(payoffAmountCents)} For Payoff!`
    : "Paid Off!";
}
