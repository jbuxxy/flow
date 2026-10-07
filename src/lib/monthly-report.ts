import { db } from "@/lib/db";
import { periodBounds, utcPeriodBounds } from "@/lib/period";
import { spendByBucketInRange, getBucketTopUpCentsByBucketId } from "@/lib/buckets";
import { getIncomeSummary } from "@/lib/income";
import { offsetSumByCreditId, countedIncomeCents } from "@/lib/reimbursements";
import { getExtraIncomeSummary } from "@/lib/bucket-ad-hoc-topup";

export type BucketMonthStat = {
  id: string;
  name: string;
  capCents: number;
  spentCents: number;
  pct: number;
  achieved: boolean;
};

export type MonthReport = {
  periodKey: string;
  label: string;
  totalSpentCents: number;
  totalCapCents: number;
  // Every dollar of income that actually landed this month, net of refund/
  // debt-payoff offsets — irregular deposits and side income included. This is
  // what the deterministic surplus/deficit verdict is measured against.
  totalIncomeCents: number;
  // The household's planned recurring income for a normal month (confirmed
  // paychecks + P2P if opted in, run through their incomeCalcMethod / "third
  // paycheck" setting). Lower than totalIncomeCents in a month that leaned on
  // one-off money; this is the number forward budgeting is built on.
  recurringIncomeCents: number;
  buckets: BucketMonthStat[];
  // Spend that landed in a one-time bucket (Bucket.excludedFromAllocation — a
  // car down payment funded from savings) this month. Acknowledged, never
  // totaled: it's left out of `buckets`, totalSpentCents and totalCapCents,
  // so a $6K down payment doesn't read as a $6K overspend against a budget
  // that never included it (household rule, 2026-10-02).
  oneTimePurchases: { name: string; capCents: number; spentCents: number }[];
  // This month's ad hoc/P2P income (getExtraIncomeSummary): how much landed,
  // how much auto-apply drew into over-cap buckets (already inside those
  // buckets' capCents), and how much was never needed. No carry-over — the
  // unapplied part is simply part of this month's surplus. Breakdown only:
  // every cent of it is already in totalIncomeCents.
  extraIncome: ExtraIncomeReport;
};

export type ExtraIncomeReport = { receivedCents: number; appliedCents: number; unappliedCents: number; byBucket: { name: string; amountCents: number }[] };

export function periodLabel(periodKey: string): string {
  const { start } = periodBounds(periodKey);
  return start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function monthsAgoPeriodKey(monthsAgo: number, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth() - monthsAgo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function getMonthReport(householdId: string, periodKey: string): Promise<MonthReport> {
  // UTC bounds — spendByBucketInRange now requires them directly (it used
  // to self-convert from local-time bounds, but that broke a different
  // caller already passing UTC-anchored ones; see its own doc comment) —
  // same UTC-midnight @db.Date distinction as getIncomeThisMonth (income.ts).
  const { start: utcStart, end: utcEnd } = utcPeriodBounds(periodKey);

  const [buckets, incomeTxns, spentByBucketId, incomeSummary, topUpCentsByBucketId, extra] = await Promise.all([
    db.bucket.findMany({
      where: { householdId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, monthlyCapCents: true, excludedFromAllocation: true },
    }),
    db.transaction.findMany({
      where: { householdId, isIncome: true, occurredOn: { gte: utcStart, lt: utcEnd } },
      select: { id: true, amountCents: true },
    }),
    // Debt-payment-aware, exactly like the live /buckets page: a payment on a
    // debt whose DebtPayment.bucketId points at this bucket (a mortgage, an
    // auto loan) counts toward that bucket's spend, capped at its budgeted
    // minimum. Refunds still fold onto the charge's month (see src/lib/spend.ts).
    spendByBucketInRange(householdId, utcStart, utcEnd),
    getIncomeSummary(householdId),
    // Same effective-cap fold-in computeProgress (buckets.ts) applies to the
    // live /buckets page — without it, a bucket the household rescued with
    // an ad-hoc top-up mid-month reads "not achieved" here even though the
    // live page correctly shows it covered (real finding, 2026-09-22 code
    // review: this report re-derived "stayed in budget" independently
    // instead of sharing computeProgress's definition).
    getBucketTopUpCentsByBucketId(householdId, periodKey),
    getExtraIncomeSummary(householdId, periodKey),
  ]);

  // A split credit (see TransactionOffset) only counts as income for its
  // unallocated remainder — same netting as getAdHocIncomeThisMonth.
  const offsetSums = await offsetSumByCreditId(incomeTxns.map((t) => t.id));
  const totalIncomeCents = incomeTxns.reduce(
    (s, t) => s + countedIncomeCents(Math.abs(t.amountCents), offsetSums.get(t.id) ?? 0),
    0,
  );

  const oneTimePurchases = buckets
    .filter((b) => b.excludedFromAllocation && (spentByBucketId.get(b.id) ?? 0) > 0)
    .map((b) => ({ name: b.name, capCents: b.monthlyCapCents, spentCents: spentByBucketId.get(b.id) ?? 0 }));

  const bucketStats: BucketMonthStat[] = buckets.filter((b) => !b.excludedFromAllocation).map((b) => {
    const spentCents = spentByBucketId.get(b.id) ?? 0;
    const capCents = b.monthlyCapCents + (topUpCentsByBucketId.get(b.id) ?? 0);
    return {
      id: b.id,
      name: b.name,
      capCents,
      spentCents,
      pct: capCents > 0 ? (spentCents / capCents) * 100 : 0,
      achieved: spentCents <= capCents,
    };
  });

  return {
    periodKey,
    label: periodLabel(periodKey),
    totalSpentCents: bucketStats.reduce((s, b) => s + b.spentCents, 0),
    totalCapCents: bucketStats.reduce((s, b) => s + b.capCents, 0),
    totalIncomeCents,
    recurringIncomeCents: incomeSummary.totalMonthlyCents,
    buckets: bucketStats,
    oneTimePurchases,
    extraIncome: {
      receivedCents: extra.receivedCents,
      appliedCents: extra.appliedCents,
      unappliedCents: extra.unappliedCents,
      byBucket: extra.byBucket,
    },
  };
}
