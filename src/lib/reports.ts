import { db } from "@/lib/db";
import { daysAgo, periodBounds, currentPeriodKey } from "@/lib/period";
import { detectMerchantBillSuggestions } from "@/lib/bill-detect";
import { nameSimilarity } from "@/lib/fuzzy-match";
import { getHouseholdSavingsCapacity, goalSavedCents } from "@/lib/savings";
import { computeAttackOrder, type DebtInput, type PayoffOrder } from "@/lib/debt-payoff";
import {
  generateMonthlyReportContent,
  generateStartupReportContent,
  type ReportFindings,
  type ReportTrendEntry,
  type HouseholdProfileInput,
  type MonthSummary,
  type ReportContent,
  type BudgetRedraftContext,
} from "@/lib/ai";
import { renderReportPdf } from "@/lib/report-pdf";
import { getMonthReport, type MonthReport } from "@/lib/monthly-report";
import { isDemoHousehold } from "@/lib/demo";
import { Prisma, type Report } from "@prisma/client";

export type { ReportFindings };

const STARTUP_PERIOD_KEY = "STARTUP";
// How many closed months' condensed findings ride along in each new report's
// prompt as trend context — enough for the AI to reason about a repeating
// pattern without the prompt growing unbounded as reports accumulate.
const TREND_WINDOW = 3;

async function loadHouseholdProfile(householdId: string): Promise<HouseholdProfileInput> {
  const household = await db.household.findUniqueOrThrow({
    where: { id: householdId },
    select: { goalPosture: true, adultsCount: true, kidsCount: true },
  });
  return household;
}

function condenseReportForTrend(report: Report): ReportTrendEntry {
  const findings = report.findings as unknown as ReportFindings;
  return {
    periodKey: report.periodKey,
    totalSpentCents: findings.totalSpentCents,
    totalCapCents: findings.totalCapCents,
    topOverspendBuckets: [...findings.overspendingBuckets]
      .sort((a, b) => b.overspendCents - a.overspendCents)
      .slice(0, 3),
  };
}

async function getRecentTrend(householdId: string): Promise<ReportTrendEntry[]> {
  const recent = await db.report.findMany({
    where: { householdId, type: "MONTHLY", status: "ARCHIVED" },
    orderBy: { periodKey: "desc" },
    take: TREND_WINDOW,
  });
  return recent.reverse().map(condenseReportForTrend);
}

// The household's own debts, pre-sorted by its real payoffOrder — same
// query shape as getPriorityDebtId (src/lib/debt-payments.ts), just
// returning the full ordered list instead of only the top id. Grounds
// generateMonthlyReportContent's postureSuggestion/bigSurplusOpportunity in
// the household's own configured attack order instead of letting the model
// re-derive or override it.
async function getDebtAttackOrderSummary(householdId: string): Promise<MonthSummary["debtAttackOrder"]> {
  const debts = await db.debt.findMany({
    where: { householdId, balanceCents: { gt: 0 }, includeInPayoffPlan: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, balanceCents: true, aprBasisPoints: true, minPaymentCents: true, debtType: true },
  });
  if (debts.length === 0) return [];

  const household = await db.household.findUniqueOrThrow({
    where: { id: householdId },
    select: { payoffOrder: true },
  });
  const order = computeAttackOrder(debts as DebtInput[], household.payoffOrder as PayoffOrder);
  const byId = new Map(debts.map((d) => [d.id, d]));
  return order
    .map((id) => byId.get(id))
    .filter((d): d is (typeof debts)[number] => Boolean(d))
    .map((d) => ({
      name: d.name,
      balanceCents: d.balanceCents,
      aprBasisPoints: d.aprBasisPoints,
      minPaymentCents: d.minPaymentCents,
    }));
}

