import { Prisma, type BudgetPlan, type BucketTrackingMode, type PaycheckCadence } from "@prisma/client";
import { db } from "@/lib/db";
import { currentPeriodKey, periodKeyOfUTCDate, periodBounds, utcPeriodBounds } from "@/lib/period";
import { monthsAgoPeriodKey, periodLabel, getMonthReport } from "@/lib/monthly-report";
import { SPEND_TX_SELECT, netSpendCents, type SpendTx } from "@/lib/spend";
import { getIncomeSummary, getPrimaryIncomeSchedule } from "@/lib/income";
import { paychecksPerYear, monthlyEquivalentCents, type IncomeCalcMethod } from "@/lib/income-calc";
import {
  getSavingsGoalsWithProgress,
  monthsUntilTargetDate,
  monthlyContributionToHitTarget,
} from "@/lib/savings";
import { currentPeriodBillWhere } from "@/lib/recurring-bills";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import { plannedExtraCentsByDebtInRange } from "@/lib/debt-payments";
import { occurrencesInPeriod } from "@/lib/cycle-slots";
import { refreshReportFindings, buildBudgetRedraftContext } from "@/lib/reports";
import { formatCents } from "@/lib/money";
import { buildBucketAndMerchantDigest, excludeFromBucketHistory } from "@/lib/bucket-composition";
import { upsertMerchantRule, setBoundedMerchantRule } from "@/lib/merchant-rules";
import {
  getMerchantAmountRules,
  resolveNewBucketRoutes,
  type MerchantAmountRuleSummary,
} from "@/lib/budget-merchant-routes";
import { reassignTransactionsForMerchant } from "@/lib/merchant-rule-reassign";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import { isDemoHousehold } from "@/lib/demo";
import { capAtPayoffCents } from "@/lib/debt-payoff";
import { generateBudgetPlanRedraft, type ReportFindings, type MonthSummary } from "@/lib/ai";

// "Set the Month" — the forward-looking monthly budget allocation. Mirrors
// src/lib/reports.ts: a BudgetPlan row is created lazily (createOrRefreshBudgetPlan)
// the first time it's asked for — the hourly rollover job proactively, a
// /budget visit on demand. periodKey is the NEW, in-progress month being
// budgeted, not the just-completed month the sibling Report covers.
//
// Ladder the whole feature serves (see WORKING_ON.md / the plan doc):
//   1. overspending  -> get to break even
//   2. break even    -> run a positive monthly surplus
//   3. surplus       -> direct it per Household.goalPosture
// atBreakeven (deterministic) is the biggest input to how the plan is shaped.

const HISTORY_MONTHS = 13; // 12 for the series + 1 for same-month-last-year headroom
const OUTCOME_WINDOW = 3; // how many prior CONFIRMED plans feed the learning loop
const ROUND_TO_CENTS = 100; // alternates / proposals snap to whole dollars

// ---------- Types ----------

export type BudgetAlternate = { label: string; cents: number };

// What actually landed in a bucket over the trailing digest window — merchant /
// label / category rollup from buildBucketAndMerchantDigest (src/lib/reports.ts).
// Feeds the AI's per-bucket rationale + the allocator's inline "what's in here"
// disclosure. All cents figures are rounded to whole dollars.
export type BucketComposition = {
  totalCents: number;
  txnCount: number;
  // Per merchant, within this bucket: `totalCents` / `txnCount` are the full
  // digest window (~4 months); `lastMonthCents` / `lastMonthTxnCount` are just
  // the previous calendar month; `avgMonthlyCents` is the window total spread
  // evenly. The allocator UI leads with last month and shows the average as
  // context (household feedback 2026-09-02: a bare "82×" over 4 months reads
  // as one month and looks alarming).
  topMerchants: {
    merchant: string;
    txnCount: number;
    totalCents: number;
    lastMonthCents: number;
    lastMonthTxnCount: number;
    avgMonthlyCents: number;
  }[]; // <=5, by $ desc
  topLabels: string[]; // <=3
  topCategories: string[]; // <=3
};

// Household-wide merchant frequency/spread digest — the signal for a
// merchant-driven bucket split (a general marketplace like Amazon spanning many
// categories, vs a single-purpose high-volume store).
export type MerchantDigestEntry = {
  merchant: string;
  txnCount: number;
  sharePct: number; // of all budget-tracked debit txns in the window
  totalCents: number;
  minCents: number;
  maxCents: number;
  dominantBucket: string | null;
  bucketSpread: number; // # distinct buckets these txns landed in
  categorySpread: number; // # distinct categories
  uncategorizedPct: number; // share of this merchant's txns with no bucket
};

// One expected recurring charge behind a RECURRING/MIXED bucket's floor — a
// tracked bill or a bucket-assigned debt payment this month. Display only:
// the allocator's "Recurring Charges" disclosure (household request,
// 2026-10-02). `cents` is the month's total (amount × occurrences, plus any
// payoff-plan extra for a debt); `dueDate` the first occurrence (ISO date).
export type BudgetRecurringItem = {
  label: string;
  cents: number;
  dueDate: string | null;
  // PATTERN = a scheduled outgoing P2P RecurringPattern (a monthly Venmo to a
  // preschool), sized at its range midpoint like PatternRow.
  kind: "BILL" | "DEBT" | "PATTERN";
  // P2P channel for a PATTERN item ("venmo") — the allocator labels it.
  channel?: string;
  // Expected reimbursement already netted out of `cents` (a bill with a
  // pinned CREDIT pattern — range midpoint × occurrences). Optional: absent
  // on debts and on plans stored before 2026-10-02.
  reimbursedCents?: number;
};

export type BudgetBucketRow = {
  bucketId: string;
  name: string;
  trackingMode: BucketTrackingMode;
  currentCapCents: number;
  proposedCents: number;
  // Hard floor: bucket-assigned debt payments + projected bills this bucket's
  // cap must cover. The allocator slider can't go below this.
  minCents: number;
  alternates: BudgetAlternate[];
  rationale: string;
  composition?: BucketComposition;
  recurringItems?: BudgetRecurringItem[];
};

export type BudgetGoalRow = {
  goalId: string;
  name: string;
  proposedCents: number;
  monthlyToHitTargetCents: number | null;
  rationale: string;
};

export type BudgetNewBucket = {
  name: string;
  trackingMode: BucketTrackingMode;
  proposedCapCents: number;
  rationale: string;
  suggestedCategories: string[];
  // Set when this idea is a "give merchant X its own bucket" split — the
  // allocator offers a "Route {merchant} here" toggle and, on confirm, writes
  // an unconditional MerchantRule + backfills. Null for a normal category split.
  sourceMerchant: string | null;
  // The existing bucket that merchant's spend currently lands in, and how much
  // of it per month routing would actually move (resolveNewBucketRoutes —
  // simulated against the household's real MerchantRules, so an amount-banded
  // rule that outranks the route isn't counted). Enabling the idea carves that
  // amount straight out of `sourceBucketId` instead of piling a new cap on top
  // of an already-balanced plan (household feedback 2026-09-02). Both null/0
  // for a non-merchant split or a merchant with no clear current home.
  sourceBucketId: string | null;
  carveFromSourceCents: number;
  // Route only purchases within [min, max] (a bounded MerchantRule) instead of
  // the whole merchant. Both null = every purchase (a base rule). Optional:
  // absent on plans stored before 2026-10-02.
  routeAmountMinCents?: number | null;
  routeAmountMaxCents?: number | null;
  // The merchant's existing amount-banded rules would shadow the route
  // entirely — nothing would ever land in the new bucket, so the allocator
  // offers no route (and no carve) for it.
  routeMovesNothing?: boolean;
  existingAmountRules?: { minCents: number; maxCents: number; bucketName: string | null }[];
};

export type BudgetSeasonalAlert = {
  title: string;
  bucketName: string | null;
  expectedExtraCents: number;
  note: string;
  suggestSinkingFund: boolean;
  sinkingFundName: string | null;
  sinkingFundMonthlyCents: number | null;
  sinkingFundTargetMonth: string | null;
};

// "NONE" only survives for old confirmed snapshots — resolveSurplusDirection
// never returns it now (surplus always has a home: debt, savings goals, or the
// auto "General Savings" catch-all).
export type SurplusDirection = "DEBT" | "SAVINGS" | "SPLIT" | "NONE";

export type SurplusDestination = {
  label: string;
  cents: number;
  kind: "DEBT" | "GOAL" | "CATCH_ALL";
};

export type BudgetSurplus = {
  proposedCents: number;
  direction: SurplusDirection;
  debtExtraCents: number | null;
  rationale: string;
  // AI's plain-language "here's where your extra goes and what it does"
  // (ReportFindings.budgetPlan.surplusExplanation), or a deterministic
  // fallback. Shown in the allocator's read-only "Where Your Surplus Goes"
  // card — the direction itself is not user-editable, it follows goalPosture.
  explanation: string;
  destinations: SurplusDestination[];
};

export type BudgetPlanAllocation = {
  periodKey: string;
  periodLabel: string;
  explanation: string;
  poolCents: number;
  // True when poolCents came from income *detection* (no confirmed Income row
  // yet) rather than tracked income — the allocator surfaces a "confirm your
  // income" nudge and the numbers are framed as a starting point.
  incomeEstimated: boolean;
  lockedObligations: { label: string; cents: number; hint?: string }[];
  lockedObligationsCents: number;
  atBreakeven: boolean;
  // The income schedule the monthly<->per-paycheck conversion used, snapshotted
  // so confirmBudgetPlan converts the Surplus->payoffExtra the same way it was
  // proposed even if the schedule changes in between.
  primaryCadence: PaycheckCadence | null;
  incomeCalcMethod: string;
  buckets: BudgetBucketRow[];
  surplus: BudgetSurplus;
  savingsGoals: BudgetGoalRow[];
  newBuckets: BudgetNewBucket[];
  seasonalAlerts: BudgetSeasonalAlert[];
  // The household's own "tell the AI what you want" instructions and the
  // budgetPlan block the AI redrafted from them (redraftBudgetPlan). While
  // set, every refresh re-merges from this instead of the monthly report's
  // original draft, so the redraft survives the per-render refresh.
  redraft?: { instructions: string; at: string; plan: NonNullable<ReportFindings["budgetPlan"]> } | null;
};

