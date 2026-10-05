import { db } from "@/lib/db";
import { daysAgo } from "@/lib/period";
import { budgetTrackedWhere } from "@/lib/budget-tracked";
import { simulateMerchantRoute, type RouteBand } from "@/lib/merchant-route";
import type { BudgetBucketRow, BudgetNewBucket } from "@/lib/budget-plan";

// The DB half of a budget-plan merchant route (the pure half is
// simulateMerchantRoute, merchant-route.ts). Same ~4-month window and
// transaction filter as the bucket/merchant digest (bucket-composition.ts),
// so a carve figure lines up with the avgMonthlyCents the AI was shown.
const ROUTE_WINDOW_DAYS = 120;
const ROUTE_WINDOW_MONTHS = 4;

const roundDollars = (cents: number) => Math.round(cents / 100) * 100;

async function loadMerchantHistory(householdId: string, merchantKeys: string[]) {
  if (merchantKeys.length === 0) return { rules: [], txns: [] };
  const [rules, txns] = await Promise.all([
    db.merchantRule.findMany({
      where: { householdId, merchant: { in: merchantKeys } },
      select: {
        merchant: true,
        bucketId: true,
        amountMinCents: true,
        amountMaxCents: true,
        source: true,
        confidence: true,
      },
    }),
    db.transaction.findMany({
      where: {
        householdId,
        // AND-wrapped: budgetTrackedWhere() below spreads its own top-level
        // OR, which would silently replace a bare `OR:` here.
        AND: [{ OR: merchantKeys.map((k) => ({ merchant: { equals: k, mode: "insensitive" as const } })) }],
        amountCents: { gt: 0 },
        occurredOn: { gte: daysAgo(ROUTE_WINDOW_DAYS) },
        oneOff: false,
        isTransfer: false,
        isIncome: false,
        debtId: null,
        debtPaymentId: null,
        patternId: null,
        billId: null,
        ...budgetTrackedWhere(),
      },
      select: { merchant: true, amountCents: true, bucketId: true },
    }),
  ]);
  return { rules, txns };
}

export type MerchantAmountRuleSummary = {
  merchant: string;
  minCents: number;
  maxCents: number;
  bucketName: string | null;
  avgMonthlyCents: number;
};

// Every amount-banded rule the household has, with what each band has
// actually cost per month — fed to the AI (budgetInputs.merchantAmountRules)
// so a merchant-bucket idea knows those bands outrank a whole-merchant route.
export async function getMerchantAmountRules(householdId: string): Promise<MerchantAmountRuleSummary[]> {
  const bounded = await db.merchantRule.findMany({
    where: { householdId, amountMinCents: { not: null }, amountMaxCents: { not: null } },
    select: { merchant: true, amountMinCents: true, amountMaxCents: true, bucket: { select: { name: true } } },
  });
  if (bounded.length === 0) return [];
  const { txns } = await loadMerchantHistory(householdId, [...new Set(bounded.map((r) => r.merchant))]);
  return bounded.map((r) => {
    const inBand = txns.filter(
      (t) =>
        t.merchant.trim().toLowerCase() === r.merchant &&
        t.amountCents >= r.amountMinCents! &&
        t.amountCents <= r.amountMaxCents!,
    );
    return {
      merchant: r.merchant,
      minCents: r.amountMinCents!,
      maxCents: r.amountMaxCents!,
      bucketName: r.bucket?.name ?? null,
      avgMonthlyCents: roundDollars(inBand.reduce((s, t) => s + t.amountCents, 0) / ROUTE_WINDOW_MONTHS),
    };
  });
}

// Fills in each merchant idea's carve from what routing would *really* move
// under the household's current rules (simulateMerchantRoute): the source
// bucket is whichever (non-RECURRING) plan bucket holds the most of the moved
// spend, and the carve is that bucket's moved monthly average.
// routeMovesNothing flags an idea whose route the existing amount rules would
// completely shadow — the allocator then disables routing for it instead of
// carving a budget for spend that would never arrive.
export async function resolveNewBucketRoutes(
  householdId: string,
  newBuckets: BudgetNewBucket[],
  bucketRows: BudgetBucketRow[],
): Promise<BudgetNewBucket[]> {
  const keys = [
    ...new Set(newBuckets.flatMap((nb) => (nb.sourceMerchant ? [nb.sourceMerchant.trim().toLowerCase()] : []))),
  ];
  if (keys.length === 0) return newBuckets;
  const { rules, txns } = await loadMerchantHistory(householdId, keys);
  const plannable = new Map(
    bucketRows.filter((b) => b.trackingMode !== "RECURRING").map((b) => [b.bucketId, b.name]),
  );
  const bucketNameById = new Map(bucketRows.map((b) => [b.bucketId, b.name]));

  return newBuckets.map((nb) => {
    if (!nb.sourceMerchant) return nb;
    const key = nb.sourceMerchant.trim().toLowerCase();
    const merchantRules = rules.filter((r) => r.merchant === key);
    const band: RouteBand | null =
      nb.routeAmountMinCents != null && nb.routeAmountMaxCents != null
        ? { minCents: nb.routeAmountMinCents, maxCents: nb.routeAmountMaxCents }
        : null;
    const { movedCentsByBucket, movedCount } = simulateMerchantRoute(
      merchantRules,
      band,
      txns.filter((t) => t.merchant.trim().toLowerCase() === key),
    );

    let sourceBucketId: string | null = null;
    let sourceMoved = 0;
    for (const [bucketId, cents] of movedCentsByBucket) {
      if (bucketId && plannable.has(bucketId) && cents > sourceMoved) {
        sourceBucketId = bucketId;
        sourceMoved = cents;
      }
    }
    return {
      ...nb,
      sourceBucketId,
      carveFromSourceCents: roundDollars(sourceMoved / ROUTE_WINDOW_MONTHS),
      // No history at all isn't "shadowed" — a brand-new merchant can still
      // route fine; only flag when there's spend and none of it would move.
      routeMovesNothing: movedCount === 0 && txns.some((t) => t.merchant.trim().toLowerCase() === key),
      existingAmountRules: merchantRules
        .filter((r) => r.amountMinCents != null && r.amountMaxCents != null)
        .map((r) => ({
          minCents: r.amountMinCents!,
          maxCents: r.amountMaxCents!,
          bucketName: (r.bucketId && bucketNameById.get(r.bucketId)) || null,
        })),
    };
  });
}