// CHECKING/SAVINGS accounts with a household-entered APY (Account.apyBasisPoints
// — never populated by sync, see its schema comment) for the
// bigSurplusOpportunity APR-vs-APY comparison. Excludes hidden/excluded
// accounts, same filter getNetWorth's cashAccounts query uses.
async function getSavingsAccountsSummary(householdId: string): Promise<MonthSummary["savingsAccounts"]> {
  const accounts = await db.account.findMany({
    where: { householdId, accountType: "SAVINGS", excludedFromNetWorth: false, hiddenAt: null },
    select: { name: true, displayName: true, balanceCents: true, apyBasisPoints: true },
  });
  return accounts.map((a) => ({
    name: a.displayName ?? a.name,
    balanceCents: a.balanceCents,
    apyBasisPoints: a.apyBasisPoints,
  }));
}

// Active savings goals, nearest targetDate first (Postgres' native ASC
// ordering already puts NULLs last, matching the "no-deadline goals go
// last" tiebreak from the report's design) — grounds postureSuggestion
// (SAVINGS) and savingsGoalInsights in real goals.
async function getSavingsGoalsSummary(householdId: string): Promise<MonthSummary["savingsGoals"]> {
  const goals = await db.savingsGoal.findMany({
    where: { householdId },
    orderBy: { targetDate: "asc" },
    select: { name: true, targetAmountCents: true, currentAmountCents: true, baselineCents: true, targetDate: true },
  });
  return goals.map((g) => ({
    name: g.name,
    targetAmountCents: g.targetAmountCents,
    // Saved toward the goal, net of the linked account's starting balance.
    currentAmountCents: goalSavedCents(g),
    targetDate: g.targetDate ? g.targetDate.toISOString().slice(0, 10) : null,
  }));
}

// The AI's `detectedRecurring` is meant to be spend that looks recurring but
// ISN'T tracked yet — the model has no list of what the household already
// tracks, so it routinely re-flags a merchant that's already a RecurringBill,
// a tracked Debt (Klarna/Affirm), or a P2P RecurringPattern (household
// report, 2026-09-03: "those are already things I track as recurring"). Strip
// any entry whose merchant matches one of those, byte-for-byte or by the same
// containment tier bill-detect uses for merchant-text drift.
async function stripTrackedRecurring(
  householdId: string,
  detected: ReportFindings["detectedRecurring"],
): Promise<ReportFindings["detectedRecurring"]> {
  if (detected.length === 0) return detected;
  const [bills, debts, patterns] = await Promise.all([
    db.recurringBill.findMany({ where: { householdId }, select: { merchant: true, name: true } }),
    db.debt.findMany({ where: { householdId }, select: { name: true, account: { select: { displayName: true } } } }),
    db.recurringPattern.findMany({ where: { householdId, active: true }, select: { label: true } }),
  ]);
  const tracked = [
    ...bills.flatMap((b) => [b.merchant, b.name]),
    ...debts.flatMap((d) => [d.name, d.account?.displayName ?? null]),
    ...patterns.map((p) => p.label),
  ].filter((s): s is string => !!s);
  return detected.filter((r) => !tracked.some((t) => nameSimilarity(r.merchant, t) >= 0.8));
}

