// Split out of recurring-bills.ts (which imports `db`) so client components —
// debt-row.tsx via minimum-ledger.ts — can use it without pulling a
// server-only module (pg: dns/fs/net) into the browser bundle. Keep this file
// free of imports.
//
// Allows real variance (a utility bill runs higher some months) without
// treating an unrelated same-ish-amount charge as a match — whichever
// tolerance is wider: 30% of the bill's tracked amount, or a flat $5 floor
// so small flat bills (a $9.64 Netflix charge) still get a little slack.
export function amountToleranceCents(billAmountCents: number): number {
  return Math.max(Math.round(billAmountCents * 0.3), 500);
}
