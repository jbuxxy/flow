import { redirect } from "next/navigation";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getNetWorth } from "@/lib/networth";
import {
  recordNetWorthSnapshot,
  getNetWorthTrend,
  getNetWorthMonthlyHistory,
  type NetWorthMonthlyPoint,
} from "@/lib/networth-history";
import { currentPeriodKey } from "@/lib/period";
import { canViewNetWorth } from "@/lib/access";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { AppShell } from "@/components/app-shell";
import { StatCard } from "@/components/stat-card";
import { CollapsibleGroup } from "@/components/collapsible-group";
import { NetWorthTrendChart } from "@/components/net-worth-trend-chart";
import { getUntrackedInvestmentAccounts } from "@/lib/untracked-investments";
import { refreshStaleAssetEstimates, refreshCryptoPrices } from "@/lib/asset-estimate";
import type { CryptoEstimateDetails } from "@/lib/crypto-lookup";
import { AssetRow } from "./asset-row";
import { AddAssetForm } from "./add-asset-form";
import { CashAccountRow } from "./cash-account-row";
import { NotCountedAccounts, type NotCountedAccountData } from "./not-counted-accounts";
import type { AssetType } from "@prisma/client";

// Condensed net worth grouped by type, each section collapsible on its own
// (see CollapsibleGroup) — Cash is its own group (Account, not Asset rows),
// the rest partition AssetType. A group with zero matching entries just
// doesn't render, so a household with no crypto never sees an empty "Crypto"
// section. Alphabetical order (Cash's own section is rendered separately,
// above this list, but happens to sort first anyway).
const ASSET_GROUPS: { label: string; types: AssetType[] }[] = [
  { label: "Crypto", types: ["CRYPTO"] },
  { label: "Home & Vehicle", types: ["HOME_EQUITY", "VEHICLE_EQUITY"] },
  { label: "Investments", types: ["INVESTMENT"] },
  { label: "Other", types: ["OTHER"] },
  { label: "Retirement", types: ["RETIREMENT_401K", "RETIREMENT_IRA", "RETIREMENT_PENSION"] },
];

// HOME_EQUITY/VEHICLE_EQUITY assets with a linked debt (see Asset.debtId)
// display as equity here — full value minus what's owed — matching the
// per-row headline AssetRow shows for that same asset. Deliberately used
// ONLY for the per-group subtotal shown next to each collapsible section
// header, never for the top-level "Assets" stat box (see totalAssetsCents
// below, always full value) or the netWorthCents math itself (computed in
// getNetWorth from full asset value minus full debt balance, unaffected by
// any asset-debt link) — mixing equity into either of those breaks the
// Cash + Assets − Debts = Net worth arithmetic, since "Debts" is always the
// full balance of every debt, linked or not.
function displayCentsFor(asset: { assetType: AssetType; valueCents: number; debt: { balanceCents: number } | null }) {
  const isAppreciable = asset.assetType === "HOME_EQUITY" || asset.assetType === "VEHICLE_EQUITY";
  return isAppreciable && asset.debt ? asset.valueCents - asset.debt.balanceCents : asset.valueCents;
}

