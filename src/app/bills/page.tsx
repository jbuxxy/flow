import Link from "next/link";
import { PAYMENT_RECEIPT_SELECT } from "@/lib/payment-receipt";
import { db } from "@/lib/db";
import { requireFullAccess } from "@/lib/access";
import { getAccountedForSuggestions } from "@/lib/debt-payments";
import { accountedForCents } from "@/lib/spend";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import {
  currentPeriodBillWhere,
  getActiveBillCycleSkips,
  getPendingBillAmountReviews,
} from "@/lib/recurring-bills";
import { pickableDebtWhere } from "@/lib/debt-reassign";
import { scheduleBucketIcons } from "@/lib/bucket-icons-sync";
import { AppShell } from "@/components/app-shell";
import { BillAmountReviewCard } from "@/components/bill-amount-review-card";
import { type PatternData, serializePatternDates } from "@/lib/pattern-data";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import { RecurringList } from "./recurring-list";
import { billCardInclude, buildBillCards, buildDebtPaymentCards, debtPaymentCardInclude } from "@/lib/recurring-cards";
import { RecurringSortProvider, RecurringSortControl } from "./recurring-sort";

// The household-wide "everything recurring" list (2026-08-23) — every
// active RecurringBill, DebtPayment, and RecurringPattern in one place to
// edit or remove, grouped by type. Reuses BillRow/DebtPaymentCard/PatternRow
// exactly as their own single-bucket/single-debt pages do, so an edit here
// looks and behaves identically to editing it from wherever it was created —
// this page adds no new form of its own. No "add" affordance here on
// purpose: creating a bill/pattern still only happens from a transaction
// (/transactions) or a detected suggestion (/buckets, /debts), same as
// before this page existed.
//
// Gated to full-access members even though /buckets itself isn't — this
// page also surfaces DebtPayment and income-marked RecurringPattern rows,
// both of which stay behind hasFullAccess everywhere else they're shown
// (/debts, /income). The Bills-only portion would be safe to open up, but
// splitting the gate per-section isn't worth it for a page whose whole
// point is showing everything in one place.
export default async function RecurringPage() {
  const session = await requireFullAccess();

  const householdId = session.user.householdId;
  // "This cycle" is the real current calendar month (household correction,
  // 2026-08-25 — see debt-row.tsx's CycleMinimum comment). UTC bounds —
  // nextDueDate/occurredOn on a bill/pattern's own ledger are `@db.Date`
  // (UTC midnight), see utcPeriodBounds's own comment.
  const { start: utcMonthStart, end: utcMonthEnd } = utcPeriodBounds(currentPeriodKey());

  scheduleBucketIcons(householdId);
  const [buckets, rawDebts, categories, bills, debtPayments, patterns, pendingReviews, pendingBillAmountReviews] =
    await Promise.all([
      db.bucket.findMany({
        where: { householdId },
        select: { id: true, name: true, icon: true },
        orderBy: { sortOrder: "asc" },
      }),
      db.debt.findMany({
        // Hidden debts / paid-off loans stay out of BillRow's and
        // DebtPaymentCard's debt pickers — see pickableDebtWhere.
        where: { householdId, ...pickableDebtWhere() },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, account: { select: { displayName: true } } },
      }),
      db.billCategory.findMany({ where: { householdId }, select: { id: true, name: true, bucketId: true }, orderBy: { name: "asc" } }),
      db.recurringBill.findMany({
        where: { householdId, ...currentPeriodBillWhere() },
        orderBy: { nextDueDate: "asc" },
        include: billCardInclude(),
      }),
      db.debtPayment.findMany({
        where: { householdId, active: true, hiddenFromBucket: false },
        orderBy: { nextDueDate: "asc" },
        include: debtPaymentCardInclude(),
      }),
      db.recurringPattern.findMany({
        where: { householdId, ...currentPeriodPatternWhere() },
        include: {
          bucket: { select: { name: true } },
          debt: { select: { name: true, account: { select: { displayName: true } } } },
          category: { select: { name: true } },
          transactions: { orderBy: { occurredOn: "desc" }, select: { id: true, amountCents: true, occurredOn: true, pending: true, ...PAYMENT_RECEIPT_SELECT } },
        },
        orderBy: { label: "asc" },
      }),
      db.debtAmountReview.findMany({
        where: { householdId },
        select: { debtPayment: { select: { debtId: true } } },
      }),
      getPendingBillAmountReviews(householdId),
    ]);

  const debts = rawDebts.map((d) => ({ ...d, name: d.account?.displayName ?? d.name }));
  const debtOptions = debts.map((d) => ({ id: d.id, name: d.name }));
  const debtIdsWithPendingReview = new Set(pendingReviews.map((r) => r.debtPayment.debtId));

  // Only this month's payments: the ledger rows that show these suggestions
  // are this month's (buildDebtPaymentCards), and asking for every payment
  // ever made ran one query per historical payment on every load.
  const accountedForCandidates = debtPayments
    .filter((p) => p.debt.account?.budgetTracked)
    .flatMap((p) =>
      p.payments
        .filter(
          (t) =>
            t.occurredOn >= utcMonthStart && !t.notAccountedFor && accountedForCents(t) < Math.abs(t.amountCents),
        )
        .map((t) => ({
          id: t.id,
          debtId: p.debtId,
          amountCents: t.amountCents,
          occurredOn: t.occurredOn,
          alreadyLinkedCents: accountedForCents(t),
        })),
    );
  const [accountedForSuggestions, activeBillSkips] = await Promise.all([
    getAccountedForSuggestions(householdId, accountedForCandidates),
    getActiveBillCycleSkips(householdId, bills),
  ]);

  const billData = buildBillCards(bills, activeBillSkips, utcMonthStart, utcMonthEnd);

  const bucketById = new Map(buckets.map((b) => [b.id, b]));

  // Dated payoff-plan extra lines this month, per debt — the projected emerald
  // EntryLines the card renders in its ledger (see DebtPaymentData.projectedExtras).
  // Paired with the superseded-payoff adjustment (one query each, both keyed
  // by debtId) — see confirmProjectedExtras where they meet.
  const debtPaymentCards = await buildDebtPaymentCards(
    householdId,
    debtPayments,
    debtIdsWithPendingReview,
    utcMonthStart,
    utcMonthEnd,
  );
  // Paid-off debts sink to the bottom regardless of the chosen sort order —
  // RecurringList handles that tiering (and the due-date/A–Z choice) on the
  // client, same as payoff-planner.tsx's own paid-off tier on /debts.

  // RecurringPattern is P2P-app activity (Venmo/Zelle/etc.) only — never a
  // checking↔savings internal transfer, which is already auto-classified
  // isTransfer:true with nothing to track. Reimbursement patterns (CREDIT,
  // billId set) already render inline on their bill's own BillRow card
  // above — the only page a reimbursement pattern has any real connection
  // to (see the schema comment on RecurringPattern.billId). Everything left
  // here is bucket/debt-targeted P2P spend or an income-marked P2P credit.
  const p2pPatterns: PatternData[] = patterns
    .filter((p) => !p.billId)
    .map((p) => ({
      id: p.id,
      label: p.label,
      direction: p.direction,
      channelKeyword: p.channelKeyword,
      amountMinCents: p.amountMinCents,
      amountMaxCents: p.amountMaxCents,
      dayOfMonthStart: p.dayOfMonthStart,
      dayOfMonthEnd: p.dayOfMonthEnd,
      weekdays: p.weekdays,
      bucketId: p.bucketId,
      bucketName: p.bucket?.name ?? null,
      debtId: p.debtId,
      debtName: p.debt ? (p.debt.account?.displayName ?? p.debt.name) : null,
      countsAsIncome: p.countsAsIncome,
      billId: null,
      billName: null,
      categoryId: p.categoryId,
      categoryName: p.category?.name ?? null,
      counterpartyName: p.counterpartyName,
      noteKeywords: p.noteKeywords,
      cadence: p.cadence,
      toleranceCents: p.toleranceCents,
      dueDateLocked: p.dueDateLocked,
      active: p.active,
      ...serializePatternDates(p, utcMonthStart, utcMonthEnd),
    }));

  // Every household feedback since (2026-09-14: "debts and manual are
  // sorted by type, should all be sorted by buckets since it comes from
  // Buckets->Recurring") groups debt payments and P2P patterns by bucket the
  // same way bills already were, rather than each type getting its own
  // single household-wide "Debt Payments"/"P2P Patterns" card. Mirrors
  // BucketBillsSection's own bills+debtPayments merge on the single-bucket
  // page — this just extends that grouping to three types and to every
  // bucket at once.
  function groupByBucket<T extends { bucketId: string | null }>(items: T[]) {
    const byBucket = new Map<string, T[]>();
    const unbucketed: T[] = [];
    for (const item of items) {
      if (!item.bucketId) {
        unbucketed.push(item);
        continue;
      }
      const arr = byBucket.get(item.bucketId) ?? [];
      arr.push(item);
      byBucket.set(item.bucketId, arr);
    }
    return { byBucket, unbucketed };
  }
  const { byBucket: billsByBucketId, unbucketed: unbucketedBills } = groupByBucket(billData);
  const { byBucket: debtPaymentsByBucketId, unbucketed: unbucketedDebtPayments } = groupByBucket(debtPaymentCards);
  const { byBucket: patternsByBucketId, unbucketed: unbucketedPatterns } = groupByBucket(p2pPatterns);

  // Section order stays alphabetical by bucket name and is fixed here; the
  // rows *within* each section are reordered client-side by RecurringList's
  // "Sort By" control (due date default, or A–Z), so the query's
  // nextDueDate order is fine to pass through as-is.
  const bucketIdsWithItems = new Set([
    ...billsByBucketId.keys(),
    ...debtPaymentsByBucketId.keys(),
    ...patternsByBucketId.keys(),
  ]);
  const billGroups = [...bucketIdsWithItems]
    .map((bucketId) => ({
      bucketId,
      name: bucketById.get(bucketId)?.name ?? "Unknown Bucket",
      icon: bucketById.get(bucketId)?.icon ?? null,
      bills: billsByBucketId.get(bucketId) ?? [],
      debtPayments: debtPaymentsByBucketId.get(bucketId) ?? [],
      patterns: patternsByBucketId.get(bucketId) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const nothingTracked = billData.length === 0 && debtPaymentCards.length === 0 && p2pPatterns.length === 0;
  // Rows the "Sort By" control can reorder — matches RecurringList's own
  // count. Below 2 there's nothing to sort, so the control hides.
  const totalItems = billData.length + debtPaymentCards.length + p2pPatterns.length;

  return (
    <RecurringSortProvider>
      <AppShell
        title="Recurring"
        user={session.user}
        breadcrumb={{ href: "/buckets", label: "Buckets" }}
        titleActions={<RecurringSortControl show={totalItems > 1} />}
        width={nothingTracked ? "reading" : "wide"}
      >
        {pendingBillAmountReviews.length > 0 && (
          <div className="mb-6">
            <BillAmountReviewCard reviews={pendingBillAmountReviews} />
          </div>
        )}
        {nothingTracked ? (
          <p className="text-sm text-gray-500 dark:text-neutral-400">
            Nothing recurring tracked yet — track a bill or pattern from a transaction on{" "}
            <Link href="/transactions" className="text-blue-900 dark:text-blue-300 hover:underline">
              Transactions
            </Link>
            , or accept a suggestion on Buckets/Debts.
          </p>
        ) : (
          <RecurringList
            billGroups={billGroups}
            unbucketedBills={unbucketedBills}
            unbucketedDebtPayments={unbucketedDebtPayments}
            unbucketedPatterns={unbucketedPatterns}
            buckets={buckets}
            debts={debtOptions}
            categories={categories}
            billOptions={billData.map((b) => ({ id: b.id, name: b.name }))}
            accountedForSuggestions={accountedForSuggestions}
          />
        )}
      </AppShell>
    </RecurringSortProvider>
  );
}