type BudgetPlanInputs = {
  periodKey: string;
  poolCents: number;
  incomeEstimated: boolean;
  goalPosture: string;
  // Surplus-direction context (see resolveSurplusDirection / planSurplusRouting).
  // "Attackable" debt = credit cards + personal loans carrying a real APR
  // (>= 8%) — the debt that actually benefits from throwing extra at it.
  // 0%-APR BNPL and low-rate mortgages/auto/student loans are excluded: they
  // pay down fine on schedule, so a SAVINGS-posture household with only those
  // isn't "carrying attackable debt" for routing purposes.
  attackableDebtCents: number;
  topAttackDebtName: string | null;
  topDebtAprBp: number | null;
  topSavingsApyBp: number | null;
  debtMinimumsCents: number;
  payoffExtraMonthlyCents: number;
  lockedObligationsCents: number;
  primaryCadence: PaycheckCadence | null;
  incomeCalcMethod: string;
  atBreakeven: boolean;
  adultsCount: number;
  kidsCount: number;
  // Household-wide merchant digest (buildBucketAndMerchantDigest) — undefined
  // only for the onboarding path that never assembles it.
  topMerchants?: MerchantDigestEntry[];
  merchantAmountRules?: MerchantAmountRuleSummary[];
  buckets: {
    bucketId: string;
    name: string;
    trackingMode: BucketTrackingMode;
    currentCapCents: number;
    lastMonthActualCents: number;
    threeMonthAvgCents: number;
    twelveMonthAvgCents: number;
    leanestRecentCents: number;
    sameMonthLastYearCents: number | null;
    twelveMonthSeries: number[];
    projectedRecurringCents: number | null;
    debtFloorCents: number;
    composition?: BucketComposition;
    recurringItems: BudgetRecurringItem[];
  }[];
  savingsGoals: {
    goalId: string;
    name: string;
    targetAmountCents: number;
    currentAmountCents: number;
    targetDate: string | null;
    monthlyToHitTargetCents: number | null;
    monthsUntilTarget: number | null;
  }[];
  priorPlanOutcomes: {
    periodKey: string;
    buckets: { name: string; plannedCents: number; actualCents: number; varianceCents: number }[];
  }[];
};

// ---------- Monthly <-> per-paycheck conversion ----------

// Household.payoffExtraCents is PER PAYCHECK (see schema). A monthly surplus
// figure -> per-paycheck divides by paychecks/month, with the same
// BIWEEKLY_CONSERVATIVE special case getIncomeSummary uses (biweekly counted as
// exactly 2/mo). No income schedule -> treat the whole surplus as one monthly
// payment (divisor 1).
export function monthlyToPerPaycheck(
  monthlyCents: number,
  cadence: PaycheckCadence | null,
  method: string,
): number {
  if (!cadence) return Math.round(monthlyCents);
  if (method === "BIWEEKLY_CONSERVATIVE" && cadence === "BIWEEKLY") return Math.round(monthlyCents / 2);
  return Math.round(monthlyCents / (paychecksPerYear(cadence) / 12));
}

export function perPaycheckToMonthly(
  perPaycheckCents: number,
  cadence: PaycheckCadence | null,
  method: string,
): number {
  if (!cadence) return Math.round(perPaycheckCents);
  // Same annualization + BIWEEKLY_CONSERVATIVE rule getIncomeSummary uses.
  return monthlyEquivalentCents({ amountCents: perPaycheckCents, cadence }, method as IncomeCalcMethod);
}

// ---------- Deterministic inputs ----------

