import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { periodBounds, currentPeriodKey } from "@/lib/period";
import { todayAsUTCDate } from "@/lib/date";
import {
  estimateVehicleValue,
  estimateHomeValue,
  type VehicleEstimateDetails,
  type HomeEstimateDetails,
} from "@/lib/ai";
import { type CryptoEstimateDetails, estimateCryptoValue } from "@/lib/crypto-lookup";
import { isDemoHousehold } from "@/lib/demo";

// No separate cron/worker process in this deployment (see
// instrumentation.ts) — same "check on page load, refresh if stale"
// pattern as BillsInsight and the monthly report, just gated to once a
// calendar month per asset instead of once a day. Only assets that opted in
// (estimateDetails set, via the vehicle/home fields on the add/edit form)
// are touched; a plain manually-entered asset is never called out to
// Gemini. A manual value edit (see updateAssetValue) also stamps
// estimateUpdatedAt, so correcting a bad AI number doesn't immediately get
// clobbered again on the next page load — only the next calendar month.
export async function refreshStaleAssetEstimates(householdId: string): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const { start } = periodBounds(currentPeriodKey());

  const stale = await db.asset.findMany({
    where: {
      householdId,
      estimateDetails: { not: Prisma.JsonNull },
      OR: [{ estimateUpdatedAt: null }, { estimateUpdatedAt: { lt: start } }],
    },
  });

  for (const asset of stale) {
    const estimate =
      asset.assetType === "VEHICLE_EQUITY"
        ? await estimateVehicleValue(householdId, asset.estimateDetails as unknown as VehicleEstimateDetails)
        : asset.assetType === "HOME_EQUITY"
          ? await estimateHomeValue(householdId, asset.estimateDetails as unknown as HomeEstimateDetails)
          : null;
    if (!estimate) continue;

    await db.asset.update({
      where: { id: asset.id },
      data: {
        valueCents: estimate.valueCents,
        asOfDate: todayAsUTCDate(), // @db.Date — local calendar day, not a raw UTC instant
        estimateUpdatedAt: new Date(),
        source: "AI_ESTIMATE",
      },
    });
  }
}

// CoinGecko is free and has no per-request cost worth rationing, so unlike
// the AI estimates above this refreshes every net worth page load instead
// of once a calendar month — a stale price on a volatile asset is a worse
// tradeoff here than an extra API call.
export async function refreshCryptoPrices(householdId: string): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const cryptoAssets = await db.asset.findMany({ where: { householdId, assetType: "CRYPTO" } });

  for (const asset of cryptoAssets) {
    const details = asset.estimateDetails as unknown as CryptoEstimateDetails | null;
    if (!details?.coinId || !details.quantity) continue;

    const estimate = await estimateCryptoValue(details);
    if (!estimate) continue;

    await db.asset.update({
      where: { id: asset.id },
      data: {
        valueCents: estimate.valueCents,
        asOfDate: todayAsUTCDate(), // @db.Date — local calendar day, not a raw UTC instant
        estimateUpdatedAt: new Date(),
        source: "LIVE_PRICE",
      },
    });
  }
}
