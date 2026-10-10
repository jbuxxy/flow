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

// Greedy 1D clustering by amount: sorted ascending, each charge joins the
// current cluster while it's within amountToleranceCents of that cluster's
// running average. Tells apart same-merchant series by size — a $12.95/mo
// fee inside hundreds of differently-priced runs at the same retailer
// (bill-detect.ts), two simultaneous plans at one BNPL provider
// (bnpl-detect.ts), a recurring merchant's charge sizes (keyword-learning.ts).
export function clusterByAmount<T extends { amountCents: number }>(group: T[]): T[][] {
  const sorted = [...group].sort((a, b) => a.amountCents - b.amountCents);
  const clusters: T[][] = [];
  for (const t of sorted) {
    const current = clusters[clusters.length - 1];
    const avg = current ? current.reduce((s, x) => s + x.amountCents, 0) / current.length : 0;
    if (current && Math.abs(t.amountCents - avg) <= amountToleranceCents(avg)) {
      current.push(t);
    } else {
      clusters.push([t]);
    }
  }
  return clusters;
}