function roundDollars(cents: number): number {
  return Math.round(cents / ROUND_TO_CENTS) * ROUND_TO_CENTS;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export async function assembleBudgetPlanInputs(
  householdId: string,
  periodKey: string,
): Promise<BudgetPlanInputs | null> {
  const [household, buckets] = await Promise.all([
    db.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        goalPosture: true,
        payoffPlanEnabled: true,
        payoffExtraCents: true,
        incomeCalcMethod: true,
        adultsCount: true,
        kidsCount: true,
      },
    }),
    // excludedFromAllocation: a one-time/irregular bucket (a Tesla down
    // payment) funded from outside this month's regular income — it isn't
    // a recurring line item competing for a slice of income every month,
    // so it never enters this proposal at all (see the schema comment).
    db.bucket.findMany({
      where: { householdId, excludedFromAllocation: false },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, monthlyCapCents: true, trackingMode: true },
    }),
  ]);
  if (buckets.length === 0) return null;

  // Local-time month keys for the last HISTORY_MONTHS completed months,
  // oldest -> newest.
  const historyKeys: string[] = [];
  for (let i = HISTORY_MONTHS; i >= 1; i--) historyKeys.push(monthsAgoPeriodKey(i));
  const twelveKeys = historyKeys.slice(-12);
  const sameMonthLastYearKey = monthsAgoPeriodKey(12);
  const lastKey = historyKeys[historyKeys.length - 1]; // monthsAgoPeriodKey(1)
  const last3Keys = historyKeys.slice(-3);
  const last6Keys = historyKeys.slice(-6);

  // UTC bounds, not local periodBounds — occurredOn is a UTC-midnight
  // @db.Date (see periodKeyOfUTCDate's own comment, below, on this same
  // distinction).
  const historyStart = utcPeriodBounds(historyKeys[0]).start;
  const historyEnd = utcPeriodBounds(historyKeys[historyKeys.length - 1]).end;
  const { start: utcStart, end: utcEnd } = utcPeriodBounds(periodKey);

  const [income, primaryIncome, debts, historyTxns, debtHistoryTxns, plannedExtraByDebtId, goals, priorPlanOutcomes, bills, savingsApyRows, digest] =
    await Promise.all([
      getIncomeSummary(householdId),
      getPrimaryIncomeSchedule(householdId),
      db.debt.findMany({
        where: { householdId, balanceCents: { gt: 0 } },
        select: {
          id: true,
          name: true,
          minPaymentCents: true,
          debtType: true,
          balanceCents: true,
          aprBasisPoints: true,
          kind: true,
          account: { select: { displayName: true } },
          debtPayment: {
            select: {
              active: true,
              amountCents: true,
              cadence: true,
              nextDueDate: true,
              bucketId: true,
              hiddenFromBucket: true,
            },
          },
        },
      }),
      db.transaction.findMany({
        where: { householdId, bucketId: { not: null }, occurredOn: { gte: historyStart, lt: historyEnd } },
        select: { ...SPEND_TX_SELECT, bucketId: true, occurredOn: true, bill: { select: { cadence: true } } },
      }),
      // Bucket-assigned debt payments over the same history window — folded into
      // each bucket's monthly spend so the allocator's alternates ("Last Month",
      // "3-Mo Avg") reflect what the bucket really costs, mortgage included.
      db.transaction.findMany({
        where: {
          householdId,
          debtPaymentId: { not: null },
          occurredOn: { gte: historyStart, lt: historyEnd },
        },
        select: {
          amountCents: true,
          occurredOn: true,
          debtPayment: { select: { bucketId: true, hiddenFromBucket: true } },
        },
      }),
      plannedExtraCentsByDebtInRange(householdId, utcStart, utcEnd),
      getSavingsGoalsWithProgress(householdId),
      getRecentBudgetPlanOutcomes(householdId),
      db.recurringBill.findMany({
        where: { householdId, bucketId: { not: null }, ...currentPeriodBillWhere() },
        select: {
          name: true,
          bucketId: true,
          amountCents: true,
          cadence: true,
          nextDueDate: true,
          // CREDIT patterns pinned to this bill (a family member paying back
          // their share of the phone plan) — netted below, same as the Bills
          // page's "Expected back" line. Not income (countsAsIncome false),
          // so the pool never counted them either.
          reimbursementPatterns: {
            where: { active: true, direction: "CREDIT", countsAsIncome: false },
            select: { amountMinCents: true, amountMaxCents: true },
          },
        },
      }),
      db.account.findMany({
        where: { householdId, accountType: "SAVINGS", excludedFromNetWorth: false, hiddenAt: null },
        select: { apyBasisPoints: true },
      }),
      buildBucketAndMerchantDigest(householdId),
    ]);

  // Group history: bucketId -> periodKey -> SpendTx[]
  const byBucketMonth = new Map<string, Map<string, SpendTx[]>>();
  const monthsWithData = new Set<string>();
  const bucketModeById = new Map(buckets.map((b) => [b.id, b.trackingMode]));
  for (const t of historyTxns) {
    // Yearly bill payments drop out of a RECURRING/MIXED bucket's history —
    // see excludeFromBucketHistory; projectedRecurringByBucket below adds
    // them back the month they're next due.
    if (excludeFromBucketHistory(bucketModeById.get(t.bucketId as string), t.bill?.cadence)) continue;
    const pk = periodKeyOfUTCDate(t.occurredOn);
    monthsWithData.add(pk);
    const bId = t.bucketId as string;
    let months = byBucketMonth.get(bId);
    if (!months) {
      months = new Map();
      byBucketMonth.set(bId, months);
    }
    const arr = months.get(pk) ?? [];
    arr.push(t);
    months.set(pk, arr);
  }

  const netByBucketMonth = new Map<string, Map<string, number>>();
  for (const [bId, months] of byBucketMonth) {
    const m = new Map<string, number>();
    for (const [pk, txns] of months) m.set(pk, Math.max(0, netSpendCents(txns)));
    netByBucketMonth.set(bId, m);
  }

  // Fold bucket-assigned debt payments into that same per-bucket-month total.
  for (const t of debtHistoryTxns) {
    const dp = t.debtPayment;
    if (!dp?.bucketId || dp.hiddenFromBucket) continue;
    const pk = periodKeyOfUTCDate(t.occurredOn);
    monthsWithData.add(pk);
    let m = netByBucketMonth.get(dp.bucketId);
    if (!m) {
      m = new Map<string, number>();
      netByBucketMonth.set(dp.bucketId, m);
    }
    m.set(pk, (m.get(pk) ?? 0) + Math.abs(t.amountCents));
  }

  // Projected recurring total per bucket (RECURRING/MIXED) — schedule-driven
  // (expected bill amount x occurrences this period), never gated on whether a
  // payment has synced yet. RecurringBills (net of expected reimbursements) plus
  // scheduled P2P patterns; bucket-assigned debt minimums are carried
  // separately as debtFloorByBucket below.
  const projectedRecurringByBucket = new Map<string, number>();
  const recurringItemsByBucket = new Map<string, BudgetRecurringItem[]>();
  const addRecurringItem = (bucketId: string, item: BudgetRecurringItem) => {
    const list = recurringItemsByBucket.get(bucketId) ?? [];
    list.push(item);
    recurringItemsByBucket.set(bucketId, list);
  };
  for (const b of bills) {
    const occurrences = occurrencesInPeriod(b.nextDueDate, b.cadence, utcStart, utcEnd);
    const occ = occurrences.length;
    if (occ === 0) continue;
    // What comes back per occurrence, never more than the bill itself.
    const reimbursedPerOcc = Math.min(
      b.amountCents,
      b.reimbursementPatterns.reduce((sum, p) => sum + Math.round((p.amountMinCents + p.amountMaxCents) / 2), 0),
    );
    const netPerOcc = b.amountCents - reimbursedPerOcc;
    addRecurringItem(b.bucketId as string, {
      label: b.name,
      cents: occ * netPerOcc,
      dueDate: occurrences[0].toISOString().slice(0, 10),
      kind: "BILL",
      reimbursedCents: occ * reimbursedPerOcc,
    });
    projectedRecurringByBucket.set(
      b.bucketId as string,
      (projectedRecurringByBucket.get(b.bucketId as string) ?? 0) + occ * netPerOcc,
    );
  }

  // Scheduled outgoing P2P patterns filed to a bucket — real recurring
  // obligations just like a bill, so they join the same breakdown and floor
  // (household report, 2026-10-02: a monthly Venmo tuition payment missing
  // from Kids' Activities' expected charges). Same filter as the dashboard's
  // getPatternsThisWeek: not pinned to a bill or debt (those already count).
  const p2pPatterns = await db.recurringPattern.findMany({
    where: {
      householdId,
      direction: "DEBIT",
      countsAsIncome: false,
      billId: null,
      debtId: null,
      bucketId: { not: null },
      cadence: { not: null },
      nextDueDate: { not: null },
      ...currentPeriodPatternWhere(),
    },
    select: {
      label: true,
      bucketId: true,
      cadence: true,
      nextDueDate: true,
      amountMinCents: true,
      amountMaxCents: true,
      channelKeyword: true,
    },
  });
  for (const p of p2pPatterns) {
    const occurrences = occurrencesInPeriod(p.nextDueDate!, p.cadence!, utcStart, utcEnd);
    if (occurrences.length === 0) continue;
    const cents = occurrences.length * Math.round((p.amountMinCents + p.amountMaxCents) / 2);
    addRecurringItem(p.bucketId!, {
      label: p.label,
      cents,
      dueDate: occurrences[0].toISOString().slice(0, 10),
      kind: "PATTERN",
      channel: p.channelKeyword,
    });
    projectedRecurringByBucket.set(p.bucketId!, (projectedRecurringByBucket.get(p.bucketId!) ?? 0) + cents);
  }

  // A debt whose recurring payment is assigned to a bucket (a mortgage or auto
  // loan dropped into "Bills") is that bucket's obligation, not a separate
  // locked line — its minimum (plus any payoff-plan extra headed for it this
  // period) becomes a floor under the bucket's cap. Only debt with no bucket
  // stays in lockedObligationsCents.
  const debtFloorByBucket = new Map<string, number>();
  let unbucketedDebtMinCents = 0;
  let bucketedPlannedExtraCents = 0;
  for (const d of debts) {
    const dp = d.debtPayment;
    const plannedExtra = plannedExtraByDebtId.get(d.id) ?? 0;
    if (dp?.active && dp.bucketId && !dp.hiddenFromBucket) {
      const occurrences = occurrencesInPeriod(dp.nextDueDate, dp.cadence, utcStart, utcEnd);
      const occ = Math.max(1, occurrences.length);
      // Every minimum this period together never exceeds what's left to pay
      // the debt off (capAtPayoffCents).
      const floor = capAtPayoffCents(dp.amountCents * occ, d) + plannedExtra;
      addRecurringItem(dp.bucketId, {
        label: d.account?.displayName ?? d.name,
        cents: floor,
        dueDate: occurrences[0]?.toISOString().slice(0, 10) ?? null,
        kind: "DEBT",
      });
      debtFloorByBucket.set(dp.bucketId, (debtFloorByBucket.get(dp.bucketId) ?? 0) + floor);
      bucketedPlannedExtraCents += plannedExtra;
    } else {
      unbucketedDebtMinCents += capAtPayoffCents(d.minPaymentCents, d);
    }
  }

  const bucketInputs = buckets.map((b) => {
    const monthMap = netByBucketMonth.get(b.id) ?? new Map<string, number>();
    const twelveMonthSeries = twelveKeys.map((k) => monthMap.get(k) ?? 0);
    const lastMonthActualCents = monthMap.get(lastKey) ?? 0;
    const last3 = last3Keys.map((k) => monthMap.get(k) ?? 0);
    const nonZero12 = twelveMonthSeries.filter((v) => v > 0);
    const last6NonZero = last6Keys.map((k) => monthMap.get(k) ?? 0).filter((v) => v > 0);
    const isRecurring = b.trackingMode === "RECURRING" || b.trackingMode === "MIXED";
    return {
      bucketId: b.id,
      name: b.name,
      trackingMode: b.trackingMode,
      currentCapCents: b.monthlyCapCents,
      lastMonthActualCents,
      threeMonthAvgCents: Math.round(avg(last3)),
      twelveMonthAvgCents: Math.round(nonZero12.length > 0 ? avg(nonZero12) : 0),
      leanestRecentCents: last6NonZero.length > 0 ? Math.min(...last6NonZero) : 0,
      sameMonthLastYearCents: monthsWithData.has(sameMonthLastYearKey)
        ? monthMap.get(sameMonthLastYearKey) ?? 0
        : null,
      twelveMonthSeries,
      projectedRecurringCents: isRecurring ? projectedRecurringByBucket.get(b.id) ?? 0 : null,
      // Bucket-assigned debt payments (mortgage, auto loans) this bucket's cap
      // MUST cover — a hard floor on its proposed cap, and already excluded
      // from lockedObligationsCents so it isn't reserved twice.
      debtFloorCents: debtFloorByBucket.get(b.id) ?? 0,
      composition: digest.compositionByBucketName.get(b.name),
      recurringItems: isRecurring
        ? (recurringItemsByBucket.get(b.id) ?? []).sort((x, y) => (x.dueDate ?? "").localeCompare(y.dueDate ?? ""))
        : [],
    };
  });

  const primaryCadence = primaryIncome?.cadence ?? null;
  const totalPayoffExtraMonthlyCents = household.payoffPlanEnabled
    ? perPaycheckToMonthly(household.payoffExtraCents, primaryCadence, household.incomeCalcMethod)
    : 0;
  // Payoff extra that landed on a bucket-assigned debt is now inside that
  // bucket's debtFloorCents — only the remainder stays locked.
  const payoffExtraMonthlyCents = Math.max(0, totalPayoffExtraMonthlyCents - bucketedPlannedExtraCents);
  const debtMinimumsCents = unbucketedDebtMinCents;
  const lockedObligationsCents = debtMinimumsCents + payoffExtraMonthlyCents;
  const poolCents = income.totalMonthlyCents;
  const incomeEstimated = income.isEstimated;

  // Each bucket needs at least its debt floor (and, for a bills bucket, its
  // projected bills); compare the greater of that and its current cap.
  const currentCapSum = bucketInputs.reduce(
    (s, b) => s + Math.max(b.currentCapCents, bucketFloorCents(b)),
    0,
  );
  const atBreakeven = poolCents >= currentCapSum + lockedObligationsCents;

  // Credit cards + real-APR personal loans — the debt that benefits from
  // extra payments. Drives whether a DEBT_PAYDOWN/BALANCED posture actually
  // routes surplus to debt, and the APR-aware SPLIT ratio.
  const ATTACKABLE_APR_FLOOR_BP = 800;
  const attackable = debts.filter(
    (d) => d.kind === "CARD" || (d.kind === "LOAN" && d.aprBasisPoints >= ATTACKABLE_APR_FLOOR_BP),
  );
  const attackableDebtCents = attackable.reduce((s, d) => s + d.balanceCents, 0);
  const topAttack = [...attackable].sort((a, b) => b.aprBasisPoints - a.aprBasisPoints)[0] ?? null;
  const savingsApys = savingsApyRows.map((a) => a.apyBasisPoints).filter((v): v is number => v != null);
  const topSavingsApyBp = savingsApys.length > 0 ? Math.max(...savingsApys) : null;

  const now = Date.now();
  const savingsGoals = goals
    .filter((g) => !g.isCatchAll)
    .map((g) => {
    const monthsUntilTarget = monthsUntilTargetDate(g.targetDate, now);
    const monthlyToHitTargetCents = monthlyContributionToHitTarget(g.remainingCents, g.targetDate, now);
    return {
      goalId: g.id,
      name: g.name,
      targetAmountCents: g.targetAmountCents,
      currentAmountCents: g.currentAmountCents,
      targetDate: g.targetDate ? g.targetDate.toISOString().slice(0, 10) : null,
      monthlyToHitTargetCents,
      monthsUntilTarget,
    };
  });

  return {
    periodKey,
    poolCents,
    incomeEstimated,
    goalPosture: household.goalPosture,
    attackableDebtCents,
    topAttackDebtName: topAttack?.name ?? null,
    topDebtAprBp: topAttack?.aprBasisPoints ?? null,
    topSavingsApyBp,
    debtMinimumsCents,
    payoffExtraMonthlyCents,
    lockedObligationsCents,
    primaryCadence,
    incomeCalcMethod: household.incomeCalcMethod,
    atBreakeven,
    adultsCount: household.adultsCount,
    kidsCount: household.kidsCount,
    topMerchants: digest.topMerchants,
    merchantAmountRules: await getMerchantAmountRules(householdId),
    buckets: bucketInputs,
    savingsGoals,
    priorPlanOutcomes,
  };
}

