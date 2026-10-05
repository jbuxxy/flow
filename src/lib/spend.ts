import { db } from "@/lib/db";
import { utcPeriodBounds } from "@/lib/period";
import { budgetTrackedWhere } from "@/lib/budget-tracked";
import { occurrencesInPeriod } from "@/lib/cycle-slots";
import { budgetedDebtPaymentCents } from "@/lib/debt-payment-budget";
import { isPayoffPlanEnabled } from "@/lib/debt-payments";
import { stripPendingPrefix } from "@/lib/pending-prefix";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import type { Prisma } from "@prisma/client";

// Reimbursements/refunds land against the *charge they offset*, not the
// month the credit happened to post (household call, 2026-08-27: a $6.22
// Google One refund that posted in August but reverses a July charge is
// July's, and shouldn't quietly shrink August's Subscriptions spend).
//
// Every "bucket spend for a period" surface — getBucketsWithProgress /
// spendByBucketInRange (progress bars, weekly digest), checkAndSendBucketAlerts,
// getMonthReport (the /reports page + the AI monthly report), and the bucket
// page's own spend-by-category / by-merchant breakdown — routes its raw
// transaction rows through the helpers here so the rule is defined once.
//
// A credit with reimbursesMerchant (a refund the household knows the source
// of but not the exact charge — see Transaction.reimbursesMerchant) or a
// bare uncategorised credit has no specific charge to attach to, so it
// still nets on its own post date; only reimbursesTransactionId credits move.

// Select the fields the helpers below need. `reimbursedBy` is the reverse
// side of Transaction.reimbursesTransactionId — every credit that offsets
// this row, whenever it posted. `offsetsAsDebit` is the partial-amount
// equivalent (TransactionOffset) — a slice of some income credit earmarked
// against this charge (e.g. a trailer-sale deposit covering a loan payoff).
export const SPEND_TX_SELECT = {
  amountCents: true,
  reimbursesTransactionId: true,
  reimbursedBy: { select: { amountCents: true } },
  offsetsAsDebit: { select: { amountCents: true } },
} satisfies Prisma.TransactionSelect;

export type SpendTx = {
  amountCents: number;
  reimbursesTransactionId: string | null;
  reimbursedBy: { amountCents: number }[];
  offsetsAsDebit: { amountCents: number }[];
};

// The charge's amount minus every refund ever linked to it (reimbursedBy
// credits carry a negative amountCents) and every partial offset earmarked
// against it (TransactionOffset.amountCents is positive).
export function netChargeCents(t: SpendTx): number {
  return (
    t.amountCents +
    t.reimbursedBy.reduce((s, r) => s + r.amountCents, 0) -
    t.offsetsAsDebit.reduce((s, o) => s + o.amountCents, 0)
  );
}

// Select shape for a debt-payment transaction's Transaction.accountedForLinks
// (see that field's schema comment) — every already-bucketed purchase this
// payment has been confirmed to cover, with each purchase carrying enough to
// net its own refunds via netChargeCents plus the display fields the
// DebtPaymentRow linker shows per match.
export const ACCOUNTED_FOR_SELECT = {
  accountedForLinks: {
    select: {
      purchaseTransaction: { select: { id: true, merchant: true, occurredOn: true, ...SPEND_TX_SELECT } },
    },
  },
} satisfies Prisma.TransactionSelect;

type AccountedForPurchase = SpendTx & { id: string; merchant: string; occurredOn: Date };
export type AccountedForTx = { accountedForLinks: { purchaseTransaction: AccountedForPurchase }[] };

// Sum of every linked purchase's *net* amount (its own charge, minus any
// refund/offset already linked to it) — what a debt payment's amount should
// be reduced by before counting the rest as new spend. Partial, not
// all-or-nothing: see Transaction.accountedForLinks' own comment.
export function accountedForCents(t: AccountedForTx): number {
  return t.accountedForLinks.reduce((sum, link) => sum + netChargeCents(link.purchaseTransaction), 0);
}

export type AccountedForDisplay = { id: string; merchant: string; amountCents: number; occurredOn: string };

