import Link from "next/link";
import { PAYMENT_RECEIPT_SELECT, paymentReceiptOf } from "@/lib/payment-receipt";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasFullAccess } from "@/lib/access";
import {
  getAccountedForSuggestions,
  plannedExtraByDebtInPeriod,
  postedExtraNettedByDebt,
  getSkippedMinimumKeys,
  supersededPayoffExtraByDebtInPeriod,
  planExtraTargetsByDebt,
} from "@/lib/debt-payments";
import { coveredMinimumDates, ledgerMinimumCents } from "@/lib/minimum-ledger";
import { ACCOUNTED_FOR_SELECT, accountedForCents, accountedForDisplayList } from "@/lib/spend";
import { confirmProjectedExtras } from "@/lib/debt-payoff";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { splitPlanExtraPayments, buildCycleSlots, slotBounds, cyclePaymentStatus } from "@/lib/cycle-slots";
import { currentPeriodBillWhere, getActiveBillCycleSkips, getPendingBillAmountReviews } from "@/lib/recurring-bills";
import { pickableDebtWhere } from "@/lib/debt-reassign";
import { ensureBucketIcons } from "@/lib/bucket-icons-sync";
import { AppShell } from "@/components/app-shell";
import { BillAmountReviewCard } from "@/components/bill-amount-review-card";
import { type BillData } from "./bill-row";
import { dueStatus } from "@/lib/date";
import { type DebtPaymentWithName } from "@/app/debts/debt-payment-card";
import { type PatternData, serializePatternDates } from "@/lib/pattern-data";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import { RecurringList } from "./recurring-list";
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
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");

  const householdId = session.user.householdId;
  await ensureBucketIcons(householdId);
  const pendingBillAmountReviews = await getPendingBillAmountReviews(householdId);

  const [buckets, rawDebts, categories, bills, debtPayments, patterns, pendingReviews] =
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
        include: {
          category: { select: { name: true } },
          payments: {
            orderBy: { occurredOn: "desc" },
            select: {
              id: true,
              amountCents: true,
              occurredOn: true,
              pending: true,
              reimbursedBy: { select: { id: true, merchant: true, amountCents: true, occurredOn: true } },
              ...PAYMENT_RECEIPT_SELECT,
            },
          },
          // CREDIT patterns pinned to this bill (countsAsIncome:false,
          // billId set) — shown inline on the bill's own row below, same as
          // every bucket's own page, not duplicated into the transfers
          // section further down.
          reimbursementPatterns: {
            where: currentPeriodPatternWhere(),
            orderBy: { label: "asc" },
            // No category relation — a bill-pinned reimbursement never
            // carries its own; the parent bill's own category (already
            // selected above) is what its construction site below uses.
            include: {
              transactions: { orderBy: { occurredOn: "desc" }, select: { id: true, amountCents: true, occurredOn: true, pending: true, ...PAYMENT_RECEIPT_SELECT } },
            },
          },
        },
      }),
      db.debtPayment.findMany({
        where: { householdId, active: true, hiddenFromBucket: false },
        orderBy: { nextDueDate: "asc" },
        include: {
          debt: {
            select: {
              name: true,
              label: true,
              source: true,
              debtType: true,
              purchaseDate: true,
              balanceCents: true,
              paidOffDate: true,
              includeInPayoffPlan: true,
              ignoreMinimumPayment: true,
              installmentsTotal: true,
              installmentsRemaining: true,
              receiptItems: true,
              receiptTotalCents: true,
              account: { select: { name: true, orgName: true, displayName: true, budgetTracked: true } },
            },
          },
          category: { select: { name: true } },
          payments: {
            orderBy: { occurredOn: "desc" },
            select: {
              id: true,
              amountCents: true,
              occurredOn: true,
              pending: true,
              notAccountedFor: true,
              ...ACCOUNTED_FOR_SELECT,
            },
          },
        },
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
    ]);

  const debts = rawDebts.map((d) => ({ ...d, name: d.account?.displayName ?? d.name }));
  const debtOptions = debts.map((d) => ({ id: d.id, name: d.name }));
  const debtIdsWithPendingReview = new Set(pendingReviews.map((r) => r.debtPayment.debtId));

  const accountedForCandidates = debtPayments
    .filter((p) => p.debt.account?.budgetTracked)
    .flatMap((p) =>
      p.payments
        .filter((t) => !t.notAccountedFor && accountedForCents(t) < Math.abs(t.amountCents))
        .map((t) => ({
          id: t.id,
          debtId: p.debtId,
          amountCents: t.amountCents,
          occurredOn: t.occurredOn,
          alreadyLinkedCents: accountedForCents(t),
        })),
    );
  const accountedForSuggestions = await getAccountedForSuggestions(householdId, accountedForCandidates);
  const activeBillSkips = await getActiveBillCycleSkips(householdId, bills);

  // "This cycle" is the real current calendar month (household correction,
  // 2026-08-25 — see debt-row.tsx's CycleMinimum comment). UTC bounds —
  // nextDueDate/occurredOn on a bill/pattern's own ledger are `@db.Date`
  // (UTC midnight), see utcPeriodBounds's own comment. Declared up front —
  // billData's own cyclePaid/currentCyclePayments (below) and the
  // debtPaymentCards/plannedExtraLinesByDebtId further down all need it.
  const { start: utcMonthStart, end: utcMonthEnd } = utcPeriodBounds(currentPeriodKey());

  const billData: BillData[] = bills.map((b) => {
    const paymentsAbs = b.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      occurredOn: p.occurredOn,
      pending: p.pending,
      reimbursedBy: p.reimbursedBy,
      receipt: paymentReceiptOf(p),
    }));
    const { cyclePaid, currentCyclePayments } = cyclePaymentStatus(
      b.nextDueDate,
      b.cadence,
      paymentsAbs,
      utcMonthStart,
      utcMonthEnd,
      slotBounds(utcMonthStart, { trackerCreatedAt: b.createdAt }),
    );
    const toDisplay = (p: (typeof paymentsAbs)[number]) => ({
      id: p.id,
      amountCents: p.amountCents,
      occurredOn: p.occurredOn.toISOString().slice(0, 10),
      pending: p.pending,
      receipt: p.receipt,
      reimbursedBy: p.reimbursedBy.map((r) => ({
        id: r.id,
        merchant: r.merchant,
        amountCents: r.amountCents,
        occurredOn: r.occurredOn.toISOString().slice(0, 10),
      })),
    });
    return {
      id: b.id,
      name: b.name,
      merchant: b.merchant,
      amountCents: b.amountCents,
      toleranceCents: b.toleranceCents,
      cadence: b.cadence,
      categoryId: b.categoryId,
      categoryName: b.category?.name ?? null,
      nextDueDate: b.nextDueDate.toISOString().slice(0, 10),
      dueStatus: dueStatus(b.nextDueDate.toISOString().slice(0, 10)),
      lastPaidDate: b.lastPaidDate ? b.lastPaidDate.toISOString().slice(0, 10) : null,
      dueDateLocked: b.dueDateLocked,
      bucketId: b.bucketId,
      canceled: !b.active,
      payments: paymentsAbs.map(toDisplay),
      cyclePaid,
      currentCyclePayments: currentCyclePayments.map(toDisplay),
      skippedCycleDueDate: activeBillSkips.get(b.id)?.toISOString().slice(0, 10) ?? null,
      reimbursementPatterns: b.reimbursementPatterns.map((p) => ({
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
        bucketName: null,
        debtId: p.debtId,
        debtName: null,
        countsAsIncome: p.countsAsIncome,
        billId: p.billId,
        billName: b.name,
        categoryId: p.categoryId,
        // The bill's own category, not the pattern's own — a bill-pinned
        // reimbursement never carries a separate one (household feedback,
        // 2026-09-11).
        categoryName: b.category?.name ?? null,
        counterpartyName: p.counterpartyName,
        noteKeywords: p.noteKeywords,
        cadence: p.cadence,
        toleranceCents: p.toleranceCents,
        dueDateLocked: p.dueDateLocked,
        active: p.active,
        ...serializePatternDates(p, utcMonthStart, utcMonthEnd),
      })),
    };
  });

  const bucketById = new Map(buckets.map((b) => [b.id, b]));

  // utcMonthStart/utcMonthEnd declared above, alongside billData.
  // Dated payoff-plan extra lines this month, per debt — the projected emerald
  // EntryLines the card renders in its ledger (see DebtPaymentData.projectedExtras).
  // Paired with the superseded-payoff adjustment (one query each, both keyed
  // by debtId) — see confirmProjectedExtras where they meet.
  const [plannedExtraLinesByDebtId, supersededPayoffExtraByDebtId, skippedMinimumKeys, postedExtraNettedByDebtId] = await Promise.all([
    plannedExtraByDebtInPeriod(householdId, utcMonthStart, utcMonthEnd),
    supersededPayoffExtraByDebtInPeriod(householdId, utcMonthStart, utcMonthEnd),
    getSkippedMinimumKeys(householdId, utcMonthStart, utcMonthEnd),
    postedExtraNettedByDebt(householdId),
  ]);

  const planExtrasByDebtId = await planExtraTargetsByDebt(householdId, utcMonthStart, utcMonthEnd);
  const debtPaymentCards: DebtPaymentWithName[] = debtPayments.map((p) => {
    // A card/loan payment can post on the debt's own liability account as a
    // negative credit (see filterDebtPaymentTwins, debt-payments.ts) — this
    // ledger always shows "amount paid," never the account-native sign.
    const paymentsAbs = p.payments.map((t) => ({
      id: t.id,
      amountCents: Math.abs(t.amountCents),
      occurredOn: t.occurredOn,
      pending: t.pending,
      notAccountedFor: t.notAccountedFor,
      accountedForBy: accountedForDisplayList(t),
    }));
    // See slotBounds: INSTALLMENT keeps a hard purchase-date floor; a
    // REVOLVING tracker's real occurrences all count, only an *unpaid*
    // pre-createdAt one is hidden as a phantom (a real pre-createdAt payment
    // still reads "Minimum … — paid").
    // A paid payoff-plan extra (matched to its payday's planned figure) never
    // fills the minimum slot — see splitPlanExtraPayments (cycle-slots.ts).
    const { planExtraPayments, rest: slotPayments } = splitPlanExtraPayments(
      paymentsAbs,
      planExtrasByDebtId.get(p.debtId) ?? [],
    );
    let { slots, extraPayments } = buildCycleSlots(
      p.nextDueDate,
      p.cadence,
      utcMonthStart,
      utcMonthEnd,
      slotPayments,
      slotBounds(utcMonthStart, {
        debtType: p.debt.debtType,
        purchaseDate: p.debt.purchaseDate,
        trackerCreatedAt: p.createdAt,
        cadence: p.cadence,
        nextDueDate: p.nextDueDate,
        lastPaidDate: p.lastPaidDate,
        installmentsRemaining: p.debt.installmentsRemaining,
        cycleRestartDueDate: p.cycleRestartDueDate,
      }),
    );
    // Minimums an earlier, bigger payment already covered — still listed as
    // expected payments until skipped (resolveMinimumLedger). Computed before
    // the no-minimum fold below empties `slots`.
    const coveredMinimums = coveredMinimumDates({
      slots,
      extraPayments,
      minimumCents: ledgerMinimumCents({
        paidOff: p.debt.balanceCents <= 0,
        nextDueThisMonth: p.nextDueDate >= utcMonthStart && p.nextDueDate < utcMonthEnd,
        amountDueCents: p.amountDueCents,
        minimumCents: p.debt.ignoreMinimumPayment ? 0 : p.amountCents,
      }),
      skippedDates: new Set(
        [...skippedMinimumKeys].flatMap((k) => (k.startsWith(`${p.debtId}:`) ? [k.slice(p.debtId.length + 1)] : [])),
      ),
    }).map((d) => d.toISOString().slice(0, 10));
    extraPayments = [
      ...planExtraPayments.filter((t) => t.occurredOn >= utcMonthStart && t.occurredOn < utcMonthEnd),
      ...extraPayments,
    ].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
    // No-minimum card: fold every paired payment into the flat list so the
    // ledger never shows a "Minimum $0.00" line (same as debts/page.tsx).
    if (p.debt.ignoreMinimumPayment) {
      extraPayments = [...slots.flatMap((s) => (s.payment ? [s.payment] : [])), ...extraPayments].sort(
        (a, b) => a.occurredOn.getTime() - b.occurredOn.getTime(),
      );
      slots = [];
    }
    const toISO = (t: (typeof paymentsAbs)[number]) => ({ ...t, occurredOn: t.occurredOn.toISOString().slice(0, 10) });
    // `confirmed` per projected extra: consume this month's real extra-payment
    // total oldest-projected-line-first, minus whatever already went toward a
    // payoff target the live plan has since dropped. Shared with
    // buckets/[id]/page.tsx and payoff-planner.tsx — see confirmProjectedExtras.
    const projectedExtras = confirmProjectedExtras(
      plannedExtraLinesByDebtId.get(p.debtId) ?? [],
      extraPayments.reduce((s, t) => s + t.amountCents, 0),
      supersededPayoffExtraByDebtId.get(p.debtId) ?? 0,
      postedExtraNettedByDebtId.get(p.debtId) ?? 0,
    );

    return {
      id: p.id,
      debtName: p.debt.account?.displayName ?? p.debt.name,
      // The account's own raw synced name and its institution name
      // (Account.orgName) — distinct from displayName above (a household's
      // own rename), both re-synced from the bank on every sync so neither
      // is lost to a rename. Logo matching alone searches these, and only
      // reaches for orgName as a last resort (see debtLogoSearchText's own
      // comment) — orgName isn't reliably accurate on its own (household
      // report, 2026-09-14: it named a real Discover card "Capital One",
      // producing a false second brand icon when searched unconditionally).
      // Never shown as text.
      accountRawName: p.debt.account?.name ?? null,
      accountOrgName: p.debt.account?.orgName ?? null,
      debtLabel: p.debt.label,
      balanceCents: p.debt.balanceCents,
      amountCents: p.amountCents,
      toleranceCents: p.toleranceCents,
      cadence: p.cadence,
      categoryId: p.categoryId,
      categoryName: p.category?.name ?? null,
      nextDueDate: p.nextDueDate.toISOString().slice(0, 10),
      nextDueThisMonth: p.nextDueDate >= utcMonthStart && p.nextDueDate < utcMonthEnd,
      lastPaidDate: p.lastPaidDate ? p.lastPaidDate.toISOString().slice(0, 10) : null,
      dueDateLocked: p.dueDateLocked,
      // See the identical fix/comment in buckets/[id]/page.tsx — dueDateLocked
      // alone only signals "needs setup" for a REVOLVING debt; an
      // INSTALLMENT/BNPL plan's rolling projection is expected to sit
      // unlocked between real payments, not flagged as needing attention.
      needsAttention: (p.debt.debtType === "REVOLVING" && !p.dueDateLocked) || debtIdsWithPendingReview.has(p.debtId),
      accountBudgetTracked: p.debt.account?.budgetTracked ?? false,
      bucketId: p.bucketId,
      paidOff: p.debt.balanceCents === 0,
      paidOffDate: p.debt.paidOffDate ? p.debt.paidOffDate.toISOString().slice(0, 10) : null,
      linked: p.debt.source === "SIMPLEFIN",
      includeInPayoffPlan: p.debt.includeInPayoffPlan,
      ignoreMinimumPayment: p.debt.ignoreMinimumPayment,
      installmentsTotal: p.debt.installmentsTotal,
      installmentsRemaining: p.debt.installmentsRemaining,
      debtReceiptItems: (p.debt.receiptItems as DebtPaymentWithName["debtReceiptItems"]) ?? null,
      debtReceiptTotalCents: p.debt.receiptTotalCents,
      slots: slots.map((s) => ({ date: s.date.toISOString().slice(0, 10), payment: s.payment ? toISO(s.payment) : null })),
      extraPayments: extraPayments.map(toISO),
      projectedExtras,
      coveredMinimums,
    };
  });
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
