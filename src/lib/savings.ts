import { db } from "@/lib/db";
import { isDemoHousehold } from "@/lib/demo";
import { sendPushToHouseholdForType } from "@/lib/push";
import { formatCents } from "@/lib/money";
import { currentWeekKey, currentDateKey } from "@/lib/period";
import { getIncomeSummary } from "@/lib/income";
import { getBucketsWithProgress } from "@/lib/buckets";
import {
  generateGoalFeedback,
  planGoalFromDescription,
  type GoalPlanMessage,
  type GoalPlanProposal,
} from "@/lib/ai";
import type { GoalAlertLevel, DataSource, AccountType } from "@prisma/client";

// A goal watches money accumulating in an account the household owns —
// never a liability. Excludes CREDIT_CARD/LOAN so a card/loan balance can't
// be picked as the thing a savings goal tracks (that's what Debt is for).
export const GOAL_LINKABLE_ACCOUNT_TYPES: AccountType[] = ["CHECKING", "SAVINGS", "INVESTMENT", "OTHER"];

// ~30.44-day months — a rough "months until this date" for goal-pace math,
// not a precise calendar diff. Shared by the weekly nudge, the goal-insight
// prompt, and the "Set the Month" budget planner so all three pace the same way.
export const MS_PER_AVG_MONTH = 1000 * 60 * 60 * 24 * 30.44;

export function monthsUntilTargetDate(targetDate: Date | null, from: number = Date.now()): number | null {
  if (!targetDate) return null;
  return Math.max(1, Math.ceil((targetDate.getTime() - from) / MS_PER_AVG_MONTH));
}

// Monthly contribution needed to cover `remainingCents` by `targetDate`.
// null when there's no date or nothing left to save.
export function monthlyContributionToHitTarget(
  remainingCents: number,
  targetDate: Date | null,
  from: number = Date.now(),
): number | null {
  const months = monthsUntilTargetDate(targetDate, from);
  if (!months || remainingCents <= 0) return null;
  return Math.ceil(remainingCents / months);
}

export type GoalProgress = {
  id: string;
  name: string;
  targetAmountCents: number;
  // Saved *toward the goal* (balance − baseline, clamped ≥ 0), not the raw
  // linked-account balance. See goalSavedCents.
  currentAmountCents: number;
  // The linked account's balance when it was linked — 0 for a manual goal or
  // a goal linked before this existed. Non-zero means "you started with a
  // head start already in the account," worth showing.
  baselineCents: number;
  targetDate: Date | null;
  pct: number;
  remainingCents: number;
  projectedCompletionDate: Date | null;
  onTrackForTargetDate: boolean | null;
  // The auto-created "General Savings" goal that absorbs budgeted surplus
  // routed to savings — excluded from the "Set the Month" per-goal sliders,
  // driven entirely by goalPosture + the Surplus figure. See confirmBudgetPlan.
  isCatchAll: boolean;
};

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

// What's actually been saved *toward this goal*: the linked account's
// balance (or a manual goal's contribution sum) minus whatever was already
// in the account when it was linked (baselineCents; 0 for a manual goal).
// Clamped at 0 — dipping below the starting balance reads as "no progress,"
// never negative. This is the number every "X of Y saved" surface should
// show, and computeProgress folds it back into GoalProgress.currentAmountCents
// so consumers of that type don't each have to know about the baseline.
export function goalSavedCents(goal: { currentAmountCents: number; baselineCents: number }): number {
  return Math.max(0, goal.currentAmountCents - goal.baselineCents);
}

function computeProgress(goal: {
  id: string;
  name: string;
  targetAmountCents: number;
  currentAmountCents: number;
  baselineCents: number;
  targetDate: Date | null;
  createdAt: Date;
  isCatchAll?: boolean;
}): GoalProgress {
  const savedCents = goalSavedCents(goal);
  const pct = goal.targetAmountCents > 0 ? (savedCents / goal.targetAmountCents) * 100 : 0;
  const remainingCents = goal.targetAmountCents - savedCents;

  const monthsSinceCreated = Math.max(
    1,
    (Date.now() - goal.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44),
  );
  const avgMonthlyCents = savedCents / monthsSinceCreated;

  const projectedCompletionDate =
    avgMonthlyCents > 0 && remainingCents > 0
      ? addMonths(new Date(), Math.ceil(remainingCents / avgMonthlyCents))
      : remainingCents <= 0
        ? new Date()
        : null;

  const onTrackForTargetDate =
    !goal.targetDate || !projectedCompletionDate
      ? null
      : projectedCompletionDate <= goal.targetDate;

  return {
    id: goal.id,
    name: goal.name,
    targetAmountCents: goal.targetAmountCents,
    // Progress toward the goal, not the raw account balance — see goalSavedCents.
    currentAmountCents: savedCents,
    baselineCents: goal.baselineCents,
    targetDate: goal.targetDate,
    pct,
    remainingCents,
    projectedCompletionDate,
    onTrackForTargetDate,
    isCatchAll: goal.isCatchAll ?? false,
  };
}

