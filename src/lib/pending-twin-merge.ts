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

// Fields that say what the charge IS. A transaction carries one
// classification, so these move as a group: an unfiled twin takes the
// phantom's whole classification, a filed twin keeps its own and takes none
// of it. Merging field by field used to mix them — a twin auto-linked as a
// card payment (debtId + isTransfer) also picked up the hold's Groceries
// bucketId and counted as both (2026-10-08 review).
const CLASSIFICATION_FIELDS = new Set<string>([
  "bucketId",
  "categoryId",
  "debtId",
  "billId",
  "incomeId",
  "patternId",
  "aiSuggestedBucketId",
  "aiSuggestedCategoryId",
]);
const CLASSIFICATION_FLAGS = ["isIncome", "isTransfer", "oneOff"] as const;

// The update to apply to the twin. A confident twin always supersedes its
// phantom (household rule, 2026-09-30: "a pending charge should always be
// replaced by the actual processed transaction, regardless of bucket") — a
// filed twin keeps its own classification, bar the bill case above.
// Non-classification fields (label, notes, reimbursement links) fill in
// wherever the twin has none of its own.
export function phantomTwinMergeData(phantom: Row, twin: Row): Record<string, unknown> {
  const twinLinked = LINK_FIELDS.some((f) => isSet(twin[f]));
  const twinFiled =
    twinLinked || isSet(twin.bucketId) || isSet(twin.categoryId) || twin.isIncome || twin.isTransfer;
  // The bill's filing beats a twin's generic merchant-rule fallback, but not
  // a twin that's a debt payment or income.
  const billWins = isSet(phantom.billId) && !twinLinked && !twin.isIncome && !twin.isTransfer;

  const data: Record<string, unknown> = {};
  for (const f of MIGRATABLE_ID_FIELDS) {
    const pv = phantom[f];
    if (!isSet(pv)) continue;
    if (CLASSIFICATION_FIELDS.has(f)) {
      if (!twinFiled) data[f] = pv;
      else if (billWins && (f === "billId" || BILL_DERIVED_FIELDS.has(f)) && twin[f] !== pv) data[f] = pv;
    } else if (!isSet(twin[f])) {
      data[f] = pv;
    }
  }
  if (!twinFiled) {
    for (const f of CLASSIFICATION_FLAGS) {
      if (phantom[f] && !twin[f]) data[f] = true;
    }
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

// A stale pending row with no posted twin that a card payment was already
// confirmed to cover ("already accounted for") is a real, settled charge —
// the payment proves it — whose posted copy the aggregator just never
// delivered. Deleting it would drop a real purchase from its bucket and
// orphan the payment's link (the payment then double-counts); leaving it
// meant pending forever. Settle it in place instead — but only once it's been
// gone from the feed as long as an orphaned receipt waits, so a twin that's
// merely slow to post still gets the normal merge. Real report, 2026-10-06: a
// $141.49 Sam's Club hold on the Synchrony card sat pending 10 days after the
// household paid it, its posted charge never sent.
export function settleOrphanPendingInPlace(opts: {
  hasTwin: boolean;
  accountedForLinks: number;
  pendingUpdatedAt: Date;
  orphanCutoff: Date;
}): boolean {
  return !opts.hasTwin && opts.accountedForLinks > 0 && opts.pendingUpdatedAt < opts.orphanCutoff;
}
