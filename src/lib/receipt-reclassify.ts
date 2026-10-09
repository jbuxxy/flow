import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { suggestBucketsFromReceipts } from "@/lib/ai";
import { checkAndSendBucketAlertsFor } from "@/lib/buckets";
import { todayAsUTCDate } from "@/lib/date";
import { nameSimilarity } from "@/lib/fuzzy-match";

// A merchant rule files every "Sam's Club" charge under Groceries, but the
// matched email receipt for one of them says "16.059× Fuel - unlead" — that
// charge belongs in Fuel. This pass reads the receipt's line items (already
// frozen on Transaction.receiptItems by linkReceipt, which deliberately never
// touches buckets) and moves a transaction only when the items clearly belong
// elsewhere. Household request, 2026-09-21: "use receipt data to reclassify it
// automatically … for all receipt matches."
//
// Guard rails, since this moves money between buckets on its own:
//  - Runs at most once per transaction (Transaction.receiptReclassAt), and
//    reassignTransaction stamps the same field — a manual choice is final.
//  - Never learns or changes a MerchantRule: this is a per-transaction call
//    (a warehouse club legitimately spans groceries, fuel, tires…).
//  - Only plain, budget-tracked spend already sitting in an ordinary bucket;
//    bills, debt payments, P2P patterns, refunds and one-time buckets are
//    never touched, and the target must be an ordinary bucket too.
//  - The receipt must actually be *for this merchant*: receipts are matched to
//    charges by amount/date, and a $10 Google Cloud receipt once matched a $10
//    car-wash charge (2026-09-21 — the first run moved it to Retail on the
//    strength of "Google Cloud"). The receipt's resolved party has to resemble
//    the charge's merchant, or nothing happens.
//  - Only above RECLASS_MIN_CONFIDENCE, and only when the AI names a bucket
//    other than the current one.

// Deliberately stricter than the sync-time auto-apply: this overrides an
// existing bucket rather than filling an empty one.
export const RECLASS_MIN_CONFIDENCE = 0.9;
// Bounds AI spend/risk per sync and on the first run over already-matched
// receipts: recent charges only, a handful at a time.
const LOOKBACK_DAYS = 45;
const MAX_PER_RUN = 15;

// How alike the receipt's party and the charge's merchant must be — the
// containment tier ("Amazon" / "Amazon.com") passes, an unrelated name doesn't.
export const RECEIPT_MERCHANT_MIN_SIMILARITY = 0.7;

export type ReclassCandidateTx = {
  merchant: string;
  resolvedMerchant: string | null;
  amountCents: number;
  bucketId: string | null;
  isTransfer: boolean;
  isIncome: boolean;
  debtId: string | null;
  debtPaymentId: string | null;
  patternId: string | null;
  incomeId: string | null;
  billId: string | null;
  reimbursesTransactionId: string | null;
  receiptReclassAt: Date | null;
  receiptItems: unknown;
  account: { budgetTracked: boolean } | null;
};

export type ReclassBucket = { id: string; trackingMode: string; excludedFromAllocation: boolean };

// Pure — whether a transaction is even eligible to be looked at.
export function isReceiptReclassCandidate(t: ReclassCandidateTx, bucketById: Map<string, ReclassBucket>): boolean {
  if (t.receiptReclassAt !== null) return false;
  if (t.amountCents <= 0 || t.isTransfer || t.isIncome) return false;
  if (t.debtId || t.debtPaymentId || t.patternId || t.incomeId || t.billId || t.reimbursesTransactionId) return false;
  if (t.account && !t.account.budgetTracked) return false;
  if (!Array.isArray(t.receiptItems) || t.receiptItems.length === 0) return false;
  // Can't verify the receipt belongs to this charge without its party.
  if (!t.resolvedMerchant || nameSimilarity(t.merchant, t.resolvedMerchant) < RECEIPT_MERCHANT_MIN_SIMILARITY) return false;
  if (!t.bucketId) return false; // uncategorized: the normal categorization flow owns it
  return isOrdinaryBucket(bucketById.get(t.bucketId));
}

// A bucket that can be a source or target: not RECURRING (reachable only via a
// tracked bill) and not a one-time-purchase bucket (a lifetime target).
export function isOrdinaryBucket(b: ReclassBucket | undefined): boolean {
  return !!b && b.trackingMode !== "RECURRING" && !b.excludedFromAllocation;
}