export async function getSavingsGoalsWithProgress(householdId: string): Promise<GoalProgress[]> {
  const goals = await db.savingsGoal.findMany({
    where: { householdId },
    orderBy: { createdAt: "asc" },
  });
  return goals.map(computeProgress);
}

const MILESTONES: { level: GoalAlertLevel; threshold: number; label: string }[] = [
  { level: "MILESTONE_100", threshold: 100, label: "reached its goal" },
  { level: "MILESTONE_75", threshold: 75, label: "75% of the way there" },
  { level: "MILESTONE_50", threshold: 50, label: "halfway there" },
  { level: "MILESTONE_25", threshold: 25, label: "25% of the way there" },
];

// One push per goal/milestone, ever (dedup via GoalAlert's unique constraint)
// — a single large contribution that crosses several milestones at once will
// fire each of them, which is the desired "achievement cascade" behavior.
export async function checkAndSendGoalAlerts(goalId: string): Promise<void> {
  const goal = await db.savingsGoal.findUnique({ where: { id: goalId } });
  if (!goal) return;

  const savedCents = goalSavedCents(goal);
  const pct = goal.targetAmountCents > 0 ? (savedCents / goal.targetAmountCents) * 100 : 0;

  for (const { level, threshold, label } of MILESTONES) {
    if (pct < threshold) continue;
    try {
      await db.goalAlert.create({ data: { goalId, level } });
    } catch {
      continue; // already sent
    }
    await sendPushToHouseholdForType(goal.householdId, "SAVINGS_MILESTONE", {
      title: `${goal.name} ${label}`,
      body: `${formatCents(savedCents)} of ${formatCents(goal.targetAmountCents)} saved.`,
      url: `/savings/${goal.id}`,
    });
  }
}

// Shared by createGoal and linkGoalAccount: validates accountId belongs to
// this household and resolves the (source, currentAmountCents, baselineCents)
// triple linking to it implies. The amount fields are only present when
// accountId resolves to a real account — an absent accountId or one that
// fails validation just means "not linked," and deliberately leaves them
// out of the result rather than zeroing them, so an unlink (see
// linkGoalAccount) can decide for itself what to keep.
//
// baselineCents = currentAmountCents at link time: the starting line, so
// money already sitting in the account isn't counted as progress toward
// this goal (see goalSavedCents).
export async function resolveGoalAccountLink(
  accountId: string | null | undefined,
  householdId: string,
): Promise<{ accountId: string | null; source: DataSource; currentAmountCents?: number; baselineCents?: number }> {
  if (!accountId) return { accountId: null, source: "MANUAL" };

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account || account.householdId !== householdId) return { accountId: null, source: "MANUAL" };
  if (!GOAL_LINKABLE_ACCOUNT_TYPES.includes(account.accountType)) return { accountId: null, source: "MANUAL" };

  const balanceCents = Math.max(account.balanceCents, 0);
  return { accountId, source: "SIMPLEFIN", currentAmountCents: balanceCents, baselineCents: balanceCents };
}

export type SavingsCapacity = {
  incomeCents: number;
  bucketCapsCents: number;
  debtMinimumsCents: number;
  // The household's own extra-toward-debt commitment (Debts > payoff
  // planner), when that plan is turned on — already spoken for, so it's
  // broken out separately rather than folded into debtMinimumsCents.
  committedDebtExtraCents: number;
  estimatedMonthlySaveableCents: number;
};