// Pure "YYYY-MM" arithmetic, n months before periodKey — no Date object
// involved, so this stays safe to call from a server component render body.
function monthsBefore(periodKey: string, n: number): string {
  const [y, m] = periodKey.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}`;
}

// TEMPORARY — a fake multi-year monthly series so the trend chart's year
// toggle / "Since start" view can be checked visually before real accounts
// have more than a few days of actual snapshot history to render. Remove
// this function and the `?chartTest=1` branch below once verified.
function buildTestMonthlyHistory(nowPeriodKey: string, endCents: number): NetWorthMonthlyPoint[] {
  const MONTHS = 31;
  const points: NetWorthMonthlyPoint[] = [];
  let value = endCents - 260_000_00;
  for (let i = 0; i < MONTHS; i++) {
    const wobble = Math.sin(i * 0.7) * 8_000_00 - (i % 5 === 0 ? 15_000_00 : 0);
    value += 8_500_00 + wobble;
    points.push({ periodKey: monthsBefore(nowPeriodKey, MONTHS - 1 - i), netWorthCents: Math.round(value) });
  }
  points[points.length - 1] = { periodKey: nowPeriodKey, netWorthCents: endCents };
  return points;
}

export default async function NetWorthPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) redirect("/");
  const params = await searchParams;

  // Both must finish before getNetWorth reads assets below, so a stale AI
  // estimate or crypto price never renders — see refreshStaleAssetEstimates
  // (monthly gate) and refreshCryptoPrices (every load, since CoinGecko is
  // free and a stale price on a volatile asset is the worse tradeoff).
  await Promise.all([
    refreshStaleAssetEstimates(session.user.householdId),
    refreshCryptoPrices(session.user.householdId),
  ]);

  const [
    { assets, totalAssetsCents, totalDebtsCents, liquidCashCents, cashAccounts, netWorthCents },
    accounts,
    debts,
    untrackedInvestments,
    excludedCashAccounts,
  ] = await Promise.all([
    getNetWorth(session.user.householdId),
    // Only INVESTMENT accounts have a legitimate "current value" balance —
    // a LOAN account's balance is what's owed, not what the collateral
    // (home/vehicle) is worth, so it must never be offered as a link
    // target for a HOME_EQUITY/VEHICLE_EQUITY asset (see linkAssetAccount).
    db.account.findMany({
      where: { householdId: session.user.householdId, accountType: "INVESTMENT" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, displayName: true, orgName: true },
    }),
    // For linking a mortgage/auto loan to the HOME_EQUITY/VEHICLE_EQUITY
    // asset it secures (see linkAssetDebt) — small household-scale list.
    // LOAN kind only (a card or a BNPL plan isn't collateralised by a
    // home/vehicle); hidden debts excluded outright; paid-off ones filtered
    // per row below (kept only when already this asset's link). Labelled with
    // the synced account's friendly name where there is one.
    db.debt.findMany({
      where: { householdId: session.user.householdId, hiddenAt: null, kind: "LOAN" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, balanceCents: true, account: { select: { displayName: true } } },
    }),
    getUntrackedInvestmentAccounts(session.user.householdId),
    // The cash-side equivalent of "untracked investment" — a CHECKING/
    // SAVINGS account flipped off via excludeCashAccount (see actions.ts),
    // still syncing, just filtered out of getNetWorth's cashAccounts query.
    db.account.findMany({
      where: {
        householdId: session.user.householdId,
        accountType: { in: ["CHECKING", "SAVINGS"] },
        excludedFromNetWorth: true,
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, displayName: true, orgName: true, balanceCents: true },
    }),
  ]);
  const takenDebtIds = new Set(assets.filter((a) => a.debtId).map((a) => a.debtId!));
  const notCountedAccounts: NotCountedAccountData[] = [
    ...untrackedInvestments.map((a) => ({ ...a, kind: "investment" as const })),
    ...excludedCashAccounts.map((a) => ({
      id: a.id,
      name: a.displayName ?? a.name,
      orgName: a.orgName,
      balanceCents: a.balanceCents,
      kind: "cash" as const,
    })),
  ];

  // Snapshot today's value (upserted — see recordNetWorthSnapshot), then
  // read it back two ways: the month-to-date trend line and the full
  // monthly history for the chart. All three are independent of each other
  // (the trend/history queries only ever read dateKeys strictly before
  // today, or tolerate today's row landing either side of the race), so
  // they run in parallel.
  const [, trend, monthlyHistoryReal] = await Promise.all([
    recordNetWorthSnapshot(session.user.householdId, netWorthCents),
    getNetWorthTrend(session.user.householdId, netWorthCents),
    getNetWorthMonthlyHistory(session.user.householdId),
  ]);
  // TEMPORARY — swap in fake multi-year history via ?chartTest=1 so the
  // chart's year toggle / "Since start" view can be checked before real
  // accounts have more than a few days of history. Remove this branch (and
  // buildTestMonthlyHistory above) once verified.
  const monthlyHistory =
    params.chartTest === "1" ? buildTestMonthlyHistory(currentPeriodKey(), netWorthCents) : monthlyHistoryReal;

  return (
    <AppShell title="Net Worth" user={session.user} titleActions={<AddAssetForm />}>
      {/* Full width, not capped `lg:max-w-3xl` like a secondary alert stack —
          this IS the page's primary content, and NetWorthTrendChart's `<svg
          className="w-full">` scales with its container (fixed 640:200
          viewBox aspect ratio), so a narrow centered card just left the
          headline trend chart looking tiny next to the full-width group
          grid below it (household report, 2026-09-23). */}
      <StatCard
        label="Net Worth"
        labelClassName="text-emerald-700 dark:text-emerald-400"
        value={formatCents(netWorthCents)}
        valueClassName={netWorthCents < 0 ? "text-red-600 dark:text-red-400" : "text-blue-900 dark:text-blue-300"}
        caption={
          trend && (
            <p
              className={`mt-1 flex items-center gap-1 text-sm font-medium ${
                trend.deltaCents > 0
                  ? "text-emerald-700 dark:text-emerald-400"
                  : trend.deltaCents < 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-gray-500 dark:text-neutral-400"
              }`}
            >
              {trend.deltaCents > 0 ? (
                <TrendingUp size={16} />
              ) : trend.deltaCents < 0 ? (
                <TrendingDown size={16} />
              ) : (
                <Minus size={16} />
              )}
              {trend.deltaCents === 0 ? "No Change" : `${trend.deltaCents > 0 ? "+" : ""}${formatCents(trend.deltaCents)}`}
              <span className="font-normal text-gray-500 dark:text-neutral-400">
                since {formatDate(new Date(trend.sinceDateKey), { month: "short", day: "numeric" })}
              </span>
            </p>
          )
        }
      >
        <div className="mt-3">
          <NetWorthTrendChart monthly={monthlyHistory} />
        </div>
        {/* Centered under the chart, not left-tucked — and colored by what
            each figure means for net worth: Cash blue (liquid, on hand,
            same tone as the headline number itself), Assets emerald ("money
            you have," the app's existing have/receive color — see
            StatCard's own comment), Debts red (subtracts from net worth,
            same red every other negative/over-budget figure in the app
            uses, e.g. CollapsibleGroup's totalCents < 0 case). */}
        <div className="mx-auto mt-3 grid max-w-md grid-cols-3 gap-3 text-center text-sm">
          <div>
            <p className="text-gray-500 dark:text-neutral-400">Cash</p>
            <p className="font-medium text-blue-900 dark:text-blue-300">{formatCents(liquidCashCents)}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-neutral-400">Assets</p>
            <p className="font-medium text-emerald-700 dark:text-emerald-400">{formatCents(totalAssetsCents)}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-neutral-400">Debts</p>
            <p className="font-medium text-red-600 dark:text-red-400">{formatCents(totalDebtsCents)}</p>
          </div>
        </div>
      </StatCard>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:gap-3 lg:items-start xl:grid-cols-3">
      {cashAccounts.length > 0 && (
        <CollapsibleGroup title="Cash" totalCents={liquidCashCents} count={cashAccounts.length}>
          <ul className="flex flex-col gap-2">
            {cashAccounts.map((a) => (
              <CashAccountRow key={a.id} account={a} />
            ))}
          </ul>
        </CollapsibleGroup>
      )}

      <NotCountedAccounts accounts={notCountedAccounts} />

      {assets.length === 0 && cashAccounts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400">No assets added yet.</p>
      ) : (
        ASSET_GROUPS.map((group) => {
          const groupAssets = assets
            .filter((a) => group.types.includes(a.assetType))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (groupAssets.length === 0) return null;
          const totalCents = groupAssets.reduce((sum, a) => sum + displayCentsFor(a), 0);
          return (
            <CollapsibleGroup
              key={group.label}
              title={group.label}
              totalCents={totalCents}
              count={groupAssets.length}
            >
              <ul className="flex flex-col gap-2">
                {groupAssets.map((a) => {
                  const cryptoSymbol =
                    a.assetType === "CRYPTO"
                      ? (a.estimateDetails as unknown as CryptoEstimateDetails | null)?.symbol
                      : undefined;
                  return (
                    <AssetRow
                      key={a.id}
                      asset={a}
                      accounts={accounts}
                      debts={debts
                        .filter(
                          (d) =>
                            (d.balanceCents > 0 || d.id === a.debtId) &&
                            (!takenDebtIds.has(d.id) || d.id === a.debtId),
                        )
                        .map((d) => ({ id: d.id, name: d.account?.displayName ?? d.name, balanceCents: d.balanceCents }))}
                      cryptoSymbol={cryptoSymbol}
                    />
                  );
                })}
              </ul>
            </CollapsibleGroup>
          );
        })
      )}
      </div>
    </AppShell>
  );
}
