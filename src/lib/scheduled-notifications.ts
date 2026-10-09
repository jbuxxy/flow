import type { NotificationType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentPeriodKey, currentWeekBounds, currentWeekKey } from "@/lib/period";
import { getMonthReport, periodLabel, monthsAgoPeriodKey } from "@/lib/monthly-report";
import { getOrCreateCurrentReport, refreshReportFindings } from "@/lib/reports";
import { createOrRefreshBudgetPlan } from "@/lib/budget-plan";
import {
  getBucketsWithProgress,
  spendByBucketInRange,
  uncategorizedTransactionWhere,
  retireFundedOneTimeBuckets,
} from "@/lib/buckets";
import { unlabeledP2PWhere } from "@/lib/p2p-transfers";
import { getUnmatchedRefunds } from "@/lib/refund-match";
import { sendPushToHouseholdForType, sendPushToBucketForType } from "@/lib/push";
import { formatCents } from "@/lib/money";
import { whenSyncsIdle } from "@/lib/sync-in-flight";

// The only scheduling mechanism in this app — see src/instrumentation.ts,
// which calls this on a timer the same way it already polls SimpleFIN.
// Nothing here depends on any household member actually opening the app.
export async function runScheduledNotificationChecks(): Promise<void> {
  await checkMonthRolloverForAllHouseholds();
  await checkWeeklyBucketDigests();
  // The nudges read queues a sync is mid-way through filling (a refund
  // imported but not yet linked by its receipt) — wait for it to finish.
  await whenSyncsIdle();
  await checkNudgeAlerts();
}

async function checkMonthRolloverForAllHouseholds(): Promise<void> {
  const periodKey = currentPeriodKey();
  // The read-only example household is excluded from every background job —
  // its report/budget-plan/cycle-alert state is frozen on the seed pass.
  const households = await db.household.findMany({ where: { isDemo: false }, select: { id: true } });
  for (const h of households) {
    await checkMonthRolloverForHousehold(h.id, periodKey).catch((err) =>
      console.error(`[scheduled-notifications] month-rollover failed for household ${h.id}:`, err),
    );
    // Independent of checkMonthRolloverForHousehold's own once-per-month
    // dedup above (the cycleAlert claim returns early on every call after
    // the month's first) — refreshReportFindings has its own
    // settle-window/throttle gating meant to let it re-run repeatedly
    // through the first few days of a month as SimpleFIN data settles, but
    // it used to only ever be reached from inside that dedup-guarded call,
    // so in practice it never ran again after day one. Called unconditionally
    // here so that gating actually governs its cadence, as designed.
    await refreshReportFindings(h.id).catch((err) =>
      console.error(`[scheduled-notifications] report refresh failed for household ${h.id}:`, err),
    );
    await retireFundedOneTimeBuckets(h.id).catch((err) =>
      console.error(`[scheduled-notifications] one-time bucket retire failed for household ${h.id}:`, err),
    );
  }
}

async function checkMonthRolloverForHousehold(householdId: string, periodKey: string): Promise<void> {
  // skipDuplicates (ON CONFLICT DO NOTHING) instead of create-and-catch, so
  // the once-per-month dedup no longer logs a unique-violation ERROR in
  // Postgres on every scheduled run after the month's first.
  let claimed: number;
  try {
    ({ count: claimed } = await db.cycleAlert.createMany({ data: [{ householdId, periodKey }], skipDuplicates: true }));
  } catch (err) {
    console.error(`[scheduled-notifications] cycle-alert claim failed for household ${householdId}:`, err);
    return;
  }
  if (claimed === 0) return; // already handled this household's rollover into this month

  await sendPushToHouseholdForType(householdId, "NEW_CYCLE", {
    title: "New Budget Period Started",
    body: `${periodLabel(periodKey)} has begun.`,
    url: "/",
  });

  // The report always covers the most recently *completed* month, same as
  // /reports' own getMonthReport(householdId, monthsAgoPeriodKey(1)) call —
  // periodKey above is only the CycleAlert dedup key (today's in-progress
  // month), not what gets analyzed. Using periodKey directly here used to
  // generate/archive a report for the barely-started current month instead
  // of the just-completed one (real bug — caught while wiring in nightly
  // refresh below, since a settle-window check is meaningless against the
  // wrong period).
  const reportPeriodKey = monthsAgoPeriodKey(1);

  // Whatever MONTHLY report was still OPEN before this run is last month's
  // still-live report — getOrCreateCurrentReport below archives (finalizes)
  // it as a side effect of generating this month's new live report. Capture
  // it first so we know whether that archiving is actually about to happen,
  // since that's the event "your report is ready" is really about — not the
  // brand-new, barely-started current-month report.
  const staleOpen = await db.report.findFirst({
    where: { householdId, type: "MONTHLY", status: "OPEN", periodKey: { not: reportPeriodKey } },
  });

  const current = await getMonthReport(householdId, reportPeriodKey);
  if (current.buckets.length === 0) return; // no buckets yet — matches /reports' own guard
  const result = await getOrCreateCurrentReport(householdId, current);
  if (!result) return;

  // The forward "Set the Month" budget plan for the NEW month (periodKey here,
  // not reportPeriodKey). Rides on the OPEN report's findings.budgetPlan (just
  // refreshed above). Row existence is its own push dedup, like Report/NEW_REPORT.
  try {
    const { plan, created } = await createOrRefreshBudgetPlan(householdId, periodKey);
    if (plan && created) {
      await sendPushToHouseholdForType(householdId, "BUDGET_PLAN_READY", {
        title: "Your Budget Plan Is Ready",
        body: `Review and confirm your ${periodLabel(periodKey)} budget.`,
        url: "/budget",
      });
    }
  } catch (err) {
    console.error(`[scheduled-notifications] budget-plan failed for household ${householdId}:`, err);
  }

  if (!staleOpen) return;
  await sendPushToHouseholdForType(householdId, "NEW_REPORT", {
    title: "Your Monthly Report Is Ready",
    body: `${periodLabel(staleOpen.periodKey)}'s report is ready to view.`,
    url: "/reports/archive",
  });
}