// One shared household-wide "how much could we realistically put toward
// savings each month" figure: monthly income minus every bucket's monthly
// cap minus every active (balance > 0) debt's minimum payment minus
// whatever extra the household already committed to debt payoff (if that
// plan is enabled) — the same "active debt" filter debts/page.tsx uses.
// That committed extra is already spoken for; without subtracting it, a
// household paying $X/mo extra toward debt was told that same $X was *also*
// free to save, double-counting it. Deliberately not divided per-goal:
// multiple goals compete for the same discretionary income, so a household
// with three goals doesn't each get a third of this number, it's one shared
// ceiling all of them draw against. Feeds both the AI feedback prompt (see
// getGoalInsight) and the plain number shown next to it.
export async function getHouseholdSavingsCapacity(householdId: string): Promise<SavingsCapacity> {
  const [income, buckets, debtAgg, household] = await Promise.all([
    getIncomeSummary(householdId),
    getBucketsWithProgress(householdId),
    db.debt.aggregate({
      where: { householdId, balanceCents: { gt: 0 } },
      _sum: { minPaymentCents: true },
    }),
    db.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { payoffPlanEnabled: true, payoffExtraCents: true },
    }),
  ]);

  // excludedFromAllocation: a one-time/irregular bucket (a Tesla down
  // payment) funded from outside this month's regular income — doesn't
  // eat into what's realistically saveable, the same way it's excluded
  // from every other cap-vs-income total (see the schema comment).
  // Whether to back b.topUpCents out of computeProgress's effective-cap
  // fold-in (buckets.ts) depends on income.includeP2PInIncomeCalc — that
  // setting is what decides whether income.totalMonthlyCents above already
  // counts the ad hoc/P2P money a top-up draws from (getAdHocIncomeThisMonth,
  // income.ts — the same pool autoApplyAdHocIncomeToBuckets spends from,
  // bucket-ad-hoc-topup.ts). ON: that money is already counted as income
  // *and* already spent covering this bucket's overage, so leaving the
  // effective (topped-up) cap in nets it to zero. OFF: the top-up money was
  // never counted as income at all, so subtracting it keeps this comparing
  // against the same (smaller) income figure income.totalMonthlyCents
  // actually is (2026-09-22 code review finding — the original fix only
  // handled the OFF case, over-reporting saveable cash by the top-up amount
  // for a household with the setting ON).
  const bucketCapsCents = buckets
    .filter((b) => !b.excludedFromAllocation)
    .reduce((sum, b) => sum + b.monthlyCapCents - (income.includeP2PInIncomeCalc ? 0 : b.topUpCents), 0);
  const debtMinimumsCents = debtAgg._sum.minPaymentCents ?? 0;
  const committedDebtExtraCents = household.payoffPlanEnabled ? household.payoffExtraCents : 0;
  const estimatedMonthlySaveableCents = Math.max(
    0,
    income.totalMonthlyCents - bucketCapsCents - debtMinimumsCents - committedDebtExtraCents,
  );

  return {
    incomeCents: income.totalMonthlyCents,
    bucketCapsCents,
    debtMinimumsCents,
    committedDebtExtraCents,
    estimatedMonthlySaveableCents,
  };
}

// One-shot, uncached AI turn in the conversational goal-planning flow (see
// AddGoalForm) — deliberately not persisted anywhere (unlike GoalInsight):
// it's a pre-save planning aid, not a recurring dashboard narrative.
// Recomputes household capacity fresh on every call (cheap, plain
// arithmetic) so a mid-conversation bucket/income change is reflected on
// the next turn. Returns null with no side effect when no AI provider is
// configured — the caller (planGoal, src/app/savings/actions.ts) signals
// that back to the client, which falls back to plain manual entry instead
// of blocking goal creation on AI being set up.
export async function getGoalPlan(
  householdId: string,
  messages: GoalPlanMessage[],
): Promise<GoalPlanProposal | null> {
  const capacity = await getHouseholdSavingsCapacity(householdId);

  return planGoalFromDescription(
    householdId,
    messages,
    {
      householdMonthlyIncomeCents: capacity.incomeCents,
      householdBucketCapsCents: capacity.bucketCapsCents,
      householdDebtMinimumsCents: capacity.debtMinimumsCents,
      estimatedMonthlySaveableCents: capacity.estimatedMonthlySaveableCents,
    },
    currentDateKey(),
  );
}

export type GoalInsightResult = { feedback: string; estimatedMonthlySaveableCents: number };

