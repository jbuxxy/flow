// A recurring bill's price creeping up a few cents (sales tax, a rounding
// change) after the month's budget was confirmed used to tip its RECURRING/
// MIXED bucket "over budget" — 2026-10-25: Subscriptions sat at $58.75 /
// $58.66 because Prime, Anthropic and Netflix each went up 2-4¢. The bucket's
// cap absorbs that drift, bounded so a real price hike still reads as over
// (and the bill-amount review, bill-notice-sync.ts, still asks about it).

export const DRIFT_ALLOWANCE_PCT = 0.03;
export const DRIFT_ALLOWANCE_MIN_CENTS = 100;

// How much of a bill's increase over its previous payment counts as drift:
// all of it when within max(3%, $1) of the previous amount, none when it's
// bigger than that (a real price change, not drift) or when it went down.
export function billDriftCents(previousCents: number, currentCents: number): number {
  const drift = currentCents - previousCents;
  if (drift <= 0) return 0;
  const allowance = Math.max(Math.round(previousCents * DRIFT_ALLOWANCE_PCT), DRIFT_ALLOWANCE_MIN_CENTS);
  return drift <= allowance ? drift : 0;
}

// The cap grows only as far as the bucket is actually over, never past the
// drift — a budget confirmed after the new price is already in the cap, and
// adding the drift again would leave the bucket reading under budget.
export function driftCapBumpCents(capCents: number, spentCents: number, driftCents: number): number {
  return Math.min(driftCents, Math.max(0, spentCents - capCents));
}