// Shared by both report creation (getOrCreateCurrentReport) and nightly
// regeneration (refreshReportFindings) — gathers every input
// generateMonthlyReportContent needs (profile, trend, debt figures,
// surplus, savings goals/accounts) and makes the AI call, without writing
// anything to the DB itself. Callers decide whether that's an insert or an
// update.
async function buildMonthlyReportContent(householdId: string, current: MonthReport): Promise<ReportContent | null> {
  // Lazy import — budget-plan.ts imports refreshReportFindings from this file,
  // so a static import would be a load-time cycle. Both sides only use the
  // other inside async fns, so a dynamic import here keeps it clean.
  const { assembleBudgetPlanInputs, toMonthSummaryBudgetInputs } = await import("@/lib/budget-plan");

  const [profile, trend, debtAgg, capacity, debtAttackOrder, savingsAccounts, savingsGoals, budgetPlanInputs] =
    await Promise.all([
      loadHouseholdProfile(householdId),
      getRecentTrend(householdId),
      db.debt.aggregate({
        where: { householdId, balanceCents: { gt: 0 } },
        _sum: { balanceCents: true, minPaymentCents: true },
      }),
      getHouseholdSavingsCapacity(householdId),
      getDebtAttackOrderSummary(householdId),
      getSavingsAccountsSummary(householdId),
      getSavingsGoalsSummary(householdId),
      // The forward budget plan is always for the NEW, in-progress month —
      // not `current`, which covers the just-completed month this report is about.
      assembleBudgetPlanInputs(householdId, currentPeriodKey()),
    ]);

  const content = await generateMonthlyReportContent(
    householdId,
    {
      label: current.label,
      totalSpentCents: current.totalSpentCents,
      totalCapCents: current.totalCapCents,
      totalIncomeCents: current.totalIncomeCents,
      recurringIncomeCents: current.recurringIncomeCents,
      buckets: current.buckets.map((b) => ({ name: b.name, capCents: b.capCents, spentCents: b.spentCents })),
      oneTimePurchases: current.oneTimePurchases,
      extraIncome: current.extraIncome,
      debt: {
        totalBalanceCents: debtAgg._sum.balanceCents ?? 0,
        totalMinimumsCents: debtAgg._sum.minPaymentCents ?? 0,
        committedExtraCents: capacity.committedDebtExtraCents,
        estimatedMonthlySaveableCents: capacity.estimatedMonthlySaveableCents,
      },
      surplus: {
        targetMonthlySaveableCents: capacity.estimatedMonthlySaveableCents,
        actualSurplusCents: current.totalIncomeCents - current.totalSpentCents,
      },
      savingsGoals,
      debtAttackOrder,
      savingsAccounts,
      budgetInputs: budgetPlanInputs ? toMonthSummaryBudgetInputs(budgetPlanInputs) : undefined,
    },
    profile,
    trend,
  );

  if (content) {
    content.findings.detectedRecurring = await stripTrackedRecurring(
      householdId,
      content.findings.detectedRecurring,
    );
    // Freeze this month's deterministic bucket breakdown into the report —
    // /reports renders from this, never a live re-query, so a past month's
    // report keeps showing that month's buckets and caps. refreshReportFindings
    // keeps it current only while the budget is unchanged (see below).
    content.findings.monthSnapshot = snapshotFromMonthReport(current);
  }
  return content;
}

// Everything generateBudgetPlanRedraft needs besides the instructions and the
// prior draft — the same profile/debt/savings context the monthly report's
// own budgetPlan block is drafted from (buildMonthlyReportContent above).
// Null when there's nothing to budget.
export async function buildBudgetRedraftContext(
  householdId: string,
  periodKey: string,
): Promise<BudgetRedraftContext | null> {
  const { assembleBudgetPlanInputs, toMonthSummaryBudgetInputs } = await import("@/lib/budget-plan");
  const [profile, debtAttackOrder, savingsAccounts, savingsGoals, inputs] = await Promise.all([
    loadHouseholdProfile(householdId),
    getDebtAttackOrderSummary(householdId),
    getSavingsAccountsSummary(householdId),
    getSavingsGoalsSummary(householdId),
    assembleBudgetPlanInputs(householdId, periodKey),
  ]);
  if (!inputs) return null;
  return { profile, budgetInputs: toMonthSummaryBudgetInputs(inputs), debtAttackOrder, savingsAccounts, savingsGoals };
}

function snapshotFromMonthReport(m: MonthReport): NonNullable<ReportFindings["monthSnapshot"]> {
  return {
    totalSpentCents: m.totalSpentCents,
    totalCapCents: m.totalCapCents,
    totalIncomeCents: m.totalIncomeCents,
    recurringIncomeCents: m.recurringIncomeCents,
    buckets: m.buckets.map((b) => ({ name: b.name, capCents: b.capCents, spentCents: b.spentCents })),
    oneTimePurchases: m.oneTimePurchases,
    extraIncome: m.extraIncome,
  };
}