async function checkWeeklyBucketDigests(): Promise<void> {
  const weekKey = currentWeekKey();
  const { start, end } = currentWeekBounds();

  const flagged = await db.bucket.findMany({
    where: { weeklyReportEnabled: true, household: { isDemo: false } },
    select: { id: true, householdId: true, name: true },
  });
  const householdIds = [...new Set(flagged.map((b) => b.householdId))];

  for (const householdId of householdIds) {
    try {
      await checkWeeklyBucketDigestsForHousehold(householdId, flagged, weekKey, start, end);
    } catch (err) {
      console.error(`[scheduled-notifications] weekly digest failed for household ${householdId}:`, err);
    }
  }
}

async function checkWeeklyBucketDigestsForHousehold(
  householdId: string,
  flagged: { id: string; householdId: string; name: string }[],
  weekKey: string,
  // Already UTC-anchored (currentWeekBounds, period.ts) — spendByBucketInRange
  // requires that shape directly now (see its own doc comment for the
  // 2026-09-12 bug this call site used to trigger via a double conversion).
  start: Date,
  end: Date,
): Promise<void> {
  const [progress, weekSpend] = await Promise.all([
    getBucketsWithProgress(householdId),
    spendByBucketInRange(householdId, start, end),
  ]);
  const progressById = new Map(progress.map((p) => [p.id, p]));

  for (const bucket of flagged.filter((b) => b.householdId === householdId)) {
    // skipDuplicates rather than create-and-catch: same once-per-week dedup
    // without a Postgres unique-violation ERROR for every repeat run.
    let claimed: number;
    try {
      ({ count: claimed } = await db.bucketDigest.createMany({ data: [{ bucketId: bucket.id, weekKey }], skipDuplicates: true }));
    } catch (err) {
      console.error(`[scheduled-notifications] digest claim failed for bucket ${bucket.id}:`, err);
      continue;
    }
    if (claimed === 0) continue; // already sent this week

    const p = progressById.get(bucket.id);
    if (!p) continue;

    const paceNote = p.onPaceToOvershoot ? "Spending faster than planned this month." : "On pace for the month.";
    await sendPushToBucketForType(bucket.id, householdId, "WEEKLY_BUCKET_REPORT", {
      title: `${bucket.name}: Weekly Update`,
      body:
        `${formatCents(weekSpend.get(bucket.id) ?? 0)} spent this week. ` +
        `${formatCents(Math.max(p.remainingCents, 0))} left this month. ${paceNote}`,
      url: `/buckets/${bucket.id}`,
    });
  }
}

// A push only fires once per household/kind until something newer than the
// last push's anchor shows up — see NudgeAlert's own comment for why this
// is deliberately separate from SuggestionDismissal (the dashboard card's
// per-user "I've seen this batch," not a push suppression).
async function sendNudgeIfNewer(
  householdId: string,
  type: NotificationType,
  anchor: Date,
  payload: { title: string; body: string; url: string },
): Promise<void> {
  const existing = await db.nudgeAlert.findUnique({ where: { householdId_kind: { householdId, kind: type } } });
  if (existing && existing.anchor >= anchor) return;
  await db.nudgeAlert.upsert({
    where: { householdId_kind: { householdId, kind: type } },
    create: { householdId, kind: type, anchor },
    update: { anchor },
  });
  await sendPushToHouseholdForType(householdId, type, payload);
}

async function checkNudgeAlerts(): Promise<void> {
  const households = await db.household.findMany({ where: { isDemo: false }, select: { id: true } });
  for (const h of households) {
    await checkNeedsBucketNudge(h.id).catch((err) =>
      console.error(`[scheduled-notifications] needs-bucket nudge failed for household ${h.id}:`, err),
    );
    await checkReceiptReviewNudge(h.id).catch((err) =>
      console.error(`[scheduled-notifications] receipt-review nudge failed for household ${h.id}:`, err),
    );
    await checkP2PLabelNudge(h.id).catch((err) =>
      console.error(`[scheduled-notifications] p2p-label nudge failed for household ${h.id}:`, err),
    );
    await checkRefundMatchReviewNudge(h.id).catch((err) =>
      console.error(`[scheduled-notifications] refund-match nudge failed for household ${h.id}:`, err),
    );
  }
}

