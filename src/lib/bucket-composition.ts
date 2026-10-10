import { db } from "@/lib/db";
import { daysAgo } from "@/lib/period";
import { effectiveMerchant } from "@/lib/p2p-keywords";
import { budgetTrackedWhere } from "@/lib/budget-tracked";
import type { BucketComposition, MerchantDigestEntry } from "@/lib/budget-plan";

// How far back the "what's actually in this bucket" / "which merchants dominate"
// rollup looks. Long enough to see a real merchant mix and roughly monthly
// volume, short enough to keep the report prompt a sane size.
const DIGEST_DAYS = 120;
// The window above is ~4 calendar months — what the per-merchant window totals
// get divided by for the "≈$X/mo" figure the allocator shows next to the
// (leading) last-month number.
const DIGEST_MONTHS = 4;
const MAX_HOUSEHOLD_MERCHANTS = 15;
const MAX_BUCKET_MERCHANTS = 5;
const MAX_BUCKET_LABELS = 3;
const MAX_BUCKET_CATEGORIES = 3;

const roundD = (cents: number) => Math.round(cents / 100) * 100;

// A yearly bill's payment in a RECURRING/MIXED bucket is left out of every
// history-derived figure the budget plan / report reads (Last Month, 3-Mo
// Avg, 12-Mo Avg, leanest month, the per-bucket merchant digest) — one $X
// annual charge otherwise inflates next month's suggested cap and the AI's
// read of what the bucket costs. The month it's actually due again,
// projectedRecurringCents (occurrencesInPeriod) puts it back as part of the
// bucket's floor (household rule 2026-09-30). A SPEND bucket has no
// projection to add it back, so there it stays in history.
export function excludeFromBucketHistory(
  trackingMode: "SPEND" | "RECURRING" | "MIXED" | string | undefined,
  billCadence: string | null | undefined,
): boolean {
  return billCadence === "ANNUAL" && (trackingMode === "RECURRING" || trackingMode === "MIXED");
}

// Top-N entries of a "key -> agg" map, sorted by dollars desc.
function topBy<T extends { sum: number; count: number }>(
  m: Map<string, T>,
  n: number,
): { key: string; value: T }[] {
  return [...m.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value.sum - a.value.sum || b.value.count - a.value.count)
    .slice(0, n);
}