// A live MonthReport re-read for a closed month, with that month's FROZEN
// caps put back (by bucket name) — the spend is historical and still right,
// but caps are whatever the household has set *now* (next month's confirmed
// budget). Lets the settle-window refresh keep folding in late-synced
// transactions after the household moves on to next month's budget, instead
// of freezing the whole report the moment any cap changes. A bucket the
// snapshot never had keeps its live cap only if it actually spent that month.
// One-time buckets are already out of `buckets` (MonthReport.oneTimePurchases),
// so an older snapshot that still lists one is simply not carried over.
function withFrozenCaps(
  current: MonthReport,
  frozen: NonNullable<ReportFindings["monthSnapshot"]>,
): MonthReport {
  const frozenCap = new Map(frozen.buckets.map((b) => [b.name, b.capCents]));
  const buckets = current.buckets
    .filter((b) => frozenCap.has(b.name) || b.spentCents > 0)
    .map((b) => {
      const capCents = frozenCap.get(b.name) ?? b.capCents;
      return {
        ...b,
        capCents,
        pct: capCents > 0 ? (b.spentCents / capCents) * 100 : 0,
        achieved: b.spentCents <= capCents,
      };
    });
  return {
    ...current,
    buckets,
    totalSpentCents: buckets.reduce((s, b) => s + b.spentCents, 0),
    totalCapCents: buckets.reduce((s, b) => s + b.capCents, 0),
  };
}

// How many days into the month AFTER the one a report covers it stays
// eligible for nightly regeneration — same SimpleFIN-lag rationale as
// SYNC_LAG_GRACE_DAYS (src/lib/debt-payments.ts): a report generated right
// at rollover can miss the tail end of its covered month's real
// transactions, since SimpleFIN lags real bank data by a few days and never
// surfaces still-pending ones.
const REPORT_SETTLE_GRACE_DAYS = 5;

function isWithinSettleWindow(periodKey: string, now = new Date()): boolean {
  const { end } = periodBounds(periodKey); // start of the month AFTER periodKey, local time
  const settleDeadline = new Date(end.getFullYear(), end.getMonth(), end.getDate() + REPORT_SETTLE_GRACE_DAYS);
  return now < settleDeadline;
}

// Only actually regenerates roughly once a day — this is called from the
// hourly checkMonthRolloverForHousehold job (scheduled-notifications.ts),
// there's no separate cron/interval for it (see instrumentation.ts's "no
// cron/worker process" precedent).
const REFRESH_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

// Keeps the current OPEN MONTHLY report "live" while its covered month's
// data can still be settling, instead of freezing findings/narrative the
// instant they're first written. Only ever updates the OPEN row in place —
// never touches an ARCHIVED report or its baked-in pdfBytes, so
// condenseReportForTrend/getRecentTrend above are unaffected. A no-op most
// hours (staleness + settle-window gated).
export async function refreshReportFindings(
  householdId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const report = await db.report.findFirst({ where: { householdId, type: "MONTHLY", status: "OPEN" } });
  if (!report) return;
  if (!isWithinSettleWindow(report.periodKey)) return;
  // `force` skips only the ~daily throttle (still settle-window gated) — used
  // by createOrRefreshBudgetPlan when the OPEN report predates the budgetPlan
  // findings block and needs a one-off regeneration to populate it.
  if (!opts.force && Date.now() - report.updatedAt.getTime() < REFRESH_MIN_INTERVAL_MS) return;

  const live = await getMonthReport(householdId, report.periodKey);
  if (live.buckets.length === 0) return;

  // Re-derive against the month's own frozen caps (withFrozenCaps) — the
  // live caps belong to whatever month the household has budgeted since.
  // This used to bail out entirely once the budget changed, which also froze
  // out late-synced spend and any change to how a month is totaled.
  const frozen = (report.findings as unknown as ReportFindings).monthSnapshot;
  const current = frozen ? withFrozenCaps(live, frozen) : live;

  const content = await buildMonthlyReportContent(householdId, current);
  if (!content) return;

  await db.report.update({
    where: { id: report.id },
    data: { findings: content.findings, narrative: content.narrative },
  });
}

