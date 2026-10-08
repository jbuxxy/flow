import Link from "next/link";
import { redirect } from "next/navigation";
import { Receipt, Repeat } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBucketsWithProgress, uncategorizedTransactionWhere } from "@/lib/buckets";
import { ensureBucketIcons } from "@/lib/bucket-icons-sync";
import { hasFullAccess } from "@/lib/access";
import { getLabelSuggestionsByMerchant } from "@/lib/transaction-labels";
import { detectUnlinkedBnpl } from "@/lib/bnpl-detect";
import { detectMerchantBillSuggestions } from "@/lib/bill-detect";
import { defaultDebtPaymentBucketId } from "@/lib/debt-payments";
import { pickableDebtWhere } from "@/lib/debt-reassign";
import { getActiveUnlabeledP2PTransfers } from "@/lib/p2p-transfers";
import { getIncomeSummary } from "@/lib/income";
import { getExtraIncomeSummary } from "@/lib/bucket-ad-hoc-topup";
import { currentPeriodKey, periodBounds } from "@/lib/period";
import { AppShell } from "@/components/app-shell";
import { BucketAllocationCard } from "@/components/bucket-allocation-card";
import { BucketCard } from "@/components/bucket-card";
import { ExtraIncomeCard } from "@/components/extra-income-card";
import { CountWarning } from "@/components/count-warning";
import { BnplSuggestions } from "@/app/debts/bnpl-suggestions";
import { BillSuggestions } from "@/app/bills/bill-suggestions";
import { dismissUnlabeledP2PDebits } from "./actions";
import { AddBucketForm } from "./add-bucket-form";
import { UncategorizedList } from "./uncategorized-list";