// How the last few CONFIRMED plans actually turned out, per bucket — planned
// cap vs real spend. Only months that are actually complete.
export async function getRecentBudgetPlanOutcomes(
  householdId: string,
): Promise<BudgetPlanInputs["priorPlanOutcomes"]> {
  const nowKey = currentPeriodKey();
  const plans = await db.budgetPlan.findMany({
    where: { householdId, status: "CONFIRMED", periodKey: { lt: nowKey } },
    orderBy: { periodKey: "desc" },
    take: OUTCOME_WINDOW,
  });
  if (plans.length === 0) return [];

  const withReports = await Promise.all(
    plans.map(async (plan) => {
      const alloc = plan.allocation as unknown as BudgetPlanAllocation;
      if (!alloc?.buckets) return null;
      const report = await getMonthReport(householdId, plan.periodKey);
      const actualByName = new Map(report.buckets.map((b) => [b.name.toLowerCase(), b.spentCents]));
      return {
        periodKey: plan.periodKey,
        buckets: alloc.buckets.map((b) => {
          const actual = actualByName.get(b.name.toLowerCase()) ?? 0;
          return {
            name: b.name,
            plannedCents: b.proposedCents,
            actualCents: actual,
            varianceCents: actual - b.proposedCents,
          };
        }),
      };
    }),
  );
  return withReports.filter((o): o is NonNullable<typeof o> => o !== null);
}

// The subset of inputs that goes into the report AI prompt (current.budgetInputs).
export function toMonthSummaryBudgetInputs(inputs: BudgetPlanInputs): NonNullable<MonthSummary["budgetInputs"]> {
  const start = periodBounds(inputs.periodKey).start;
  return {
    targetMonthLabel: start.toLocaleDateString("en-US", { month: "long" }),
    targetMonthNumber: start.getMonth() + 1,
    totalMonthlyIncomeCents: inputs.poolCents,
    atBreakeven: inputs.atBreakeven,
    lockedObligationsCents: inputs.lockedObligationsCents,
    debtMinimumsCents: inputs.debtMinimumsCents,
    payoffExtraMonthlyCents: inputs.payoffExtraMonthlyCents,
    adultsCount: inputs.adultsCount,
    kidsCount: inputs.kidsCount,
    topMerchants: inputs.topMerchants,
    merchantAmountRules: inputs.merchantAmountRules,
    buckets: inputs.buckets.map((b) => ({
      name: b.name,
      trackingMode: b.trackingMode,
      currentCapCents: b.currentCapCents,
      lastMonthActualCents: b.lastMonthActualCents,
      threeMonthAvgCents: b.threeMonthAvgCents,
      twelveMonthAvgCents: b.twelveMonthAvgCents,
      leanestRecentCents: b.leanestRecentCents,
      sameMonthLastYearCents: b.sameMonthLastYearCents,
      twelveMonthSeries: b.twelveMonthSeries,
      projectedRecurringCents: b.projectedRecurringCents,
      debtFloorCents: b.debtFloorCents,
      composition: b.composition,
    })),
    savingsGoals: inputs.savingsGoals.map((g) => ({
      name: g.name,
      targetAmountCents: g.targetAmountCents,
      currentAmountCents: g.currentAmountCents,
      targetDate: g.targetDate,
      monthlyToHitTargetCents: g.monthlyToHitTargetCents,
      monthsUntilTarget: g.monthsUntilTarget,
    })),
    priorPlanOutcomes: inputs.priorPlanOutcomes,
  };
}

// A bucket's cap can never sit below what's physically assigned to it:
// bucket-assigned debt payments + this month's scheduled recurring bills.
// projectedRecurringCents is null for SPEND (=> 0), a real number for
// RECURRING/MIXED. Single source of truth for the slider floor, the
// confirm-time re-clamp, and the atBreakeven currentCapSum.
export function bucketFloorCents(b: {
  debtFloorCents: number;
  projectedRecurringCents: number | null;
}): number {
  return b.debtFloorCents + (b.projectedRecurringCents ?? 0);
}

// A discretionary SPEND/MIXED cap starts conservative — floored at the bucket's
// own leanest recent month — and only relaxes toward SANITY_FLOOR_FRACTION of
// its 3-month average once the household has a track record (2+ of the last 3
// confirmed plans) of actually living at or under plan for that bucket. The
// month actual exceeds plan, it snaps back to conservative.
const SANITY_FLOOR_FRACTION = 0.55;

function discretionaryFloorCents(
  b: BudgetPlanInputs["buckets"][number],
  priorOutcomes: BudgetPlanInputs["priorPlanOutcomes"],
): number {
  const conservative = roundDollars(b.leanestRecentCents);
  const history = priorOutcomes
    .map((p) => p.buckets.find((x) => x.name === b.name))
    .filter((h): h is NonNullable<typeof h> => Boolean(h));
  const underspent = history.filter((h) => h.actualCents <= h.plannedCents).length;
  const provenLeaner = history.length >= 2 && underspent >= Math.ceil(history.length * 0.66);
  if (!provenLeaner || b.threeMonthAvgCents <= 0) return conservative;
  return Math.min(conservative, Math.round(SANITY_FLOOR_FRACTION * b.threeMonthAvgCents));
}

// Near-necessity buckets the deficit trim protects: it drains every
// discretionary bucket to its hard floor before touching one of these, and
// even then only pulls it down to its own leanest recent month, never below
// (household feedback 2026-09-02: "we probably can't skimp on groceries or
// fuel much, those are nearly necessities, but retail, dining etc. could be
// seen as less important"). Inferred from the bucket name plus what's actually
// filed in it (its top categories/labels from the composition digest) so
// there's no per-bucket setup. Deliberately narrow — food, fuel, housing,
// utilities, medical, childcare, insurance — everything else trims first.
const ESSENTIAL_PATTERNS: RegExp[] = [
  /grocer/i,
  /supermarket/i,
  /\bfuel\b/i,
  /\bgas\b/i,
  /petrol/i,
  /\bdiesel\b/i,
  /utilit/i,
  /electric/i,
  /\bwater\b/i,
  /\bsewer\b/i,
  /\btrash\b/i,
  /garbage/i,
  /\brent\b/i,
  /mortgage/i,
  /medical/i,
  /healthcare/i,
  /pharmac/i,
  /prescription/i,
  /\bdental\b/i,
  /childcare/i,
  /\bday ?care\b/i,
  /insurance/i,
];

export function isEssentialBucket(b: { name: string; composition?: BucketComposition }): boolean {
  const haystack = [b.name, ...(b.composition?.topCategories ?? []), ...(b.composition?.topLabels ?? [])].join(" · ");
  return ESSENTIAL_PATTERNS.some((re) => re.test(haystack));
}

// ---------- Alternates ----------

function bucketAlternates(b: BudgetPlanInputs["buckets"][number]): BudgetAlternate[] {
  const raw: BudgetAlternate[] = [
    { label: "Last Month", cents: b.lastMonthActualCents },
    { label: "3-Mo Avg", cents: b.threeMonthAvgCents },
    { label: "12-Mo Avg", cents: b.twelveMonthAvgCents },
    { label: "Leanest Recent", cents: b.leanestRecentCents },
    ...(b.sameMonthLastYearCents != null
      ? [{ label: "Same Month Last Year", cents: b.sameMonthLastYearCents }]
      : []),
  ];

  const out: BudgetAlternate[] = [];
  for (const a of raw) {
    const cents = roundDollars(a.cents);
    if (cents <= 0) continue;
    if (out.some((o) => Math.abs(o.cents - cents) < ROUND_TO_CENTS)) continue;
    out.push({ label: a.label, cents });
  }
  return out.slice(0, 4);
}

// ---------- Merge (deterministic + AI) ----------

const clamp0 = (n: number) => Math.max(0, Math.round(n));

