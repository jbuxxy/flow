import type { Prisma } from "@prisma/client";
import { PAYMENT_RECEIPT_SELECT, paymentReceiptOf } from "@/lib/payment-receipt";
import {
  debtNeedsSetup,
  plannedExtraByDebtInPeriod,
  postedExtraNettedByDebt,
  getSkippedMinimumKeys,
  supersededPayoffExtraByDebtInPeriod,
  planExtraTargetsByDebt,
} from "@/lib/debt-payments";
import { coveredMinimumDates, ledgerMinimumCents, tracksMinimum } from "@/lib/minimum-ledger";
import { ACCOUNTED_FOR_SELECT, accountedForDisplayList } from "@/lib/spend";
import { confirmProjectedExtras, capAtPayoffCents } from "@/lib/debt-payoff";
import { splitPlanExtraPayments, buildCycleSlots, slotBounds, cyclePaymentStatus, recentPaymentsWhere } from "@/lib/cycle-slots";
import { skipShownOnBillRow } from "@/lib/recurring-bills";
import { dueStatus } from "@/lib/date";
import { serializePatternDates } from "@/lib/pattern-data";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import type { BillData } from "@/app/bills/bill-row";
import type { DebtPaymentWithName } from "@/app/debts/debt-payment-card";

// The recurring-bill and debt-payment card view models, shared by /bills
// (every one) and a bucket's own page (just that bucket's). Both pages used
// to build these line for line in their own copies — ~230 lines that every
// ledger fix had to land in twice (2026-10-09 /simplify). Each page still
// runs its own query (it owns the `where`); the include shapes and the
// card-building live here.

// A function, not a constant: the reimbursement-pattern filter reads the
// current period.
export function billCardInclude() {
  return {
    category: { select: { name: true } },
    payments: {
      where: recentPaymentsWhere(),
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
  } satisfies Prisma.RecurringBillInclude;
}

export function debtPaymentCardInclude() {
  return {
    debt: {
      select: {
        name: true,
        label: true,
        source: true,
        debtType: true,
        purchaseDate: true,
        balanceCents: true,
        termsConfirmed: true,
        minPaymentCents: true,
        aprBasisPoints: true,
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
      where: recentPaymentsWhere(),
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
  } satisfies Prisma.DebtPaymentInclude;
}

type BillWithCard = Prisma.RecurringBillGetPayload<{ include: ReturnType<typeof billCardInclude> }>;
type DebtPaymentWithCard = Prisma.DebtPaymentGetPayload<{ include: ReturnType<typeof debtPaymentCardInclude> }>;

export function buildBillCards(
  bills: BillWithCard[],
  activeBillSkips: Map<string, Date>,
  monthStart: Date,
  monthEnd: Date,
): BillData[] {
  return bills.map((b): BillData => {
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
      monthStart,
      monthEnd,
      slotBounds(monthStart, { trackerCreatedAt: b.createdAt }),
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
      skippedCycleDueDate:
        skipShownOnBillRow(activeBillSkips.get(b.id), monthStart)?.toISOString().slice(0, 10) ?? null,
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
        ...serializePatternDates(p, monthStart, monthEnd),
      })),
    };
  });
}

// `debtIdsWithPendingReview`: debts with a pending "did your minimum
// change?" review — badges the card (needsAttention).
export async function buildDebtPaymentCards(
  householdId: string,
  debtPayments: DebtPaymentWithCard[],
  debtIdsWithPendingReview: Set<string>,
  monthStart: Date,
  monthEnd: Date,
): Promise<DebtPaymentWithName[]> {
  const [
    plannedExtraLinesByDebtId,
    supersededPayoffExtraByDebtId,
    skippedMinimumKeys,
    postedExtraNettedByDebtId,
    planExtrasByDebtId,
  ] = await Promise.all([
    plannedExtraByDebtInPeriod(householdId, monthStart, monthEnd),
    supersededPayoffExtraByDebtInPeriod(householdId, monthStart, monthEnd),
    getSkippedMinimumKeys(householdId, monthStart, monthEnd),
    postedExtraNettedByDebt(householdId),
    planExtraTargetsByDebt(householdId, monthStart, monthEnd),
  ]);
  return debtPayments.map((p): DebtPaymentWithName => {
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
      monthStart,
      monthEnd,
      slotPayments,
      slotBounds(monthStart, {
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
        nextDueThisMonth: p.nextDueDate >= monthStart && p.nextDueDate < monthEnd,
        amountDueCents: p.amountDueCents,
        minimumCents: tracksMinimum(p.debt, p) ? p.amountCents : 0,
      }),
      skippedDates: new Set(
        [...skippedMinimumKeys].flatMap((k) => (k.startsWith(`${p.debtId}:`) ? [k.slice(p.debtId.length + 1)] : [])),
      ),
    }).map((d) => d.toISOString().slice(0, 10));
    extraPayments = [
      ...planExtraPayments.filter((t) => t.occurredOn >= monthStart && t.occurredOn < monthEnd),
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
      dueLineCents: capAtPayoffCents(p.amountCents, p.debt),
      toleranceCents: p.toleranceCents,
      cadence: p.cadence,
      categoryId: p.categoryId,
      categoryName: p.category?.name ?? null,
      nextDueDate: p.nextDueDate.toISOString().slice(0, 10),
      nextDueThisMonth: p.nextDueDate >= monthStart && p.nextDueDate < monthEnd,
      lastPaidDate: p.lastPaidDate ? p.lastPaidDate.toISOString().slice(0, 10) : null,
      dueDateLocked: p.dueDateLocked,
      // See the identical fix/comment in buckets/[id]/page.tsx — dueDateLocked
      // alone only signals "needs setup" for a REVOLVING debt; an
      // INSTALLMENT/BNPL plan's rolling projection is expected to sit
      // unlocked between real payments, not flagged as needing attention.
      // The shared per-debt rule (debtSetupReason), not a partial copy of it.
      needsAttention: debtNeedsSetup(p.debt, p.dueDateLocked, debtIdsWithPendingReview.has(p.debtId)),
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
}