export default async function BucketsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Backfill any missing bucket icons (AI pick for keyword-miss names)
  // before reading progress — a fast no-op once every bucket is resolved.
  await ensureBucketIcons(session.user.householdId);

  const [buckets, uncategorized, debts, categories, existingBills, bnplSuggestions, merchantSuggestions, defaultBucketId, unlabeledP2PDebits, incomeSummary, extraIncome, household] = await Promise.all([
    getBucketsWithProgress(session.user.householdId),
    db.transaction.findMany({
      where: uncategorizedTransactionWhere(session.user.householdId),
      orderBy: { occurredOn: "desc" },
      take: 25,
      select: {
        id: true,
        merchant: true,
        rawDescription: true,
        amountCents: true,
        occurredOn: true,
        pending: true,
        notes: true,
        label: true,
        aiSuggestedBucketId: true,
        aiSuggestedCategoryId: true,
        account: { select: { name: true, orgName: true } },
      },
    }),
    db.debt.findMany({
      // Hidden debts / paid-off loans stay out of the Uncategorized list's
      // Reclassify picker — see pickableDebtWhere.
      where: { householdId: session.user.householdId, ...pickableDebtWhere() },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, account: { select: { orgName: true, displayName: true } } },
    }),
    db.billCategory.findMany({
      where: { householdId: session.user.householdId },
      select: { id: true, name: true, bucketId: true },
      orderBy: { name: "asc" },
    }),
    // Feeds UncategorizedList's Recurring tab "This Is A Payment For" /
    // "Attach As An Extra Charge On" pickers — same query transactions/
    // page.tsx already runs for TrackAsBillForm's existingBills prop.
    db.recurringBill.findMany({
      where: { householdId: session.user.householdId, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    hasFullAccess(session.user) ? detectUnlinkedBnpl(session.user.householdId) : [],
    detectMerchantBillSuggestions(session.user.householdId),
    defaultDebtPaymentBucketId(session.user.householdId),
    hasFullAccess(session.user) ? getActiveUnlabeledP2PTransfers(session.user.householdId, "DEBIT") : [],
    hasFullAccess(session.user) ? getIncomeSummary(session.user.householdId) : null,
    hasFullAccess(session.user) ? getExtraIncomeSummary(session.user.householdId, currentPeriodKey()) : null,
    db.household.findUnique({
      where: { id: session.user.householdId },
      select: { autoApplyAdHocIncomeToBuckets: true },
    }),
  ]);
  // Was prefixed with the synced account's institution to disambiguate
  // generic-sounding lender names — dropped per feedback (2026-08-18): just
  // the friendly name, same as every other debt reference in the app
  // (WORKING_ON.md), same reasoning as transactions/page.tsx's debtOptions.
  const debtOptions = debts.map((d) => ({ id: d.id, name: d.account?.displayName ?? d.name }));
  const labelSuggestions = await getLabelSuggestionsByMerchant(
    session.user.householdId,
    uncategorized.map((t) => t.merchant),
  );
  // Last day of the month — when whatever extra income is still waiting
  // becomes that month's surplus (ExtraIncomeCard).
  const { end: nextMonthStart } = periodBounds(currentPeriodKey());
  const monthEnd = new Date(nextMonthStart.getFullYear(), nextMonthStart.getMonth(), 0);
  const monthEndLabel = monthEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <AppShell
      title="Buckets"
      user={session.user}
      titleActions={
        <div className="flex items-center gap-2">
          {hasFullAccess(session.user) && (
            <>
              <Link
                href="/bills"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-blue-50 dark:bg-blue-950/40 px-3 text-xs font-medium text-blue-800 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/60"
              >
                <Repeat size={14} />
                Recurring
              </Link>
              <Link
                href="/transactions?status=notIncome"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-blue-50 dark:bg-blue-950/40 px-3 text-xs font-medium text-blue-800 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/60"
              >
                <Receipt size={14} />
                Transactions
              </Link>
            </>
          )}
          <AddBucketForm />
        </div>
      }
    >
      {/* Attention / nudge band — a single centered column even on a wide
          screen (same treatment as the dashboard alert stack and /debts);
          UncategorizedList has inline-expanding rows so it can't be a rail or
          a grid cell. The bucket grid below is the page's real wide canvas. */}
      <div className="flex flex-col gap-6 empty:hidden lg:mx-auto lg:max-w-3xl">
      {hasFullAccess(session.user) && bnplSuggestions.length > 0 && (
        <BnplSuggestions
          suggestions={bnplSuggestions.map((s) => ({
            ...s,
            lastSeen: s.lastSeen.toISOString().slice(0, 10),
            transactions: s.transactions.map((t) => ({ ...t, occurredOn: t.occurredOn.toISOString().slice(0, 10) })),
          }))}
          buckets={buckets.map((b) => ({ id: b.id, name: b.name }))}
          defaultBucketId={defaultBucketId}
          categories={categories}
        />
      )}

      <BillSuggestions
        suggestions={merchantSuggestions.map((s) => ({
          ...s,
          nextDueDate: s.nextDueDate.toISOString().slice(0, 10),
          lastSeenDate: s.lastSeenDate.toISOString().slice(0, 10),
        }))}
        buckets={buckets.map((b) => ({ id: b.id, name: b.name }))}
        categories={categories}
      />

      <UncategorizedList
        transactions={uncategorized}
        buckets={buckets}
        debts={debtOptions}
        categories={categories}
        existingBills={existingBills}
        labelSuggestions={labelSuggestions}
      />

      {hasFullAccess(session.user) && (
        <CountWarning
          count={unlabeledP2PDebits.length}
          title="Uncategorized P2P Activity"
          subtitle={`${unlabeledP2PDebits.length} P2P transaction${unlabeledP2PDebits.length === 1 ? "" : "s"} need${unlabeledP2PDebits.length === 1 ? "s" : ""} a bucket, a debt payment, or a recurring pattern`}
          href="/transactions?status=unlabeledP2P"
          linkLabel="Review Transactions →"
          storageKey="unlabeled-p2p-debit"
          dismiss={dismissUnlabeledP2PDebits}
        />
      )}

      {incomeSummary && buckets.length > 0 && (
        <BucketAllocationCard
          // excludedFromAllocation buckets (a one-time Tesla-down-payment-
          // style purchase funded from outside this month's regular income)
          // don't belong in an "income vs. what's allocated" breakdown at
          // all — see the schema comment on that field.
          buckets={buckets
            .filter((b) => !b.excludedFromAllocation)
            .map((b) => ({
              id: b.id,
              name: b.name,
              // b.monthlyCapCents is computeProgress's *effective* cap
              // (configured cap + this period's ad-hoc top-up, see
              // buckets.ts). Whether to back the top-up back out depends on
              // whether incomeCents below already counts the money that
              // funded it: incomeSummary.totalMonthlyCents only includes
              // this month's ad hoc/P2P income when includeP2PInIncomeCalc
              // is on (getIncomeSummary, income.ts) — the exact same pool
              // autoApplyAdHocIncomeToBuckets draws top-ups from
              // (bucket-ad-hoc-topup.ts). With it ON, that income is
              // already counted once above *and* already spent covering
              // this bucket's overage — showing the effective (topped-up)
              // cap here correctly nets it to zero instead of double-
              // counting it as still "unallocated." With it OFF, the top-up
              // money was never counted as income at all, so the *raw*
              // configured cap is what actually compares against income
              // (2026-09-22 code review finding — the original fix only
              // handled the OFF case and produced a misleading "$X left to
              // allocate" that was really already-spent top-up money for a
              // household with the setting ON).
              monthlyCapCents: incomeSummary.includeP2PInIncomeCalc ? b.monthlyCapCents : b.monthlyCapCents - b.topUpCents,
              trackingMode: b.trackingMode,
              onPaceToOvershoot: b.onPaceToOvershoot,
            }))}
          incomeCents={incomeSummary.totalMonthlyCents}
          isEstimated={incomeSummary.isEstimated}
        />
      )}

      {extraIncome && (
        <ExtraIncomeCard
          receivedCents={extraIncome.receivedCents}
          appliedCents={extraIncome.appliedCents}
          unappliedCents={extraIncome.unappliedCents}
          sources={extraIncome.sources.map((src) => ({ ...src, occurredOn: src.occurredOn.toISOString().slice(0, 10) }))}
          autoApply={household?.autoApplyAdHocIncomeToBuckets ?? false}
          monthEndLabel={monthEndLabel}
        />
      )}
      </div>

      {buckets.length === 0 ? (
        <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
          <p className="text-sm text-gray-600 dark:text-neutral-400">
            No buckets yet. Add one above to get started.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start xl:grid-cols-3">
          {[...buckets]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((b) => (
              <BucketCard key={b.id} progress={b} />
            ))}
        </div>
      )}
    </AppShell>
  );
}