// The surplus direction follows Household.goalPosture — it is NOT chosen per
// month in the allocator anymore. Never returns "NONE": a SAVINGS direction
// always has a home (the "General Savings" catch-all goal if nothing else),
// so every budgeted dollar is tracked somewhere.
export function resolveSurplusDirection(inputs: {
  goalPosture: string;
  attackableDebtCents: number;
}): Exclude<SurplusDirection, "NONE"> {
  const hasDebt = inputs.attackableDebtCents > 0;
  switch (inputs.goalPosture) {
    case "DEBT_PAYDOWN":
      return hasDebt ? "DEBT" : "SAVINGS";
    case "SAVINGS_FOCUSED":
      return "SAVINGS";
    default: // BALANCED
      return hasDebt ? "SPLIT" : "SAVINGS";
  }
}

// Debt's share of a SPLIT surplus: 50% at rate parity, scaling to 75% as the
// top attackable-debt APR pulls 8+ points ahead of the best savings APY.
function debtSplitFraction(inputs: { topDebtAprBp: number | null; topSavingsApyBp: number | null }): number {
  const spreadBp = Math.max(0, (inputs.topDebtAprBp ?? 0) - (inputs.topSavingsApyBp ?? 0));
  return 0.5 + 0.25 * Math.min(1, spreadBp / 800);
}

// Splits a surplus figure into its concrete destinations. Dated savings goals
// get their pace via their own allocator sliders (persisted as
// SavingsGoal.monthlyTargetCents) — the savings portion here tops up the
// "General Savings" catch-all so nothing is left as an untracked pile.
function planSurplusRouting(
  inputs: BudgetPlanInputs,
  direction: SurplusDirection,
  surplusCents: number,
): { debtExtraCents: number; catchAllCents: number; destinations: SurplusDestination[] } {
  if (surplusCents <= 0 || direction === "NONE") {
    return { debtExtraCents: 0, catchAllCents: 0, destinations: [] };
  }
  const debtLabel = inputs.topAttackDebtName ?? "Debt payoff";
  if (direction === "DEBT") {
    return {
      debtExtraCents: surplusCents,
      catchAllCents: 0,
      destinations: [{ label: debtLabel, cents: surplusCents, kind: "DEBT" }],
    };
  }
  if (direction === "SAVINGS") {
    return {
      debtExtraCents: 0,
      catchAllCents: surplusCents,
      destinations: [{ label: "General Savings", cents: surplusCents, kind: "CATCH_ALL" }],
    };
  }
  // SPLIT
  const toDebt = Math.round(surplusCents * debtSplitFraction(inputs));
  const toSavings = surplusCents - toDebt;
  const destinations: SurplusDestination[] = [];
  if (toDebt > 0) destinations.push({ label: debtLabel, cents: toDebt, kind: "DEBT" });
  if (toSavings > 0) destinations.push({ label: "General Savings", cents: toSavings, kind: "CATCH_ALL" });
  return { debtExtraCents: toDebt, catchAllCents: toSavings, destinations };
}

function mergeAllocation(inputs: BudgetPlanInputs, aiPlan: ReportFindings["budgetPlan"]): BudgetPlanAllocation {
  const aiBucketByName = new Map((aiPlan?.buckets ?? []).map((b) => [b.name.toLowerCase(), b]));
  const aiGoalByName = new Map((aiPlan?.savingsAllocations ?? []).map((s) => [s.goalName.toLowerCase(), s]));

  const bucketRows: BudgetBucketRow[] = inputs.buckets.map((b) => {
    const ai = aiBucketByName.get(b.name.toLowerCase());
    let proposed = ai
      ? clamp0(ai.suggestedCapCents)
      : b.threeMonthAvgCents > 0
        ? b.threeMonthAvgCents
        : b.currentCapCents;

    if (b.trackingMode === "RECURRING") {
      // A bills bucket is a fixed line item — exactly this month's scheduled
      // bills plus any debt payment assigned here. No AI wiggle: the number the
      // allocator shows is the number that will be charged.
      proposed = bucketFloorCents(b);
    } else if (b.projectedRecurringCents != null) {
      // MIXED — floor at bills + debt, discretionary rides on top.
      proposed = Math.max(proposed, bucketFloorCents(b));
    }

    // Every bucket's cap must at least cover the bills + debt payments assigned
    // to it (MIXED now included, not just RECURRING).
    const minCents = bucketFloorCents(b);
    proposed = Math.max(proposed, minCents);

    // Discretionary buckets get a conservative floor (their own leanest recent
    // month), relaxing toward ~55% of the 3-month average only once the
    // household has proven it can live leaner. Skipped when not at breakeven —
    // the deficit-trim pass below handles that case and may cut harder.
    if (b.trackingMode !== "RECURRING" && inputs.atBreakeven) {
      proposed = Math.max(proposed, discretionaryFloorCents(b, inputs.priorPlanOutcomes));
    }

    const rationale =
      ai?.rationale ??
      (b.trackingMode === "RECURRING"
        ? bucketFloorCents(b) > 0
          ? `Fixed monthly bills${b.debtFloorCents > 0 ? " plus the debt payment assigned here" : ""}.`
          : "No bills scheduled for this bucket this month."
        : b.debtFloorCents > 0
          ? "Covers the debt payment assigned here, plus the bucket's usual spending."
          : b.threeMonthAvgCents > 0
            ? `Held near recent spending here — about ${formatCents(b.threeMonthAvgCents)}/mo over 3 months.`
            : b.lastMonthActualCents > 0
              ? `Set from last month's spend (${formatCents(b.lastMonthActualCents)}).`
              : "Kept at the current cap — not enough history yet to adjust.");

    return {
      bucketId: b.bucketId,
      name: b.name,
      minCents,
      trackingMode: b.trackingMode,
      currentCapCents: b.currentCapCents,
      proposedCents: clamp0(proposed),
      alternates: b.trackingMode === "RECURRING" ? [] : bucketAlternates(b),
      rationale,
      composition: b.composition,
      recurringItems: b.recurringItems,
    };
  });

  const goalRows: BudgetGoalRow[] = inputs.savingsGoals.map((g) => {
    const ai = aiGoalByName.get(g.name.toLowerCase());
    const proposed = clamp0(ai?.monthlyCents ?? g.monthlyToHitTargetCents ?? 0);
    return {
      goalId: g.goalId,
      name: g.name,
      proposedCents: proposed,
      monthlyToHitTargetCents: g.monthlyToHitTargetCents,
      rationale:
        ai?.rationale ??
        (g.monthlyToHitTargetCents != null
          ? "Keeps this goal on pace for its target date."
          : "No target date set — allocate what you can."),
    };
  });

  let surplusCents = clamp0(aiPlan?.recommendedSurplusCents ?? 0);

  // ---- Normalize to an exact partition: Σ(buckets) + surplus + Σ(goals) + locked == pool ----
  // pool minus every committed slice at the rows' *current* proposed values —
  // positive means room left for Surplus, negative means the plan overshoots.
  // Reads bucket/goal rows live so it stays correct after they're mutated below.
  const partitionResidual = (surplus: number) =>
    inputs.poolCents -
    inputs.lockedObligationsCents -
    bucketRows.reduce((s, b) => s + b.proposedCents, 0) -
    goalRows.reduce((s, g) => s + g.proposedCents, 0) -
    surplus;
  surplusCents += partitionResidual(surplusCents);

  // Buckets the deficit-trim pass below actually cut — their AI rationale (which
  // was written for the un-trimmed number) gets replaced with an honest one.
  const trimmedFromCents = new Map<string, number>();

  if (surplusCents < 0) {
    let shortfall = -surplusCents;
    surplusCents = 0;
    const flexible = bucketRows.filter((b) => b.trackingMode !== "RECURRING");
    for (const b of flexible) trimmedFromCents.set(b.bucketId, b.proposedCents);
    const essentialById = new Map(
      flexible.map((b) => [b.bucketId, isEssentialBucket({ name: b.name, composition: b.composition })]),
    );
    // Trim in priority order: discretionary buckets down to their leanest
    // recent month, then discretionary down to their hard floor, and only
    // THEN — if the gap still isn't closed — essential buckets (Groceries,
    // Fuel, …) down to their leanest recent, never below (household feedback
    // 2026-09-02). A leftover shortfall past that just rides as a small
    // over-plan; the honest "the gap is real" explanation already owns it.
    const phases: { essential: boolean; toLean: boolean }[] = [
      { essential: false, toLean: true },
      { essential: false, toLean: false },
      { essential: true, toLean: true },
    ];
    for (const phase of phases) {
      if (shortfall <= 0) break;
      const reducible = flexible
        .filter((b) => (essentialById.get(b.bucketId) ?? false) === phase.essential)
        .map((b) => {
          const src = inputs.buckets.find((x) => x.bucketId === b.bucketId);
          // Never trim below the bucket's own debt/bills floor.
          const leanFloor = phase.toLean && src ? Math.min(b.proposedCents, roundDollars(src.leanestRecentCents)) : 0;
          const floor = Math.max(leanFloor, b.minCents);
          return { row: b, room: Math.max(0, b.proposedCents - floor) };
        })
        .filter((r) => r.room > 0);
      const totalRoom = reducible.reduce((s, r) => s + r.room, 0);
      if (totalRoom <= 0) continue;
      const take = Math.min(shortfall, totalRoom);
      for (const r of reducible) {
        const cut = Math.round((r.room / totalRoom) * take);
        r.row.proposedCents = Math.max(0, r.row.proposedCents - cut);
      }
      shortfall = Math.max(0, -partitionResidual(0));
    }
    // Keep only rows that meaningfully moved (> 3% or > $5).
    for (const b of flexible) {
      const from = trimmedFromCents.get(b.bucketId) ?? b.proposedCents;
      if (from - b.proposedCents < Math.max(500, from * 0.03)) trimmedFromCents.delete(b.bucketId);
    }
  }

  for (const b of bucketRows) {
    const from = trimmedFromCents.get(b.bucketId);
    if (from != null) {
      b.rationale =
        `Trimmed to keep the month inside your income — your realistic spend here runs closer to ` +
        `${formatCents(roundDollars(from))}. This is the lean version; the gap is real.`;
    }
  }

  // ---- Snap every adjustable allocation to a whole dollar ----
  // RECURRING buckets keep exact cents (they mirror real bill amounts). Everything
  // the household can drag — SPEND/MIXED caps, goals, Surplus — reads as a round
  // dollar, which is far easier to manage. The leftover sub-dollar tail (at most
  // ~$0.50, from rounding poolCents which itself has cents) just falls out of the
  // partition; confirm's BALANCE_TOLERANCE_CENTS absorbs it and the allocator
  // shows "Fully Allocated".
  for (const b of bucketRows) {
    if (b.trackingMode === "RECURRING") continue;
    b.proposedCents = Math.max(b.minCents, roundDollars(b.proposedCents));
  }
  for (const g of goalRows) g.proposedCents = roundDollars(g.proposedCents);

  const exactSurplus = partitionResidual(0);
  if (exactSurplus >= 0) {
    surplusCents = roundDollars(exactSurplus);
  } else {
    // Rounding nudged the plan just over income — pull the few-dollar
    // shortfall back off the largest discretionary bucket first (essentials
    // only if nothing discretionary has room), down to their floors.
    surplusCents = 0;
    let shortfall = -exactSurplus;
    const flexible = [...bucketRows]
      .filter((b) => b.trackingMode !== "RECURRING")
      .sort((a, b) => {
        const ea = isEssentialBucket({ name: a.name, composition: a.composition }) ? 1 : 0;
        const eb = isEssentialBucket({ name: b.name, composition: b.composition }) ? 1 : 0;
        return ea - eb || b.proposedCents - a.proposedCents;
      });
    for (const b of flexible) {
      if (shortfall <= 0) break;
      const cut = roundDollars(Math.min(shortfall, b.proposedCents - b.minCents));
      b.proposedCents -= cut;
      shortfall -= cut;
    }
  }

  const direction: SurplusDirection = surplusCents > 0 ? resolveSurplusDirection(inputs) : "NONE";
  const routing = planSurplusRouting(inputs, direction, surplusCents);
  const debtExtraCents = routing.debtExtraCents > 0 ? routing.debtExtraCents : null;

  const lockedObligations: BudgetPlanAllocation["lockedObligations"] = [];
  if (inputs.debtMinimumsCents > 0)
    lockedObligations.push({
      label: "Debt Minimums",
      cents: inputs.debtMinimumsCents,
      hint: "Debts not assigned to a bucket",
    });
  if (inputs.payoffExtraMonthlyCents > 0)
    lockedObligations.push({
      label: "Payoff Plan Extra",
      cents: inputs.payoffExtraMonthlyCents,
      hint: "From your Debts payoff plan",
    });

  const trimmedCount = trimmedFromCents.size;

  return {
    periodKey: inputs.periodKey,
    periodLabel: periodLabel(inputs.periodKey),
    explanation:
      trimmedCount > 0
        ? `Your realistic spending runs past your income this month, so this plan trims ${trimmedCount} ` +
          `discretionary bucket${trimmedCount === 1 ? "" : "s"} to the leanest version that fits. Those caps are ` +
          `honest about the gap — closing it for real means cutting somewhere or earning more, not just moving sliders.`
        : aiPlan?.overallExplanation?.trim() || deterministicExplanation(inputs),
    poolCents: inputs.poolCents,
    incomeEstimated: inputs.incomeEstimated,
    lockedObligations,
    lockedObligationsCents: inputs.lockedObligationsCents,
    atBreakeven: aiPlan?.atBreakeven ?? inputs.atBreakeven,
    primaryCadence: inputs.primaryCadence,
    incomeCalcMethod: inputs.incomeCalcMethod,
    buckets: bucketRows,
    surplus: {
      proposedCents: surplusCents,
      direction,
      debtExtraCents,
      destinations: routing.destinations,
      rationale:
        direction === "NONE"
          ? inputs.atBreakeven
            ? "Money to deliberately keep unspent each month."
            : "Focus on getting to break even first — grow this once you're there."
          : `Follows your Primary Goal — directed toward ${
              direction === "DEBT" ? "debt payoff" : direction === "SAVINGS" ? "savings" : "debt payoff and savings"
            }.`,
      explanation:
        // The AI's surplusExplanation was written for the surplus it proposed;
        // once the deterministic layer zeroes it (deficit trim), that text is
        // stale — use the honest deterministic line instead.
        direction === "NONE"
          ? trimmedCount > 0
            ? "No surplus — this plan is already the lean version and it still runs slightly past your income."
            : deterministicSurplusExplanation(inputs, direction, surplusCents, routing)
          : aiPlan?.surplusExplanation?.trim() ||
            deterministicSurplusExplanation(inputs, direction, surplusCents, routing),
    },
    savingsGoals: goalRows,
    // Carve/source are filled in by resolveNewBucketRoutes (async — it reads
    // the merchant's real rules and history) right after this merge.
    newBuckets: (aiPlan?.newBuckets ?? []).map((nb) => ({
      name: nb.name,
      trackingMode: nb.trackingMode,
      proposedCapCents: roundDollars(clamp0(nb.monthlyCapCents)),
      rationale: nb.rationale,
      suggestedCategories: nb.suggestedCategories,
      sourceMerchant: nb.sourceMerchant ?? null,
      sourceBucketId: null,
      carveFromSourceCents: 0,
      routeAmountMinCents: nb.routeAmountMinCents ?? null,
      routeAmountMaxCents: nb.routeAmountMaxCents ?? null,
    })),
    seasonalAlerts: (aiPlan?.seasonalAlerts ?? []).map((a) => ({
      title: a.title,
      bucketName: a.bucketName,
      expectedExtraCents: a.expectedExtraCents,
      note: a.note,
      suggestSinkingFund: a.suggestSinkingFund,
      sinkingFundName: a.sinkingFundName,
      sinkingFundMonthlyCents: a.sinkingFundMonthlyCents,
      sinkingFundTargetMonth: a.sinkingFundTargetMonth,
    })),
  };
}