// Display/serializable form of each link — amountCents here is the *net*
// amount (netChargeCents), not the purchase's raw charge, so a partially
// refunded purchase shows (and is excluded against) at what it actually cost.
export function accountedForDisplayList(t: AccountedForTx): AccountedForDisplay[] {
  return t.accountedForLinks.map((link) => ({
    id: link.purchaseTransaction.id,
    merchant: link.purchaseTransaction.merchant,
    amountCents: netChargeCents(link.purchaseTransaction),
    occurredOn: link.purchaseTransaction.occurredOn.toISOString().slice(0, 10),
  }));
}

// Net spend for transactions already scoped to a period + bucket:
//  - a debit counts net of every refund linked to it, no matter when the
//    refund posted (so a later-month refund retroactively shrinks the month
//    the charge was in, and an earlier-month… can't happen);
//  - a refund credit pointing at a specific charge contributes nothing here
//    — it was already subtracted from that charge, in that charge's month,
//    which may not be this period;
//  - a credit with no specific charge still nets on its own date.
export function netSpendCents(txns: SpendTx[]): number {
  let total = 0;
  for (const t of txns) {
    if (t.amountCents > 0) total += netChargeCents(t);
    else if (t.reimbursesTransactionId === null) total += t.amountCents;
  }
  return total;
}

// What a transaction is called in the by-merchant breakdown (and the row filter
// keyed to it). Only for a P2P payment — whose bank merchant is a generic app
// name like "Transfer to Venmo" and tells you nothing — does anything get to
// swap in for it: the household's own label first, else the real party a
// linked receipt resolved (`resolvedMerchant`). Elsewhere in the UI a label is
// just a small annotation next to the real merchant name (see
// TransactionLabelEditor / labelTrigger), never a replacement for it, and a
// receipt is matched to a charge by amount/date, not identity — so outside
// P2P neither one can be trusted to override the bank's own merchant text
// here either: a $4 label meant as a note on a gas-station charge once
// replaced "Crestline Flex" outright in this breakdown (2026-09-22).
// Non-P2P always falls back to the bank merchant, with any "Pending " prefix
// dropped so a hold and its eventual posted charge roll up as one merchant
// instead of a separate "Pending Holiday" row (2026-09-18).
export function spendMerchantKey(
  merchant: string,
  label: string | null | undefined,
  resolvedMerchant?: string | null,
): string {
  const isP2P = P2P_DISCOVERY_KEYWORDS.some((k) => merchant.toLowerCase().includes(k));
  if (isP2P) {
    const l = label?.trim();
    if (l) return l;
    const r = resolvedMerchant?.trim();
    if (r) return r;
  }
  return stripPendingPrefix(merchant) || merchant;
}

// Same rule, but keeping each contribution's category + merchant for the
// breakdown carousel. A charge sits in its own category net of its refunds;
// a specific-charge refund is skipped (counted via its charge); a
// no-specific-charge credit lands in its own category as a negative.
// `merchantOf` lets a caller with a richer effective label (the bucket page's
// pattern/debt label precedence) decide the merchant key; the default is
// spendMerchantKey over the row's own label/resolvedMerchant.
export function spendEntriesFrom<T extends SpendTx & { categoryId: string | null; merchant: string; label?: string | null; resolvedMerchant?: string | null }>(
  txns: T[],
  categoryLabelOf: (categoryId: string | null) => string,
  merchantOf: (t: T) => string = (t) => spendMerchantKey(t.merchant, t.label, t.resolvedMerchant),
): { amountCents: number; categoryLabel: string; merchant: string }[] {
  const entries: { amountCents: number; categoryLabel: string; merchant: string }[] = [];
  for (const t of txns) {
    if (t.amountCents > 0) {
      entries.push({ amountCents: netChargeCents(t), categoryLabel: categoryLabelOf(t.categoryId), merchant: merchantOf(t) });
    } else if (t.reimbursesTransactionId === null) {
      entries.push({ amountCents: t.amountCents, categoryLabel: categoryLabelOf(t.categoryId), merchant: merchantOf(t) });
    }
  }
  return entries;
}