export type StartupWindowSummary = {
  daysCovered: number;
  totalSpentCents: number;
  totalIncomeCents: number;
  merchantTotals: { merchant: string; amountCents: number; occurrences: number }[];
  detectedBills: { merchant: string; amountCents: number; cadence: string }[];
};

// Aggregates however much sync history exists (up to the same 90-day window
// a first SimpleFIN connect pulls, see syncHousehold) for the onboarding
// wizard's Startup Report — unlike getMonthReport, this isn't calendar-month
// bounded since a brand-new connection rarely lines up with a month start.
export async function getStartupWindowSummary(householdId: string): Promise<StartupWindowSummary> {
  const since = daysAgo(90);
  const [transactions, incomeAgg, billSuggestions] = await Promise.all([
    db.transaction.findMany({
      where: { householdId, isIncome: false, isTransfer: false, occurredOn: { gte: since } },
      select: { merchant: true, amountCents: true },
    }),
    db.transaction.aggregate({
      where: { householdId, isIncome: true, occurredOn: { gte: since } },
      _sum: { amountCents: true },
    }),
    detectMerchantBillSuggestions(householdId),
  ]);

  const byMerchant = new Map<string, { amountCents: number; occurrences: number }>();
  for (const t of transactions) {
    const cur = byMerchant.get(t.merchant) ?? { amountCents: 0, occurrences: 0 };
    cur.amountCents += t.amountCents;
    cur.occurrences += 1;
    byMerchant.set(t.merchant, cur);
  }
  // Capped so the prompt doesn't grow unbounded for a household with
  // hundreds of distinct merchants — the biggest spend is what matters for
  // starter-bucket sizing, not the long tail.
  const merchantTotals = [...byMerchant.entries()]
    .map(([merchant, v]) => ({ merchant, ...v }))
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 40);

  return {
    daysCovered: 90,
    totalSpentCents: transactions.reduce((s, t) => s + t.amountCents, 0),
    totalIncomeCents: Math.abs(incomeAgg._sum.amountCents ?? 0),
    merchantTotals,
    detectedBills: billSuggestions.map((b) => ({ merchant: b.merchant, amountCents: b.amountCents, cadence: b.cadence })),
  };
}

// Generates (or returns the existing) one-time onboarding Startup Report.
// Returns null if AI isn't configured — the wizard's buckets phase just
// renders an empty draft list in that case (STARTER_BUCKETS was removed
// entirely, see WORKING_ON.md's 2026-08-22 follow-up entry).
export async function getOrCreateStartupReport(householdId: string): Promise<Report | null> {
  const existing = await db.report.findUnique({
    where: { householdId_periodKey: { householdId, periodKey: STARTUP_PERIOD_KEY } },
  });
  if (existing) return existing;
  // Demo household renders only what the one-time seed baked; never regenerate.
  if (await isDemoHousehold(householdId)) return null;

  const [profile, summary] = await Promise.all([loadHouseholdProfile(householdId), getStartupWindowSummary(householdId)]);
  if (summary.merchantTotals.length === 0) return null; // nothing to analyze yet

  const content = await generateStartupReportContent(householdId, profile, summary);
  if (!content) return null;

  let created: Report;
  try {
    created = await db.report.create({
      data: {
        householdId,
        type: "STARTUP",
        periodKey: STARTUP_PERIOD_KEY,
        status: "ARCHIVED", // one-time — there's never a "next" startup report to supersede it
        archivedAt: new Date(),
        findings: content.findings,
        narrative: content.narrative,
      },
    });
  } catch (err) {
    // Two concurrent requests can both see `existing === null` and race to
    // create the same householdId+periodKey row (unique constraint) — the
    // loser returns whatever the winner created instead of throwing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return db.report.findUnique({
        where: { householdId_periodKey: { householdId, periodKey: STARTUP_PERIOD_KEY } },
      });
    }
    throw err;
  }

  // PDF'd immediately (unlike a MONTHLY report, which waits until it's
  // superseded) since a STARTUP report is already final the moment it's
  // created — there's no "current, still-changing" phase for it to wait out.
  const pdfBytes = await renderReportPdf(created);
  return db.report.update({ where: { id: created.id }, data: { pdfBytes: new Uint8Array(pdfBytes) } });
}