function deterministicSurplusExplanation(
  inputs: BudgetPlanInputs,
  direction: SurplusDirection,
  surplusCents: number,
  routing: { debtExtraCents: number; catchAllCents: number },
): string {
  if (direction === "NONE" || surplusCents <= 0) {
    return inputs.atBreakeven
      ? "No surplus in this plan yet — every dollar is committed to a bucket or goal."
      : "Get to break even first; once income clears every bucket, this is where the extra will go.";
  }
  const total = formatCents(surplusCents);
  const debtName = inputs.topAttackDebtName ?? "your highest-rate debt";
  if (direction === "DEBT") {
    return `Your Primary Goal is Pay Down Debt, so all ${total}/mo of surplus routes as extra principal toward ${debtName}. Change this at Settings → Household → Primary Goal.`;
  }
  if (direction === "SAVINGS") {
    return `Your Primary Goal is Build Savings, so all ${total}/mo of surplus flows into General Savings (after any dated goals are on pace). Change this at Settings → Household → Primary Goal.`;
  }
  return `Your Primary Goal is Balanced, so this month's ${total} surplus splits ${formatCents(routing.debtExtraCents)} to ${debtName} and ${formatCents(routing.catchAllCents)} to General Savings — weighted toward the debt because its rate outpaces your savings. Change this at Settings → Household → Primary Goal.`;
}

function deterministicExplanation(inputs: BudgetPlanInputs): string {
  if (!inputs.atBreakeven) {
    return (
      "Your current caps plus debt payments run past your monthly income, so this plan trims discretionary buckets " +
      "toward recent actual spend to get you back to break even. Once you're there, we'll start building a surplus."
    );
  }
  return (
    "Your income covers your commitments, so this plan holds each bucket near its recent real spend and routes the " +
    "difference into Surplus — money to keep unspent and put toward your goals."
  );
}

// ---------- Lifecycle ----------

export async function createOrRefreshBudgetPlan(
  householdId: string,
  periodKey: string,
): Promise<{ plan: BudgetPlan | null; created: boolean }> {
  const existing = await db.budgetPlan.findUnique({
    where: { householdId_periodKey: { householdId, periodKey } },
  });
  if (existing && existing.status !== "PENDING") return { plan: existing, created: false };
  // Demo household renders only the plan its one-time seed baked (this writes
  // a BudgetPlan row even with no AI, so it needs its own guard).
  if (await isDemoHousehold(householdId)) return { plan: existing, created: false };

  const inputs = await assembleBudgetPlanInputs(householdId, periodKey);
  if (!inputs) return { plan: null, created: false };

  // The forward budgetPlan block rides on the OPEN MONTHLY report's single AI
  // call. If that report predates this feature, force one in-place refresh
  // (still settle-window gated) to populate it.
  // A household redraft ("tell the AI what you want") outranks the report's
  // original draft for as long as this plan stays PENDING.
  const redraft = (existing?.allocation as unknown as BudgetPlanAllocation | undefined)?.redraft ?? null;
  const report = redraft
    ? null
    : await db.report.findFirst({ where: { householdId, type: "MONTHLY", status: "OPEN" } });
  let aiPlan: ReportFindings["budgetPlan"] =
    redraft?.plan ?? (report?.findings as unknown as ReportFindings | undefined)?.budgetPlan ?? null;
  if (report && !aiPlan) {
    await refreshReportFindings(householdId, { force: true });
    const fresh = await db.report.findUnique({ where: { id: report.id } });
    aiPlan = (fresh?.findings as unknown as ReportFindings | undefined)?.budgetPlan ?? null;
  }

  const allocation = await finishAllocation(householdId, mergeAllocation(inputs, aiPlan), redraft);
  const explanation = allocation.explanation;
  const aiGenerated = Boolean(aiPlan);

  if (existing) {
    const updated = await db.budgetPlan.update({
      where: { id: existing.id },
      data: { allocation: allocation as unknown as Prisma.InputJsonValue, explanation, aiGenerated },
    });
    return { plan: updated, created: false };
  }

  try {
    const created = await db.budgetPlan.create({
      data: {
        householdId,
        periodKey,
        allocation: allocation as unknown as Prisma.InputJsonValue,
        explanation,
        aiGenerated,
      },
    });
    return { plan: created, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.budgetPlan.findUnique({
        where: { householdId_periodKey: { householdId, periodKey } },
      });
      return { plan: winner, created: false };
    }
    throw err;
  }
}