// Sum of every SPEND-only bucket's monthlyCapCents — the dashboard trend
// card's "ceiling" line (household decision 2026-09-06: no separate setting
// to maintain, this reads directly off the caps already set on /buckets).
// Compared against getSpendTrend's oneTimeCumulativeCentsByDay specifically
// (2026-09-16 fix), not the combined total — RECURRING/MIXED spend (the
// "Bills" series, see dailySpendTrendFromTxns below) is excluded from this
// ceiling the same way it's excluded from every other cap-vs-income total:
// a bill's bucket cap mirrors the real bill amount, already reflected in the
// recurring series' own total, not this discretionary one.
export async function getSpendCeilingCents(householdId: string): Promise<number> {
  const buckets = await db.bucket.findMany({
    // excludedFromAllocation: a one-time/irregular bucket (Tesla down
    // payment, a big home repair) funded from outside this month's regular
    // income — see the schema comment on that field. Left out of the
    // ceiling the same way it's left out of every other cap-vs-income
    // total (budget-plan.ts, savings.ts, bucket-allocation-card.tsx,
    // monthly-report.ts).
    where: { householdId, trackingMode: "SPEND", excludedFromAllocation: false },
    select: { monthlyCapCents: true },
  });
  return buckets.reduce((s, b) => s + b.monthlyCapCents, 0);
}

export type DailySpendTrend = {
  // The two series the dashboard card renders separately (2026-09-16 —
  // stacked/split view; redefined 2026-09-17 to match the /buckets page,
  // see below). "Recurring"/"Bills" = every RECURRING-bucket transaction
  // (that bucket only ever holds bills — see BucketTrackingMode's schema
  // comment), every MIXED-bucket transaction that's billId-matched (MIXED's
  // *recurring* portion only — its one-off portion, and everything in a
  // SPEND bucket or no bucket at all, is "one-time"), plus every
  // bucket-assigned DebtPayment routed to a RECURRING/MIXED bucket, capped
  // the same way spendByBucketInRange/budgetedDebtPaymentCents caps it for
  // that same bucket's /buckets progress bar. That last part is *why* this
  // moved off billId-only classification (the original 2026-09-16 version):
  // a household reported the dashboard's "Bills" total ($439) badly
  // undercounting the /buckets page's own Bills-bucket total ($3,041) —
  // the gap was entirely bucket-routed debt/BNPL payments (a mortgage, an
  // auto loan, Affirm/Klarna, card minimums), which getSpendTrend has always
  // excluded from spend entirely (isTransfer:true, same "Transfer"
  // terminology convention as everywhere else) but which the /buckets page
  // deliberately folds into a bucket's own total. Per-day/per-debt-payment
  // math lives in recurringDebtPaymentCentsByDay below.
  recurringCumulativeCentsByDay: number[];
  oneTimeCumulativeCentsByDay: number[];
  recurringTotalCents: number;
  oneTimeTotalCents: number;
};

// isRecurringBucket is precomputed by the caller from the transaction's own
// bucket.trackingMode + billId (see the DailySpendTrend doc comment above)
// — kept out of this pure function so it doesn't need to know Bucket/billId
// shape at all, same reasoning SpendTx itself is a minimal shape rather than
// a raw Prisma row.
// isOneTimeBucket: the transaction sits in an excludedFromAllocation bucket (a
// Tesla down payment funded outside the month's income) — skipped entirely,
// the same way getSpendCeilingCents leaves that bucket's cap out. The trend
// card compares this spend against that ceiling, so counting it here but not
// there put a $6K one-time purchase against a budget that never included it
// (2026-09-19). Optional so callers/tests that don't care stay unchanged.
type DailySpendTx = SpendTx & { occurredOn: Date; isRecurringBucket: boolean; isOneTimeBucket?: boolean };