// How long a transaction sits unresolved before this nudge will fire for it.
// A checking-side "Transfer to Loan" leg routinely syncs in with no bucket
// and no transfer link yet — matchDepositoryDebtPaymentLegs (simplefin-
// sync.ts) only pairs it once the loan account's own offsetting leg shows
// up, and a loan/mortgage servicer's own feed often lags the checking side
// by a sync or two. Nudging immediately catches that normal, self-resolving
// gap and sends a push for something that's already gone by the time the
// household opens the app (real report, 2026-09-07). Waiting this long
// gives the auto-match its usual window first, without silencing the nudge
// for something genuinely stuck needing a human.
const NEEDS_BUCKET_GRACE_HOURS = 6;

async function checkNeedsBucketNudge(householdId: string): Promise<void> {
  const where: Prisma.TransactionWhereInput = {
    ...uncategorizedTransactionWhere(householdId),
    createdAt: { lte: new Date(Date.now() - NEEDS_BUCKET_GRACE_HOURS * 60 * 60 * 1000) },
  };
  const [count, newest] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.findFirst({ where, orderBy: { occurredOn: "desc" }, select: { occurredOn: true, merchant: true } }),
  ]);
  if (count === 0 || !newest) return;
  await sendNudgeIfNewer(householdId, "NEEDS_BUCKET", newest.occurredOn, {
    title: count === 1 ? "1 Transaction Needs A Bucket" : `${count} Transactions Need A Bucket`,
    body:
      count === 1
        ? `${newest.merchant} needs a bucket so it counts toward this month's spending.`
        : `${count} transactions need a bucket, including ${newest.merchant}.`,
    url: "/buckets",
  });
}

async function checkReceiptReviewNudge(householdId: string): Promise<void> {
  const where = { householdId, transactionId: null, matchState: "AMBIGUOUS" as const, totalCents: { not: null } };
  const [count, newest] = await Promise.all([
    db.receipt.count({ where }),
    // receivedAt (always set) rather than occurredOn (nullable) — it's the
    // "when we saw it" anchor, and monotonic with when the receipt actually
    // entered this queue.
    db.receipt.findFirst({ where, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, party: true, p2pApp: true } }),
  ]);
  if (count === 0 || !newest) return;
  const who = newest.p2pApp ?? newest.party ?? "A receipt";
  await sendNudgeIfNewer(householdId, "RECEIPT_NEEDS_REVIEW", newest.receivedAt, {
    title: count === 1 ? "1 Receipt Needs Review" : `${count} Receipts Need Review`,
    body:
      count === 1
        ? `${who} matched more than one transaction — pick the right one.`
        : `${count} receipts matched more than one transaction, including one from ${who}.`,
    url: "/settings/email",
  });
}

async function checkP2PLabelNudge(householdId: string): Promise<void> {
  const where = unlabeledP2PWhere(householdId);
  const [count, newest] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.findFirst({ where, orderBy: { occurredOn: "desc" }, select: { occurredOn: true, merchant: true } }),
  ]);
  if (count === 0 || !newest) return;
  // Same "bucket/debt/recurring pattern, or a call on income vs.
  // reimbursement" phrasing as the dashboard's own combined unlabeled-P2P
  // card (src/app/page.tsx) — this queue spans both directions (a debit
  // needs a bucket/debt/pattern, a credit needs an income-vs-reimbursement
  // call), so the copy has to cover both rather than picking one.
  await sendNudgeIfNewer(householdId, "NEEDS_LABEL_P2P", newest.occurredOn, {
    title: count === 1 ? "1 P2P Transfer Needs A Label" : `${count} P2P Transfers Need A Label`,
    body:
      count === 1
        ? `${newest.merchant} needs a bucket, a debt payment, or a recurring pattern — or a call on income vs. reimbursement.`
        : `${count} P2P transfers need a bucket/debt/recurring pattern, or a call on income vs. reimbursement, including ${newest.merchant}.`,
    url: "/transactions?status=unlabeledP2P",
  });
}

async function checkRefundMatchReviewNudge(householdId: string): Promise<void> {
  const refunds = await getUnmatchedRefunds(householdId);
  if (refunds.length === 0) return;
  const newest = refunds[0]; // getUnmatchedRefunds orders newest-first
  await sendNudgeIfNewer(householdId, "NEEDS_REFUND_MATCH_REVIEW", newest.occurredOn, {
    title: refunds.length === 1 ? "1 Refund Needs Review" : `${refunds.length} Refunds Need Review`,
    body:
      refunds.length === 1
        ? `${newest.merchant} matched more than one past purchase — pick the right one.`
        : `${refunds.length} refunds matched more than one past purchase, including one from ${newest.merchant}.`,
    url: "/transactions?status=unmatchedRefund",
  });
}