async function finishAllocation(
  householdId: string,
  allocation: BudgetPlanAllocation,
  redraft: BudgetPlanAllocation["redraft"],
): Promise<BudgetPlanAllocation> {
  return {
    ...allocation,
    newBuckets: await resolveNewBucketRoutes(householdId, allocation.newBuckets, allocation.buckets),
    redraft: redraft ?? null,
  };
}

// "Tell the AI what you want" — redrafts the PENDING plan's AI layer from the
// household's own instructions plus the draft they're looking at, then
// re-merges with fresh deterministic numbers exactly like a normal refresh.
// The redraft is stored on the allocation so later refreshes keep it.
export async function redraftBudgetPlan(
  householdId: string,
  periodKey: string,
  instructions: string,
): Promise<{ error?: string }> {
  const text = instructions.trim().slice(0, 1000);
  if (!text) return { error: "Tell the AI what you'd like changed." };
  const plan = await db.budgetPlan.findUnique({ where: { householdId_periodKey: { householdId, periodKey } } });
  if (!plan || plan.status !== "PENDING") return { error: "There's no open budget to redraft." };

  const context = await buildBudgetRedraftContext(householdId, periodKey);
  if (!context) return { error: "No buckets to budget." };
  const stored = plan.allocation as unknown as BudgetPlanAllocation;
  const report = await db.report.findFirst({ where: { householdId, type: "MONTHLY", status: "OPEN" } });
  const previous =
    stored.redraft?.plan ?? (report?.findings as unknown as ReportFindings | undefined)?.budgetPlan ?? null;

  const redrafted = await generateBudgetPlanRedraft(householdId, context, previous, text);
  if (!redrafted) return { error: "The AI couldn't redraft the budget right now — try again in a minute." };

  const inputs = await assembleBudgetPlanInputs(householdId, periodKey);
  if (!inputs) return { error: "No buckets to budget." };
  const allocation = await finishAllocation(householdId, mergeAllocation(inputs, redrafted), {
    instructions: text,
    at: new Date().toISOString(),
    plan: redrafted,
  });
  await db.budgetPlan.update({
    where: { id: plan.id },
    data: {
      allocation: allocation as unknown as Prisma.InputJsonValue,
      explanation: allocation.explanation,
      aiGenerated: true,
    },
  });
  return {};
}

// Drops a redraft so the next refresh re-merges from the monthly report's
// original draft.
export async function clearBudgetRedraft(householdId: string, periodKey: string): Promise<void> {
  const plan = await db.budgetPlan.findUnique({ where: { householdId_periodKey: { householdId, periodKey } } });
  if (!plan || plan.status !== "PENDING") return;
  const allocation = plan.allocation as unknown as BudgetPlanAllocation;
  if (!allocation.redraft) return;
  await db.budgetPlan.update({
    where: { id: plan.id },
    data: { allocation: { ...allocation, redraft: null } as unknown as Prisma.InputJsonValue },
  });
  await createOrRefreshBudgetPlan(householdId, periodKey);
}

export async function getPendingBudgetPlan(householdId: string): Promise<BudgetPlan | null> {
  return db.budgetPlan.findFirst({
    where: { householdId, status: "PENDING" },
    orderBy: { periodKey: "desc" },
  });
}

// Keeps a stored allocation in step with buckets that were added/removed after
// the plan was generated — run on every /budget render and inside confirm.
export async function reconcileAllocationWithLiveBuckets(
  allocation: BudgetPlanAllocation,
  householdId: string,
): Promise<BudgetPlanAllocation> {
  // Same excludedFromAllocation exclusion as the proposal query above — a
  // one-time bucket added/removed since this plan was generated shouldn't
  // suddenly enter (or need reconciling out of) an income-allocation plan
  // it was never part of.
  const live = await db.bucket.findMany({
    where: { householdId, excludedFromAllocation: false },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, monthlyCapCents: true, trackingMode: true },
  });
  const rowById = new Map(allocation.buckets.map((r) => [r.bucketId, r]));
  const liveIds = new Set(live.map((b) => b.id));

  let surplusBump = 0;
  for (const r of allocation.buckets) {
    if (!liveIds.has(r.bucketId)) surplusBump += r.proposedCents;
  }

  const buckets: BudgetBucketRow[] = live.map((b) => {
    const existing = rowById.get(b.id);
    if (existing) {
      return { ...existing, name: b.name, currentCapCents: b.monthlyCapCents, trackingMode: b.trackingMode };
    }
    return {
      bucketId: b.id,
      name: b.name,
      trackingMode: b.trackingMode,
      currentCapCents: b.monthlyCapCents,
      proposedCents: 0,
      minCents: 0,
      alternates: [],
      rationale: "Added since this plan was generated — allocate from your surplus.",
    };
  });

  return {
    ...allocation,
    buckets,
    surplus: { ...allocation.surplus, proposedCents: allocation.surplus.proposedCents + surplusBump },
  };
}

export type ConfirmBudgetPlanPayload = {
  periodKey: string;
  buckets: { bucketId: string; cents: number }[];
  newBuckets: {
    name: string;
    trackingMode: BucketTrackingMode;
    capCents: number;
    categories: string[];
    // Set when the user kept the "Route {merchant} here" toggle on for a
    // merchant-driven bucket idea — confirm writes an unconditional MerchantRule
    // and backfills that merchant's past transactions after the plan commits.
    sourceMerchant?: string | null;
    // The bucket the carve came out of (its reduced cap is already in
    // `buckets` above) — passed so the post-commit reassignment also re-files
    // that merchant's history currently sitting in it, not just the
    // never-categorized rows.
    sourceBucketId?: string | null;
  }[];
  surplusCents: number;
  savingsGoalTargets: { goalId: string; cents: number }[];
};

// Generous: the client folds any leftover into Surplus before submitting, so
// the only real drift is a slight income-figure change between generation and
// confirm, plus whole-dollar rounding on the sliders.
const BALANCE_TOLERANCE_CENTS = 1000;