// Pure day-bucketing + netting logic, split out from getSpendTrend so it's
// testable without a db (see test/lib/spend.test.ts) — same reasoning as
// netSpendCents/spendEntriesFrom above. `extraRecurringPerDay` folds in
// bucket-assigned debt/BNPL payments (recurringDebtPaymentCentsByDay's
// output) — additive, not classified per-transaction here, since a debt
// payment is never itself a SpendTx (no refund/offset relations, and
// isTransfer:true excludes it from the txns query entirely).
export function dailySpendTrendFromTxns(
  txns: DailySpendTx[],
  start: Date,
  daysInMonth: number,
  extraRecurringPerDay: number[] = new Array(daysInMonth).fill(0),
): DailySpendTrend {
  const perDayRecurring = [...extraRecurringPerDay];
  const perDayOneTime = new Array<number>(daysInMonth).fill(0);
  for (const t of txns) {
    if (t.isOneTimeBucket) continue;
    const dayIndex = Math.floor((t.occurredOn.getTime() - start.getTime()) / 86_400_000);
    if (dayIndex < 0 || dayIndex >= daysInMonth) continue;
    let cents: number;
    if (t.amountCents > 0) cents = netChargeCents(t);
    else if (t.reimbursesTransactionId === null) cents = t.amountCents;
    else continue;
    if (t.isRecurringBucket) perDayRecurring[dayIndex] += cents;
    else perDayOneTime[dayIndex] += cents;
  }

  let runningRecurring = 0;
  let runningOneTime = 0;
  const recurringCumulativeCentsByDay = perDayRecurring.map((c) => (runningRecurring += c));
  const oneTimeCumulativeCentsByDay = perDayOneTime.map((c) => (runningOneTime += c));

  return {
    recurringCumulativeCentsByDay,
    oneTimeCumulativeCentsByDay,
    recurringTotalCents: runningRecurring,
    oneTimeTotalCents: runningOneTime,
  };
}

export type DebtPaymentSpendTx = {
  occurredOn: Date;
  // Math.abs(amountCents) net of accountedForCents(t) — same math
  // spendByBucketInRange uses to build a DebtPayment's paidCents.
  netCents: number;
  debtPaymentId: string;
  minimumCents: number;
  occurrencesThisPeriod: number;
};

// Per-day *counted* contribution of every bucket-assigned debt/BNPL payment
// toward the "Bills" series — the piece that's new relative to
// budgetedDebtPaymentCents/spendByBucketInRange (buckets.ts / debt-payment-
// budget.ts), which only ever computed one number for the whole period.
// Grouped by debtPaymentId and walked in occurredOn order so a plan-off
// ceiling still applies per-debt/per-cycle, not per-transaction: each
// transaction's *delta* (this payment's newly-counted slice, i.e. this
// debt's running countedCents before vs. after) lands on its own day. The
// ceiling (min(paidCents, minimumCents × occurrences)) is monotonic
// non-decreasing in cumulative paidCents, so every delta is >= 0 and the
// deltas telescope to exactly the period total budgetedDebtPaymentCents
// itself would return — the dashboard trend line's Bills total always
// converges to the exact figure the /buckets page shows for the same bucket
// by month's end, it's just spread across the days the money actually moved
// instead of landing as one lump on the last day.
export function recurringDebtPaymentCentsByDay(
  txns: DebtPaymentSpendTx[],
  start: Date,
  daysInMonth: number,
  payoffPlanEnabled: boolean,
): number[] {
  const perDay = new Array<number>(daysInMonth).fill(0);
  const byDebtPayment = new Map<string, DebtPaymentSpendTx[]>();
  for (const t of txns) {
    const list = byDebtPayment.get(t.debtPaymentId);
    if (list) list.push(t);
    else byDebtPayment.set(t.debtPaymentId, [t]);
  }
  for (const group of byDebtPayment.values()) {
    group.sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
    let paidSoFar = 0;
    let countedSoFar = 0;
    for (const t of group) {
      paidSoFar += t.netCents;
      const { countedCents } = budgetedDebtPaymentCents({
        paidCents: paidSoFar,
        minimumCents: t.minimumCents,
        occurrencesThisPeriod: t.occurrencesThisPeriod,
        payoffPlanEnabled,
      });
      const delta = countedCents - countedSoFar;
      countedSoFar = countedCents;
      const dayIndex = Math.floor((t.occurredOn.getTime() - start.getTime()) / 86_400_000);
      if (dayIndex < 0 || dayIndex >= daysInMonth || delta === 0) continue;
      perDay[dayIndex] += delta;
    }
  }
  return perDay;
}

