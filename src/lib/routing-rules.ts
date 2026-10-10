import { db } from "@/lib/db";
import { parseRoutingRuleFromText, type RoutingContextMerchant } from "@/lib/ai";
import { getHouseholdSavingsCapacity } from "@/lib/savings";
import { isP2PMerchant } from "@/lib/p2p-keywords";
import { belongsToHousehold } from "@/lib/access-rules";

// How far back the merchant snapshot handed to the AI looks. Long enough to
// see a merchant's real spread of charge sizes and roughly monthly volume,
// short enough to stay a sane prompt size.
const SNAPSHOT_DAYS = 120;
const MAX_SNAPSHOT_MERCHANTS = 80;

// The confirmed, id-resolved proposal the composer renders and sends back to
// applyRoutingRule — every bucket here is a real one the household owns.
export type RoutingRulePreview = {
  understood: boolean;
  restatement: string;
  maxCents: number;
  merchants: string[];
  note: string | null;
  // How many already-synced transactions a backfill would re-file.
  backfillCount: number;
  target:
    | { kind: "existing"; bucketId: string; bucketName: string }
    | {
        kind: "new";
        name: string;
        capCents: number;
        rationale: string | null;
        adjustments: { bucketId: string; bucketName: string; fromCapCents: number; toCapCents: number }[];
      }
    | null;
};

async function buildMerchantSnapshot(householdId: string): Promise<RoutingContextMerchant[]> {
  const since = new Date();
  since.setDate(since.getDate() - SNAPSHOT_DAYS);

  const [txns, buckets] = await Promise.all([
    db.transaction.findMany({
      where: {
        householdId,
        amountCents: { gt: 0 }, // debits only
        occurredOn: { gte: since },
        oneOff: false,
      },
      select: { merchant: true, amountCents: true, bucketId: true },
    }),
    db.bucket.findMany({ where: { householdId }, select: { id: true, name: true } }),
  ]);
  const bucketName = new Map(buckets.map((b) => [b.id, b.name]));

  const byMerchant = new Map<string, { count: number; min: number; max: number; buckets: Map<string, number> }>();
  for (const t of txns) {
    const key = t.merchant.trim();
    if (!key || isP2PMerchant(key)) continue;
    const e = byMerchant.get(key) ?? { count: 0, min: t.amountCents, max: t.amountCents, buckets: new Map() };
    e.count += 1;
    e.min = Math.min(e.min, t.amountCents);
    e.max = Math.max(e.max, t.amountCents);
    if (t.bucketId) e.buckets.set(t.bucketId, (e.buckets.get(t.bucketId) ?? 0) + 1);
    byMerchant.set(key, e);
  }

  return [...byMerchant.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, MAX_SNAPSHOT_MERCHANTS)
    .map(([merchant, e]) => {
      const topBucket = [...e.buckets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return {
        merchant,
        txnCount: e.count,
        minCents: e.min,
        maxCents: e.max,
        currentBucket: topBucket ? (bucketName.get(topBucket) ?? null) : null,
      };
    });
}

// Counts the transactions a freshly-created bounded rule would re-file — the
// same conservative set reassignTransactionsForMerchant actually sweeps
// (see that function), scoped to the matched merchants + amount and to the
// "from" bucket / uncategorised / transfer state.
async function countBackfill(
  householdId: string,
  merchants: string[],
  maxCents: number,
  fromBucketId: string,
): Promise<number> {
  if (merchants.length === 0) return 0;
  return db.transaction.count({
    where: {
      householdId,
      merchant: { in: merchants, mode: "insensitive" },
      amountCents: { gt: 0, lte: maxCents },
      oneOff: false,
      billId: null,
      debtId: null,
      debtPaymentId: null,
      patternId: null,
      incomeId: null,
      OR: [{ bucketId: fromBucketId }, { bucketId: null }, { isTransfer: true }, { isIncome: true }],
    },
  });
}

export async function previewRoutingRule(
  householdId: string,
  text: string,
  fromBucketId: string,
): Promise<{ preview: RoutingRulePreview | null; error: string | null }> {
  const trimmed = text.trim();
  if (trimmed.length < 8) return { preview: null, error: "Say a bit more about the rule you want." };

  const [fromBucket, buckets, capacity, merchants] = await Promise.all([
    db.bucket.findUnique({ where: { id: fromBucketId }, select: { id: true, name: true, householdId: true } }),
    db.bucket.findMany({
      where: { householdId, trackingMode: { not: "RECURRING" }, retiredAt: null },
      select: { id: true, name: true, monthlyCapCents: true },
      orderBy: { sortOrder: "asc" },
    }),
    getHouseholdSavingsCapacity(householdId),
    buildMerchantSnapshot(householdId),
  ]);
  if (!belongsToHousehold(fromBucket, householdId)) return { preview: null, error: "Bucket not found." };

  const parsed = await parseRoutingRuleFromText(householdId, {
    text: trimmed,
    fromBucketName: fromBucket.name,
    buckets: buckets.map((b) => ({ name: b.name, monthlyCapCents: b.monthlyCapCents })),
    merchants,
    incomeCents: capacity.incomeCents,
    totalCapsCents: capacity.bucketCapsCents,
    unallocatedCents: capacity.estimatedMonthlySaveableCents,
  });
  if (!parsed) return { preview: null, error: "The AI assistant isn't reachable right now — try again in a moment." };

  const byLowerName = new Map(buckets.map((b) => [b.name.toLowerCase(), b]));
  const knownMerchants = new Set(merchants.map((m) => m.merchant.toLowerCase()));
  // The model is told to copy merchant strings verbatim from the snapshot;
  // drop anything that isn't actually one of them.
  const resolvedMerchants = [...new Set(parsed.merchants.filter((m) => knownMerchants.has(m.toLowerCase())))];

  let target: RoutingRulePreview["target"] = null;
  if (parsed.understood && parsed.maxCents > 0 && resolvedMerchants.length > 0) {
    if (parsed.targetKind === "existing" && parsed.existingBucketName) {
      const b = byLowerName.get(parsed.existingBucketName.toLowerCase());
      if (b) target = { kind: "existing", bucketId: b.id, bucketName: b.name };
    } else if (parsed.targetKind === "new" && parsed.newBucketName && parsed.newBucketCapCents != null) {
      const adjustments = parsed.adjustments
        .map((a) => {
          const b = byLowerName.get(a.bucketName.toLowerCase());
          return b ? { bucketId: b.id, bucketName: b.name, fromCapCents: b.monthlyCapCents, toCapCents: Math.max(0, a.newCapCents) } : null;
        })
        .filter((a): a is NonNullable<typeof a> => a !== null);
      target = {
        kind: "new",
        name: parsed.newBucketName,
        capCents: Math.max(0, parsed.newBucketCapCents),
        rationale: parsed.newBucketRationale,
        adjustments,
      };
    }
  }

  const backfillCount =
    target && resolvedMerchants.length > 0
      ? await countBackfill(householdId, resolvedMerchants, parsed.maxCents, fromBucket.id)
      : 0;

  return {
    preview: {
      understood: parsed.understood && resolvedMerchants.length > 0 && target !== null,
      restatement: parsed.restatement,
      maxCents: parsed.maxCents,
      merchants: resolvedMerchants,
      note:
        parsed.note ??
        (parsed.understood && resolvedMerchants.length === 0
          ? "None of your recent merchants seemed to match that description."
          : parsed.understood && target === null
            ? "I couldn't pin down which bucket these should go to."
            : null),
      backfillCount,
      target,
    },
    error: null,
  };
}
