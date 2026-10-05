// Pure, no server imports (no `db`) — kept separate from networth.ts
// specifically so the client component asset-row.tsx can import
// isAssetStale without dragging Prisma/pg into the browser bundle (that
// happened once already: networth.ts also exports getNetWorth, which pulls
// in `db`, and Turbopack bundles a client-imported module's entire file,
// not just the one export used).
//
// A value nobody has touched in a while is a worse signal than an outdated
// AI/live-price estimate specifically — SIMPLEFIN/AI_ESTIMATE/LIVE_PRICE
// sources all restamp asOfDate on their own (sync, monthly re-estimate,
// every page load respectively), so this only ever actually fires for a
// MANUAL asset (a pension, an un-estimated home/vehicle, etc.) sitting
// untouched — deliberately one uniform check for every asset type rather
// than something AI-specific.
export const STALE_ASSET_MONTHS = 3;

export function isAssetStale(asOfDate: Date, now: Date = new Date()): boolean {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - STALE_ASSET_MONTHS);
  return asOfDate < cutoff;
}