function topKeys(m: Map<string, number>, n: number): string[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// One pass over the household's trailing-window spend, producing BOTH a
// household-wide top-merchants digest (the signal for a merchant-driven bucket
// split) AND a per-bucket merchant/label/category breakdown (what drives each
// existing cap). Feeds generateMonthlyReportContent via assembleBudgetPlanInputs.
export async function buildBucketAndMerchantDigest(householdId: string): Promise<{
  topMerchants: MerchantDigestEntry[];
  compositionByBucketName: Map<string, BucketComposition>;
}> {
  const since = daysAgo(DIGEST_DAYS);
  // Previous full calendar month, UTC (@db.Date fields are UTC midnight) — the
  // window the allocator leads with so "82×" doesn't read as one month.
  const nowD = new Date();
  const lastMonthStart = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 1));
  const inLastMonth = (d: Date) => d >= lastMonthStart && d < lastMonthEnd;
  const [txns, buckets, categories] = await Promise.all([
    db.transaction.findMany({
      where: {
        householdId,
        amountCents: { gt: 0 }, // debits only
        occurredOn: { gte: since },
        oneOff: false,
        isTransfer: false,
        isIncome: false,
        debtId: null,
        debtPaymentId: null,
        patternId: null,
        // One-time-bucket spend (a car down payment) isn't monthly spending —
        // it would otherwise surface as a "top merchant" and skew the budget
        // AI's merchant-bucket ideas. Uncategorized rows (no bucket) stay in.
        AND: [{ OR: [{ bucketId: null }, { bucket: { excludedFromAllocation: false } }] }],
        ...budgetTrackedWhere(),
      },
      select: {
        merchant: true,
        resolvedMerchant: true,
        resolvedMerchantIsPerson: true,
        label: true,
        categoryId: true,
        amountCents: true,
        bucketId: true,
        occurredOn: true,
        bill: { select: { cadence: true } },
      },
    }),
    db.bucket.findMany({ where: { householdId }, select: { id: true, name: true, trackingMode: true } }),
    db.billCategory.findMany({ where: { householdId }, select: { id: true, name: true } }),
  ]);

  const bucketName = new Map(buckets.map((b) => [b.id, b.name]));
  const bucketMode = new Map(buckets.map((b) => [b.id, b.trackingMode]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  type MerchAgg = {
    count: number;
    sum: number;
    min: number;
    max: number;
    buckets: Map<string, number>;
    categories: Set<string>;
    uncategorized: number;
  };
  type BucketMerchAgg = { count: number; sum: number; lmCount: number; lmSum: number };
  type BucketAgg = {
    count: number;
    sum: number;
    merchants: Map<string, BucketMerchAgg>;
    labels: Map<string, number>;
    categories: Map<string, number>;
  };

  const byMerchant = new Map<string, MerchAgg>();
  const byBucket = new Map<string, BucketAgg>();
  let denominator = 0;

  for (const t of txns) {
    // A receipt-resolved business counts under its own name; an unresolved
    // (or person-to-person) P2P charge says nothing about a merchant.
    const { merchant: effective, p2p } = effectiveMerchant(t);
    const merchant = effective.trim();
    if (!merchant || p2p) continue;
    if (t.bucketId && excludeFromBucketHistory(bucketMode.get(t.bucketId), t.bill?.cadence)) continue;
    denominator += 1;

    const me = byMerchant.get(merchant) ?? {
      count: 0,
      sum: 0,
      min: t.amountCents,
      max: t.amountCents,
      buckets: new Map<string, number>(),
      categories: new Set<string>(),
      uncategorized: 0,
    };
    me.count += 1;
    me.sum += t.amountCents;
    me.min = Math.min(me.min, t.amountCents);
    me.max = Math.max(me.max, t.amountCents);
    if (t.bucketId) me.buckets.set(t.bucketId, (me.buckets.get(t.bucketId) ?? 0) + 1);
    else me.uncategorized += 1;
    if (t.categoryId) me.categories.add(t.categoryId);
    byMerchant.set(merchant, me);

    if (t.bucketId) {
      const be = byBucket.get(t.bucketId) ?? {
        count: 0,
        sum: 0,
        merchants: new Map<string, BucketMerchAgg>(),
        labels: new Map<string, number>(),
        categories: new Map<string, number>(),
      };
      be.count += 1;
      be.sum += t.amountCents;
      const bm = be.merchants.get(merchant) ?? { count: 0, sum: 0, lmCount: 0, lmSum: 0 };
      bm.count += 1;
      bm.sum += t.amountCents;
      if (inLastMonth(t.occurredOn)) {
        bm.lmCount += 1;
        bm.lmSum += t.amountCents;
      }
      be.merchants.set(merchant, bm);
      const label = t.label?.trim();
      if (label) be.labels.set(label, (be.labels.get(label) ?? 0) + 1);
      const cat = t.categoryId ? categoryName.get(t.categoryId) : undefined;
      if (cat) be.categories.set(cat, (be.categories.get(cat) ?? 0) + 1);
      byBucket.set(t.bucketId, be);
    }
  }

  const topMerchants: MerchantDigestEntry[] = [...byMerchant.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].sum - a[1].sum)
    .slice(0, MAX_HOUSEHOLD_MERCHANTS)
    .map(([merchant, e]) => {
      const dominant = [...e.buckets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return {
        merchant,
        txnCount: e.count,
        sharePct: denominator > 0 ? Math.round((e.count / denominator) * 1000) / 10 : 0,
        totalCents: roundD(e.sum),
        minCents: roundD(e.min),
        maxCents: roundD(e.max),
        dominantBucket: dominant ? bucketName.get(dominant) ?? null : null,
        bucketSpread: e.buckets.size,
        categorySpread: e.categories.size,
        uncategorizedPct: e.count > 0 ? Math.round((e.uncategorized / e.count) * 1000) / 10 : 0,
      };
    });

  const compositionByBucketName = new Map<string, BucketComposition>();
  for (const [bucketId, e] of byBucket) {
    const name = bucketName.get(bucketId);
    if (!name) continue;
    compositionByBucketName.set(name, {
      totalCents: roundD(e.sum),
      txnCount: e.count,
      topMerchants: topBy(e.merchants, MAX_BUCKET_MERCHANTS).map(({ key, value: m }) => ({
        merchant: key,
        txnCount: m.count,
        totalCents: roundD(m.sum),
        lastMonthCents: roundD(m.lmSum),
        lastMonthTxnCount: m.lmCount,
        avgMonthlyCents: roundD(m.sum / DIGEST_MONTHS),
      })),
      topLabels: topKeys(e.labels, MAX_BUCKET_LABELS),
      topCategories: topKeys(e.categories, MAX_BUCKET_CATEGORIES),
    });
  }

  return { topMerchants, compositionByBucketName };
}
