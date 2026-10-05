import { db } from "@/lib/db";
import { isAssetStale, STALE_ASSET_MONTHS } from "@/lib/asset-staleness";
import { daysAgo } from "@/lib/period";

export type StaleAsset = { id: string; name: string };

// Dashboard-card source for "Asset values need a check," filtered through
// a per-asset dismissal. No natural "cycle" to anchor a redisplay to (a
// household could ignore a stale MANUAL asset indefinitely without ever
// touching it) — a flat snooze instead, matching the same
// STALE_ASSET_MONTHS cadence the underlying staleness check itself uses:
// dismiss it, and it stays quiet for as long as a fresh value would have.
// Actually updating the asset (the real fix) clears staleness outright and
// drops it from the underlying query regardless of any dismissal.
export async function getActiveStaleAssets(householdId: string): Promise<StaleAsset[]> {
  const assets = await db.asset.findMany({ where: { householdId }, select: { id: true, name: true, asOfDate: true } });
  const now = new Date();
  const stale = assets.filter((a) => isAssetStale(a.asOfDate, now));
  if (stale.length === 0) return [];

  const dismissals = await db.suggestionDismissal.findMany({
    where: { householdId, kind: "STALE_ASSET", key: { in: stale.map((a) => a.id) } },
    select: { key: true, createdAt: true },
  });
  const dismissedAtByKey = new Map(dismissals.map((d) => [d.key, d.createdAt]));
  const snoozeCutoff = daysAgo(STALE_ASSET_MONTHS * 30);

  return stale
    .filter((a) => {
      const dismissedAt = dismissedAtByKey.get(a.id);
      return !dismissedAt || dismissedAt < snoozeCutoff;
    })
    .map((a) => ({ id: a.id, name: a.name }));
}

export async function dismissStaleAsset(householdId: string, assetId: string): Promise<void> {
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId, kind: "STALE_ASSET", key: assetId } },
    create: { householdId, kind: "STALE_ASSET", key: assetId },
    update: { createdAt: new Date() },
  });
}

export async function getNetWorth(householdId: string) {
  // Every caller of getNetWorth is already gated behind canViewNetWorth
  // (OWNER-only — see src/app/page.tsx and src/app/networth/page.tsx), which
  // is the same bar canViewAccountBalance uses for CHECKING/SAVINGS, so
  // pulling raw cash balances in here needs no extra access check.
  const [assets, debtAgg, cashAccounts] = await Promise.all([
    db.asset.findMany({
      where: { householdId },
      orderBy: { createdAt: "asc" },
      // debt: the linked mortgage/auto loan (see Asset.debtId) — its balance
      // (so a HOME_EQUITY/VEHICLE_EQUITY row can show equity without a second
      // round trip) and its own synced account's friendly name + institution
      // ("Van" / "Canyon Credit Union") for that row's headline and
      // middle line; see AssetRow.
      include: {
        debt: {
          select: {
            id: true,
            name: true,
            balanceCents: true,
            account: { select: { displayName: true, orgName: true } },
          },
        },
      },
    }),
    // hiddenAt: null — a debt whose account vanished from the SimpleFIN feed
    // (hideAccountsWithLinkedDebts, simplefin-sync.ts) is hidden with
    // whatever its last-known balance was, no balance-zero requirement
    // (unlike the manual hideDebt action) — without this filter a debt that
    // left the feed mid-balance keeps counting against net worth forever.
    db.debt.aggregate({ where: { householdId, hiddenAt: null }, _sum: { balanceCents: true } }),
    db.account.findMany({
      // hiddenAt: null — mirrors reports.ts/budget-plan.ts's cash-account
      // queries, which both document filtering the same way this one
      // previously claimed to but didn't (2026-09-11 fix): an account
      // hidden after vanishing from the feed kept counting its stale
      // balance toward net worth forever.
      where: { householdId, accountType: { in: ["CHECKING", "SAVINGS"] }, excludedFromNetWorth: false, hiddenAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        orgName: true,
        accountType: true,
        balanceCents: true,
      },
    }),
  ]);

  const totalAssetsCents = assets.reduce((sum, a) => sum + a.valueCents, 0);
  const totalDebtsCents = debtAgg._sum.balanceCents ?? 0;
  const liquidCashCents = cashAccounts.reduce((sum, a) => sum + a.balanceCents, 0);
  const netWorthCents = totalAssetsCents + liquidCashCents - totalDebtsCents;

  return { assets, totalAssetsCents, totalDebtsCents, liquidCashCents, cashAccounts, netWorthCents };
}
