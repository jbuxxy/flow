// The slice of a bucket-assigned debt payment that counts as *budgeted*
// spend for its bucket. Its own leaf module (not buckets.ts, where this
// used to live) so spend.ts can import it too, for the dashboard trend
// card's Bills series (2026-09-17) — buckets.ts itself imports SPEND_TX_SELECT/
// netSpendCents from spend.ts, so spend.ts importing back from buckets.ts
// would be a cycle (same reasoning as budget-tracked.ts's own leaf-module
// split).
//
// Payoff plan ON (Household.payoffPlanEnabled): every dollar toward a
// bucket-assigned debt is intentional planned paydown — it all counts, no
// ceiling, and the spend breakdown shows no "extra paydown" annotation
// (2026-09-09 household call — the earlier per-cycle ceiling made a routine
// extra card payment look like it fell out of the bucket).
//
// Payoff plan OFF: the bucket cap was only ever sized for the expected
// minimum(s). Anything paid beyond that this cycle is an ad-hoc lump — real
// debt paydown, but surfaced on its own in the spend breakdown rather than
// folded into the bucket total. Grouped per DebtPayment because the ceiling
// is a per-debt, per-cycle concept, not a per-transaction one.
export function budgetedDebtPaymentCents(args: {
  // Sum of the debt's payments in the period (abs), already net of any
  // accountedFor (double-counted linked purchase) exclusion.
  paidCents: number;
  minimumCents: number;
  occurrencesThisPeriod: number;
  payoffPlanEnabled: boolean;
}): { countedCents: number; excludedCents: number } {
  if (args.payoffPlanEnabled) {
    return { countedCents: Math.max(0, args.paidCents), excludedCents: 0 };
  }
  const ceilingCents = args.minimumCents * Math.max(1, args.occurrencesThisPeriod);
  const countedCents = Math.max(0, Math.min(args.paidCents, ceilingCents));
  return { countedCents, excludedCents: Math.max(0, args.paidCents - countedCents) };
}