export type CurrentReportContent = { narrative: string; findings: ReportFindings };

// Generates a new MONTHLY report the first time it's asked for a given
// periodKey — either a household opening /reports, or (more commonly in
// practice) the hourly checkMonthRolloverForHousehold job
// (scheduled-notifications.ts), which discovers a new completed month
// proactively rather than waiting on a visit. That first call also
// finalizes (PDF-renders + archives) whatever MONTHLY report was still
// OPEN. Once created, the row stays OPEN and "live" — see
// refreshReportFindings above, which keeps its findings/narrative current
// while its covered month's data can still be settling — until it's
// superseded by the next month's report.
export async function getOrCreateCurrentReport(
  householdId: string,
  current: MonthReport,
): Promise<CurrentReportContent | null> {
  const existing = await db.report.findUnique({
    where: { householdId_periodKey: { householdId, periodKey: current.periodKey } },
  });
  if (existing) {
    // Re-filter on read too — a report generated before a bill/pattern was
    // tracked shouldn't keep re-surfacing it until the nightly refresh runs
    // (or forever, once the settle window closes). In-memory only, not persisted.
    const findings = existing.findings as unknown as ReportFindings;
    findings.detectedRecurring = await stripTrackedRecurring(householdId, findings.detectedRecurring ?? []);
    return { narrative: existing.narrative, findings };
  }
  // Demo household renders only what the one-time seed baked; never regenerate.
  if (await isDemoHousehold(householdId)) return null;

  const stale = await db.report.findFirst({ where: { householdId, type: "MONTHLY", status: "OPEN" } });
  if (stale) {
    const pdfBytes = await renderReportPdf(stale);
    await db.report.update({
      where: { id: stale.id },
      data: { status: "ARCHIVED", archivedAt: new Date(), pdfBytes: new Uint8Array(pdfBytes) },
    });
  }

  const content = await buildMonthlyReportContent(householdId, current);
  if (!content) return null;

  let created: Report;
  try {
    created = await db.report.create({
      data: {
        householdId,
        type: "MONTHLY",
        periodKey: current.periodKey,
        status: "OPEN",
        findings: content.findings,
        narrative: content.narrative,
      },
    });
  } catch (err) {
    // Two concurrent requests can both see `existing === null` and race to
    // create the same householdId+periodKey row (unique constraint) — the
    // loser returns whatever the winner created instead of throwing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.report.findUniqueOrThrow({
        where: { householdId_periodKey: { householdId, periodKey: current.periodKey } },
      });
      return { narrative: winner.narrative, findings: winner.findings as unknown as ReportFindings };
    }
    throw err;
  }
  return { narrative: created.narrative, findings: created.findings as unknown as ReportFindings };
}

export type ReportArchiveEntry = {
  id: string;
  type: "MONTHLY" | "STARTUP";
  periodKey: string;
  narrative: string;
  createdAt: Date;
};

// The Report Archive: every finalized (ARCHIVED, PDF-baked) report, newest
// first. The month currently in progress isn't here — it's the live report
// on /reports until the next month's report supersedes it (a month first
// lands in the archive ~2 months after it ends: e.g. January archives in
// March, once February's report is generated).
export async function listReportArchive(householdId: string): Promise<ReportArchiveEntry[]> {
  return db.report.findMany({
    where: { householdId, status: "ARCHIVED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, periodKey: true, narrative: true, createdAt: true },
  });
}