export async function getSpendTrend(householdId: string, periodKey: string): Promise<DailySpendTrend> {
  // UTC bounds, not local periodBounds — occurredOn is a UTC-midnight
  // @db.Date like nextDueDate/lastPaidDate (see simplefin-sync.ts's own
  // comment on how it's written), so comparing it against a local-time
  // boundary misclassifies the 1st of the month the same way it would for
  // a due date (2026-09-11 incident — see WORKING_ON.md). Local
  // `periodBounds` would have excluded every 1st-of-month transaction from
  // this query entirely (its stored UTC-midnight instant sorts before the
  // local start-of-month boundary in any timezone behind UTC), not just
  // shifted its day-of-month index.
  const { start, end } = utcPeriodBounds(periodKey);
  const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);

  const [rawTxns, debtTxns, payoffPlanEnabled] = await Promise.all([
    db.transaction.findMany({
      where: {
        householdId,
        occurredOn: { gte: start, lt: end },
        isIncome: false,
        // Excludes every real transfer AND every debt/BNPL payment (both are
        // isTransfer:true by convention — see WORKING_ON.md's "Transfer"
        // terminology note) so this reads as true discretionary/bill
        // money-out, not money moving between the household's own accounts.
        // Bucket-assigned debt/BNPL payments are added back in below, via
        // the separate debtTxns query — folded into the Bills series only,
        // never one-time.
        isTransfer: false,
        ...budgetTrackedWhere(),
      },
      select: {
        ...SPEND_TX_SELECT,
        occurredOn: true,
        billId: true,
        bucket: { select: { trackingMode: true, excludedFromAllocation: true } },
      },
    }),
    // Mirrors spendByBucketInRange's own debt-payment query (buckets.ts) —
    // same "DebtPayment.bucketId counts toward its bucket like a real bill"
    // rule, just walked per-day instead of summed once. See
    // recurringDebtPaymentCentsByDay's own comment.
    db.transaction.findMany({
      where: { householdId, debtPaymentId: { not: null }, occurredOn: { gte: start, lt: end } },
      select: {
        amountCents: true,
        occurredOn: true,
        debtPaymentId: true,
        debtPayment: {
          select: {
            bucketId: true,
            amountCents: true,
            cadence: true,
            nextDueDate: true,
            bucket: { select: { trackingMode: true } },
          },
        },
        ...ACCOUNTED_FOR_SELECT,
      },
    }),
    isPayoffPlanEnabled(householdId),
  ]);

  const txns: DailySpendTx[] = rawTxns.map((t) => ({
    ...t,
    isOneTimeBucket: t.bucket?.excludedFromAllocation === true,
    isRecurringBucket:
      t.bucket !== null && (t.bucket.trackingMode === "RECURRING" || (t.bucket.trackingMode === "MIXED" && t.billId !== null)),
  }));

  const recurringDebtTxns: DebtPaymentSpendTx[] = [];
  for (const t of debtTxns) {
    const dp = t.debtPayment;
    if (!dp?.bucketId || !dp.bucket) continue;
    if (dp.bucket.trackingMode !== "RECURRING" && dp.bucket.trackingMode !== "MIXED") continue;
    const accountedFor = accountedForCents(t);
    recurringDebtTxns.push({
      occurredOn: t.occurredOn,
      netCents: Math.max(0, Math.abs(t.amountCents) - accountedFor),
      debtPaymentId: t.debtPaymentId!,
      minimumCents: dp.amountCents,
      occurrencesThisPeriod: occurrencesInPeriod(dp.nextDueDate, dp.cadence, start, end).length,
    });
  }
  const extraRecurringPerDay = recurringDebtPaymentCentsByDay(recurringDebtTxns, start, daysInMonth, payoffPlanEnabled);

  return dailySpendTrendFromTxns(txns, start, daysInMonth, extraRecurringPerDay);
}