// Pure — the bucket id to move to, or null to leave it where it is.
export function decideReceiptReclass(opts: {
  currentBucketId: string;
  suggestedBucketId: string | null;
  confidence: number;
  targetIsOrdinary: boolean;
}): string | null {
  if (!opts.suggestedBucketId || opts.suggestedBucketId === opts.currentBucketId) return null;
  if (opts.confidence < RECLASS_MIN_CONFIDENCE || !opts.targetIsOrdinary) return null;
  return opts.suggestedBucketId;
}

export async function reclassifyFromReceipts(householdId: string): Promise<void> {
  const since = new Date(todayAsUTCDate().getTime() - LOOKBACK_DAYS * 86_400_000);
  const [buckets, txns] = await Promise.all([
    db.bucket.findMany({
      where: { householdId, retiredAt: null },
      select: { id: true, name: true, trackingMode: true, excludedFromAllocation: true, aiInstructions: true },
    }),
    db.transaction.findMany({
      where: {
        householdId,
        receiptReclassAt: null,
        receiptItems: { not: Prisma.DbNull },
        bucketId: { not: null },
        amountCents: { gt: 0 },
        occurredOn: { gte: since },
      },
      orderBy: { occurredOn: "desc" },
      take: MAX_PER_RUN * 3,
      select: {
        id: true,
        merchant: true,
        resolvedMerchant: true,
        amountCents: true,
        bucketId: true,
        isTransfer: true,
        isIncome: true,
        debtId: true,
        debtPaymentId: true,
        patternId: true,
        incomeId: true,
        billId: true,
        reimbursesTransactionId: true,
        receiptReclassAt: true,
        receiptItems: true,
        account: { select: { budgetTracked: true } },
      },
    }),
  ]);
  const bucketById = new Map(buckets.map((b) => [b.id, b]));
  const candidates = txns.filter((t) => isReceiptReclassCandidate(t, bucketById)).slice(0, MAX_PER_RUN);
  if (candidates.length === 0) return;

  const targets = buckets.filter((b) => isOrdinaryBucket(b));
  const nameById = new Map(buckets.map((b) => [b.id, b.name]));
  const idByLowerName = new Map(targets.map((b) => [b.name.toLowerCase(), b.id]));

  const suggestions = await suggestBucketsFromReceipts(
    householdId,
    candidates.map((t) => ({
      key: t.id,
      merchant: t.merchant,
      amountCents: t.amountCents,
      currentBucketName: nameById.get(t.bucketId!) ?? "",
      items: (t.receiptItems as { description: string; qty: number | null; totalCents: number | null }[]).map((i) => ({
        description: i.description,
        qty: i.qty ?? null,
        totalCents: i.totalCents ?? null,
      })),
    })),
    targets.map((b) => ({ id: b.id, name: b.name, aiInstructions: b.aiInstructions })),
  );
  // No provider / call failed: record nothing, try again next sync.
  if (!suggestions) return;

  const touchedBuckets = new Set<string>();
  for (const t of candidates) {
    const s = suggestions.get(t.id);
    // The model skipped this one — leave it unmarked and retry next sync.
    if (!s) continue;
    const suggestedId = s.bucketName ? (idByLowerName.get(s.bucketName.toLowerCase()) ?? null) : null;
    const moveTo = decideReceiptReclass({
      currentBucketId: t.bucketId!,
      suggestedBucketId: suggestedId,
      confidence: s.confidence,
      targetIsOrdinary: suggestedId !== null,
    });
    // Conditional on receiptReclassAt still being null: a manual reassign that
    // landed between the read above and this write wins.
    const res = await db.transaction.updateMany({
      where: { id: t.id, receiptReclassAt: null },
      data: {
        receiptReclassAt: new Date(),
        ...(moveTo
          ? { bucketId: moveTo, categoryId: null, aiSuggestedBucketId: null, aiSuggestedCategoryId: null }
          : {}),
      },
    });
    if (moveTo && res.count > 0) {
      touchedBuckets.add(moveTo);
      touchedBuckets.add(t.bucketId!);
    }
  }
  // Spend totals moved between buckets — re-check both sides' alerts.
  await checkAndSendBucketAlertsFor(touchedBuckets);
}