export async function confirmBudgetPlan(
  householdId: string,
  payload: ConfirmBudgetPlanPayload,
): Promise<{ error?: string }> {
  const plan = await db.budgetPlan.findUnique({
    where: { householdId_periodKey: { householdId, periodKey: payload.periodKey } },
  });
  if (!plan) return { error: "No budget plan to confirm." };
  if (plan.status !== "PENDING") return { error: "This budget has already been handled." };

  const inputs = await assembleBudgetPlanInputs(householdId, payload.periodKey);
  if (!inputs) return { error: "No buckets to budget." };

  const liveBucketIds = new Set(inputs.buckets.map((b) => b.bucketId));
  const goalIds = new Set(inputs.savingsGoals.map((g) => g.goalId));

  const floorByBucketId = new Map(inputs.buckets.map((b) => [b.bucketId, bucketFloorCents(b)]));
  const modeByBucketId = new Map(inputs.buckets.map((b) => [b.bucketId, b.trackingMode]));
  const bucketUpdates = payload.buckets
    .filter((b) => liveBucketIds.has(b.bucketId))
    // A bucket can't be set below the debt payments / bills assigned to it.
    // RECURRING keeps its exact bills total; everything else snaps to a whole dollar.
    .map((b) => {
      const floor = floorByBucketId.get(b.bucketId) ?? 0;
      const raw = Math.max(floor, Math.round(b.cents));
      return {
        bucketId: b.bucketId,
        cents: modeByBucketId.get(b.bucketId) === "RECURRING" ? raw : Math.max(floor, roundDollars(raw)),
      };
    });
  const goalUpdates = payload.savingsGoalTargets
    .filter((g) => goalIds.has(g.goalId))
    .map((g) => ({ goalId: g.goalId, cents: Math.max(0, roundDollars(Math.round(g.cents))) }));
  const newBuckets = payload.newBuckets
    .map((nb) => ({
      name: nb.name.trim().slice(0, 60),
      trackingMode: nb.trackingMode,
      capCents: Math.max(0, roundDollars(Math.round(nb.capCents))),
      categories: nb.categories.map((c) => c.trim().slice(0, 60)).filter(Boolean).slice(0, 8),
      sourceMerchant: nb.sourceMerchant?.trim() || null,
      sourceBucketId: nb.sourceBucketId && liveBucketIds.has(nb.sourceBucketId) ? nb.sourceBucketId : null,
    }))
    .filter((nb) => nb.name.length > 0);
  const surplusCents = Math.max(0, roundDollars(Math.round(payload.surplusCents)));

  const allocated =
    bucketUpdates.reduce((s, b) => s + b.cents, 0) +
    newBuckets.reduce((s, b) => s + b.capCents, 0) +
    goalUpdates.reduce((s, g) => s + g.cents, 0) +
    surplusCents +
    inputs.lockedObligationsCents;
  if (Math.abs(allocated - inputs.poolCents) > BALANCE_TOLERANCE_CENTS) {
    return { error: "Allocations don't add up to your monthly income — adjust the sliders and try again." };
  }

  const maxSort = await db.bucket.aggregate({ where: { householdId }, _max: { sortOrder: true } });
  let nextSort = (maxSort._max.sortOrder ?? 0) + 1;

  // Merchant routes to wire up AFTER the plan commits (MerchantRule +
  // reassignTransactionsForMerchant run outside a transaction, like
  // applyRoutingRuleAction).
  const merchantRoutes: {
    bucketId: string;
    merchant: string;
    sourceBucketId: string | null;
    band: { minCents: number; maxCents: number } | null;
  }[] = [];
  // The route's amount band and whether it would move anything come from the
  // stored plan (server-computed), never from the client payload.
  const storedIdeas = new Map(
    ((plan.allocation as unknown as BudgetPlanAllocation).newBuckets ?? []).map((nb) => [nb.name, nb]),
  );

  await db.$transaction(async (tx) => {
    for (const b of bucketUpdates) {
      await tx.bucket.update({ where: { id: b.bucketId }, data: { monthlyCapCents: b.cents } });
    }

    for (const nb of newBuckets) {
      const created = await tx.bucket.create({
        data: {
          householdId,
          name: nb.name,
          monthlyCapCents: nb.capCents,
          trackingMode: nb.trackingMode,
          sortOrder: nextSort++,
        },
      });
      if (nb.categories.length > 0) {
        await tx.billCategory.createMany({
          data: nb.categories.map((name) => ({ householdId, bucketId: created.id, name })),
          skipDuplicates: true,
        });
      }
      const merchant = nb.sourceMerchant;
      if (
        merchant &&
        nb.trackingMode !== "RECURRING" &&
        !P2P_DISCOVERY_KEYWORDS.some((k) => merchant.toLowerCase().includes(k))
      ) {
        const idea = storedIdeas.get(nb.name);
        if (!idea?.routeMovesNothing) {
          merchantRoutes.push({
            bucketId: created.id,
            merchant,
            sourceBucketId: nb.sourceBucketId,
            band:
              idea?.routeAmountMinCents != null && idea?.routeAmountMaxCents != null
                ? { minCents: idea.routeAmountMinCents, maxCents: idea.routeAmountMaxCents }
                : null,
          });
        }
      }
    }

    // Surplus direction is NOT trusted from the client — it follows the
    // household's current Primary Goal, re-derived here.
    const direction: SurplusDirection = surplusCents > 0 ? resolveSurplusDirection(inputs) : "NONE";
    const routing = planSurplusRouting(inputs, direction, surplusCents);

    // Never touches the debt payoff plan (payoffExtraCents / payoffPlanEnabled)
    // — that's set on /debts and only there. Confirming used to overwrite the
    // per-paycheck extra with this month's debt share of the surplus, so a
    // nearly-zero surplus collapsed a $100/paycheck plan to $0.50 (real
    // report, 2026-10-02: "debt paydown plan should not change based on
    // budget"). The plan's existing extra is already reserved as a locked
    // obligation (payoffExtraMonthlyCents) before anything is allocated.
    await tx.household.update({
      where: { id: householdId },
      data: { monthlySurplusTargetCents: surplusCents },
    });

    const providedGoalIds = goalUpdates.map((g) => g.goalId);
    for (const g of goalUpdates) {
      await tx.savingsGoal.update({ where: { id: g.goalId }, data: { monthlyTargetCents: g.cents } });
    }
    // Reset every non-catch-all goal the plan didn't fund back to 0 — the
    // catch-all is driven separately, below, by the surplus routing.
    await tx.savingsGoal.updateMany({
      where: {
        householdId,
        isCatchAll: false,
        id: { notIn: providedGoalIds.length > 0 ? providedGoalIds : ["__none__"] },
      },
      data: { monthlyTargetCents: 0 },
    });

    // Route the savings portion of the surplus into the "General Savings"
    // catch-all so no budgeted dollar is left as an untracked pile — create
    // it the first time it's needed.
    const catchAll = await tx.savingsGoal.findFirst({ where: { householdId, isCatchAll: true } });
    if (routing.catchAllCents > 0) {
      if (catchAll) {
        await tx.savingsGoal.update({
          where: { id: catchAll.id },
          data: { monthlyTargetCents: routing.catchAllCents },
        });
      } else {
        await tx.savingsGoal.create({
          data: {
            householdId,
            name: "General Savings",
            description: "Where budgeted surplus lands once your dated goals are on pace.",
            isCatchAll: true,
            targetAmountCents: 0,
            monthlyTargetCents: routing.catchAllCents,
          },
        });
      }
    } else if (catchAll) {
      await tx.savingsGoal.update({ where: { id: catchAll.id }, data: { monthlyTargetCents: 0 } });
    }

    // Snapshot the confirmed numbers over the original proposal — this is what
    // getRecentBudgetPlanOutcomes diffs against real spend next month.
    const prior = plan.allocation as unknown as BudgetPlanAllocation;
    const bucketSrc = new Map(prior.buckets.map((x) => [x.bucketId, x]));
    const goalSrc = new Map(prior.savingsGoals.map((x) => [x.goalId, x]));
    const snapshot: BudgetPlanAllocation = {
      ...prior,
      buckets: bucketUpdates.map((b) => {
        const src = bucketSrc.get(b.bucketId);
        return {
          bucketId: b.bucketId,
          name: src?.name ?? "",
          trackingMode: src?.trackingMode ?? "SPEND",
          currentCapCents: b.cents,
          proposedCents: b.cents,
          minCents: src?.minCents ?? 0,
          alternates: src?.alternates ?? [],
          rationale: src?.rationale ?? "",
        };
      }),
      surplus: {
        ...prior.surplus,
        proposedCents: surplusCents,
        direction,
        debtExtraCents: routing.debtExtraCents > 0 ? routing.debtExtraCents : null,
        destinations: routing.destinations,
      },
      savingsGoals: goalUpdates.map((g) => {
        const src = goalSrc.get(g.goalId);
        return {
          goalId: g.goalId,
          name: src?.name ?? "",
          proposedCents: g.cents,
          monthlyToHitTargetCents: src?.monthlyToHitTargetCents ?? null,
          rationale: src?.rationale ?? "",
        };
      }),
      newBuckets: [],
    };

    await tx.budgetPlan.update({
      where: { id: plan.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        allocation: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
  });

  // Wire up any merchant-driven bucket the user opted into: an unconditional
  // "this merchant -> this bucket" rule, then a one-time backfill of its past
  // transactions. Post-commit and best-effort — the bucket + rule survive a
  // backfill failure, and the sweep is idempotent. Passing sourceBucketId lets
  // the sweep also pull this merchant's history out of the bucket it was
  // carved from (reassignTransactionsForMerchant otherwise leaves a
  // deliberately-filed bucket alone) — so the new bucket's cap and its actual
  // spend line up from month one.
  // A banded route becomes a bounded rule on exactly that window (replacing
  // any existing rule on the same window), leaving the household's other
  // amount bands alone.
  for (const route of merchantRoutes) {
    if (route.band) {
      await setBoundedMerchantRule(
        householdId,
        route.merchant,
        { amountMinCents: route.band.minCents, amountMaxCents: route.band.maxCents },
        { bucketId: route.bucketId, categoryId: null },
      );
    } else {
      await upsertMerchantRule(
        householdId,
        route.merchant,
        { bucketId: route.bucketId, debtId: null, categoryId: null, isTransfer: false, isIncome: false },
        { confidence: 1, source: "USER" },
      );
    }
    await reassignTransactionsForMerchant(
      householdId,
      route.merchant,
      route.sourceBucketId ? [route.sourceBucketId] : [],
    );
  }

  return {};
}

export async function dismissBudgetPlan(householdId: string, periodKey: string): Promise<void> {
  await db.budgetPlan.updateMany({
    where: { householdId, periodKey, status: "PENDING" },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });
}

// One-click "Start a Sinking Fund" from a seasonal heads-up — creates a
// SavingsGoal that then shows as its own slider in every following month's plan
// until its target date passes.
export async function createSinkingFund(
  householdId: string,
  input: { name: string; monthlyCents: number; targetMonth: string | null },
): Promise<{ error?: string }> {
  const name = input.name.trim().slice(0, 80);
  if (!name) return { error: "Name the sinking fund." };
  const monthlyCents = Math.max(0, Math.round(input.monthlyCents));
  if (monthlyCents <= 0) return { error: "Enter a monthly amount." };

  let targetDate: Date | null = null;
  let monthsRemaining = 1;
  if (input.targetMonth && /^\d{4}-\d{2}$/.test(input.targetMonth)) {
    const [y, m] = input.targetMonth.split("-").map(Number);
    targetDate = new Date(Date.UTC(y, m - 1, 1));
    monthsRemaining = monthsUntilTargetDate(targetDate) ?? 1;
  }

  await db.savingsGoal.create({
    data: {
      householdId,
      name,
      targetAmountCents: monthlyCents * monthsRemaining,
      targetDate: targetDate ?? undefined,
      monthlyTargetCents: monthlyCents,
      reminderEnabled: true,
    },
  });
  return {};
}