// Check-on-read, regenerate-if-stale AI feedback for one goal — same
// pattern as getUpcomingBillsSummary (BillsInsight)/getMonthlyInsight
// (MonthlyInsight), keyed by calendar week (see currentWeekKey) instead of
// day or month: a goal's numbers move slowly enough that daily generation
// would be wasted AI spend, but monthly would feel unresponsive to a fresh
// contribution. Returns null with no side effect when the household has no
// AI provider configured — callers should render nothing in that case, same
// as UpcomingBillsCard already does.
export async function getGoalInsight(
  householdId: string,
  goal: {
    id: string;
    name: string;
    description: string | null;
    targetAmountCents: number;
    targetDate: Date | null;
    currentAmountCents: number;
    baselineCents: number;
    createdAt: Date;
    monthlyTargetCents?: number;
  },
): Promise<GoalInsightResult | null> {
  const weekKey = currentWeekKey();

  const cached = await db.goalInsight.findUnique({
    where: { goalId_weekKey: { goalId: goal.id, weekKey } },
  });
  if (cached) return { feedback: cached.feedback, estimatedMonthlySaveableCents: cached.estimatedMonthlySaveableCents };

  const [capacity, recentContributions, household] = await Promise.all([
    getHouseholdSavingsCapacity(householdId),
    db.savingsContribution.findMany({
      where: { goalId: goal.id },
      orderBy: { occurredOn: "desc" },
      take: 6,
      select: { amountCents: true, occurredOn: true },
    }),
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { goalPosture: true } }),
  ]);

  const progress = computeProgress(goal);

  const feedback = await generateGoalFeedback(householdId, {
    name: goal.name,
    description: goal.description,
    targetAmountCents: goal.targetAmountCents,
    targetDate: goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : null,
    // Progress toward the goal (net of the starting balance), not the raw
    // linked-account balance — matches what the household sees on the page.
    currentAmountCents: progress.currentAmountCents,
    pct: progress.pct,
    projectedCompletionDate: progress.projectedCompletionDate
      ? progress.projectedCompletionDate.toISOString().slice(0, 10)
      : null,
    recentContributions: recentContributions.map((c) => ({
      amountCents: c.amountCents,
      occurredOn: c.occurredOn.toISOString().slice(0, 10),
    })),
    goalPosture: household.goalPosture,
    householdMonthlyIncomeCents: capacity.incomeCents,
    householdBucketCapsCents: capacity.bucketCapsCents,
    householdDebtMinimumsCents: capacity.debtMinimumsCents,
    householdCommittedDebtExtraCents: capacity.committedDebtExtraCents,
    estimatedMonthlySaveableCents: capacity.estimatedMonthlySaveableCents,
    monthlyTargetCents: goal.monthlyTargetCents ?? 0,
  });
  if (!feedback) return null;

  await db.goalInsight.create({
    data: {
      goalId: goal.id,
      weekKey,
      feedback,
      estimatedMonthlySaveableCents: capacity.estimatedMonthlySaveableCents,
    },
  });

  return { feedback, estimatedMonthlySaveableCents: capacity.estimatedMonthlySaveableCents };
}

// Weekly "go move money" push for goals with reminderEnabled — fires the
// next time a full-access member loads the dashboard after 7+ days have
// passed since the goal's last reminder (see page.tsx's call site), not at
// a fixed clock time: this app has no cron/worker process (see
// WORKING_ON.md). Same try-create/catch-unique-violation dedup as
// checkAndSendGoalAlerts above, just keyed by week instead of milestone so
// it repeats every week instead of firing once ever.
export async function checkAndSendGoalReminders(householdId: string): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const weekKey = currentWeekKey();
  const goals = await db.savingsGoal.findMany({ where: { householdId, reminderEnabled: true } });

  for (const goal of goals) {
    const savedCents = goalSavedCents(goal);
    if (goal.targetAmountCents > 0 && savedCents >= goal.targetAmountCents) continue;

    try {
      await db.goalReminder.create({ data: { goalId: goal.id, weekKey } });
    } catch {
      continue; // already sent this week
    }

    const remainingCents = goal.targetAmountCents - savedCents;
    // ~4 weeks/month. Prefer the household's own committed monthly target
    // (set in the "Set the Month" budget) over a target-date-derived pace.
    const monthlyPaceCents =
      goal.monthlyTargetCents > 0
        ? goal.monthlyTargetCents
        : monthlyContributionToHitTarget(remainingCents, goal.targetDate);
    const weeklySuggestionCents = monthlyPaceCents ? Math.ceil(monthlyPaceCents / 4) : null;

    await sendPushToHouseholdForType(householdId, "SAVINGS_WEEKLY_NUDGE", {
      title: `Weekly nudge: ${goal.name}`,
      body: weeklySuggestionCents
        ? `Move about ${formatCents(weeklySuggestionCents)} this week to stay on pace toward ${formatCents(goal.targetAmountCents)}.`
        : `${formatCents(remainingCents)} to go — move some money toward this goal when you can.`,
      url: `/savings/${goal.id}`,
    });
  }
}
