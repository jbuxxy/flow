// What a stale pending ("phantom") row hands its posted twin before it's
// deleted — see reconcileStalePendingRows in simplefin-sync.ts. Split out so
// the conflict rules are unit-testable without the db.

// Scalar classification a phantom pending row might have picked up before it
// went stale — migrated onto the posted twin only where the twin doesn't
// already have its own value (a differing value is a conflict → skip).
export const MIGRATABLE_ID_FIELDS = [
  "bucketId",
  "categoryId",
  "debtId",
  "billId",
  "incomeId",
  "patternId",
  "reimbursesTransactionId",
  "reimbursesMerchant",
  "aiSuggestedBucketId",
  "aiSuggestedCategoryId",
  "label",
  "notes",
] as const;

// Filing a bill-linked charge inherits from the bill (its bucket, its
// category). A posted twin that arrives while the phantom still holds the
// bill link can't claim the bill itself — that cycle already reads as paid —
// so it falls through to the generic merchant rule instead ("Apple" → One-offs
// because most Apple charges are App Store one-offs). Real report, 2026-09-30:
// the Sep iCloud+ charge's pending hold kept the bill, its posted twin landed
// in One-offs, the bucket/category "conflict" made the reconciler refuse the
// twin, and the hold's receipt then pinned the phantom in place forever. When
// the phantom has the bill and the twin has no link of its own, that filing
// is just the fallback, not a competing decision — the bill's wins.
const LINK_FIELDS: readonly string[] = ["billId", "debtId", "incomeId", "patternId"];
const BILL_DERIVED_FIELDS = new Set<string>(["bucketId", "categoryId", "aiSuggestedBucketId", "aiSuggestedCategoryId"]);

type Row = Record<string, unknown> & { isIncome: boolean; isTransfer: boolean; oneOff: boolean };

const isSet = (v: unknown) => v != null && v !== "";

// The update to apply to the twin. A confident twin always supersedes its
// phantom (household rule, 2026-09-30: "a pending charge should always be
// replaced by the actual processed transaction, regardless of bucket") — on a
// disagreement the posted row keeps its own value, bar the bill case above.
export function phantomTwinMergeData(phantom: Row, twin: Row): Record<string, unknown> {
  const billWins = isSet(phantom.billId) && !LINK_FIELDS.some((f) => isSet(twin[f]));
  // One link per charge: a twin already tied to a bill/debt/income/pattern
  // doesn't also pick up the phantom's.
  const twinLinked = LINK_FIELDS.some((f) => isSet(twin[f]));
  const data: Record<string, unknown> = {};
  for (const f of MIGRATABLE_ID_FIELDS) {
    const pv = phantom[f];
    const tv = twin[f];
    if (!isSet(pv)) continue;
    if (twinLinked && LINK_FIELDS.includes(f)) continue;
    if (!isSet(tv)) data[f] = pv;
    else if (tv !== pv) {
      if (billWins && BILL_DERIVED_FIELDS.has(f)) data[f] = pv;
    }
  }
  for (const f of ["isIncome", "isTransfer", "oneOff"] as const) {
    if (phantom[f] && !twin[f]) data[f] = true;
  }
  return data;
}

// Whether a still-pending row can be retired *now*. The general rule waits
// out a grace period after the row stops appearing in the feed (a one-off
// miss shouldn't delete it). But when this very sync dropped it AND brought
// in its one confident posted twin, the aggregator has plainly swapped the id
// — waiting only left both rows live through the sync's own categorization
// and bucket alerts, double-counting the charge (real report, 2026-10-05:
// SalonCentric + farm-supply posted twins sat beside their pending holds for an hour).
// "Dropped by this sync" = the upsert (which bumps updatedAt on every row it
// sees) didn't touch it; "twin from this sync" = it did touch the twin, which
// also proves the account itself synced this run.
export function pendingRowRetirable(opts: {
  pendingUpdatedAt: Date;
  twinUpdatedAt: Date | null;
  syncStartedAt: Date | null;
  graceCutoff: Date;
}): boolean {
  if (opts.pendingUpdatedAt < opts.graceCutoff) return true;
  return (
    opts.syncStartedAt != null &&
    opts.twinUpdatedAt != null &&
    opts.pendingUpdatedAt < opts.syncStartedAt &&
    opts.twinUpdatedAt >= opts.syncStartedAt
  );
}
