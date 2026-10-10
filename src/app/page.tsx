import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { TrendingUp, TrendingDown, Minus, Gauge, Receipt, PiggyBank, Landmark, Star, BanknoteArrowUp, CircleSlash } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBucketsWithProgress, getActiveUncategorizedCount } from "@/lib/buckets";
import { STATUS_BAR_CLASS } from "@/lib/bucket-status";
import { getNetWorth, getActiveStaleAssets } from "@/lib/networth";
import { getNetWorthDailyHistory, netWorthWindow, recordNetWorthSnapshot } from "@/lib/networth-history";
import { getSavingsGoalsWithProgress, checkAndSendGoalReminders } from "@/lib/savings";
import { canViewNetWorth, hasFullAccess } from "@/lib/access";
import {
  getBillsThisWeek,
  getPatternsThisWeek,
  getUpcomingBillsSummary,
  getActiveBillsNeedingDueDate,
  isBillsThisWeekDismissed,
  principalTowardDebtCents,
  getPendingBillAmountReviews,
} from "@/lib/recurring-bills";
import { getPendingPatternPaymentReviews } from "@/lib/pattern-payments";
import {
  getPendingDebtAmountReviews,
  getPendingDebtBalanceReviews,
  getDebtPaymentsThisWeek,
  getDebtsPaidOffThisWeek,
  getPaymentCalendarThisCycle,
  detectDebtPaymentSuggestions,
  getActiveDebtsNeedingSetup,
  PENDING_REVIEW_SETUP_REASON,
  getActiveInsufficientMinimumDebts,
  isPaidOffThisWeekDismissed,
} from "@/lib/debt-payments";
import { ensureCalendarFeedToken, feedUrlForToken } from "@/lib/calendar-feed-url";
import { CalendarSubscribeButtons } from "@/components/calendar-subscribe-buttons";
import { CycleCalendarView } from "@/app/debts/cycle-calendar-view";
import { detectUnlinkedBnpl } from "@/lib/bnpl-detect";
import { detectMerchantBillSuggestions } from "@/lib/bill-detect";
import { detectRecurringIncome } from "@/lib/income-detect";
import { getRecentPaydays, isPaydayDismissed } from "@/lib/income";
import { getActiveUnlabeledP2PTransfers } from "@/lib/p2p-transfers";
import { getActiveUntrackedLiabilityAccounts } from "@/lib/untracked-liabilities";
import { needsBankConnectionAttention } from "@/lib/bank-connection";
import { getReceiptsAwaitingMatchCount, isReceiptMatchReviewDismissed } from "@/lib/receipt-sync";
import { getUnmatchedRefunds, isRefundMatchReviewDismissed } from "@/lib/refund-match";
import { needsAiAttention } from "@/lib/ai-provider";
import { getPendingBudgetPlan } from "@/lib/budget-plan";
import { periodLabel, monthsAgoPeriodKey } from "@/lib/monthly-report";
import { getSpendTrend, getSpendCeilingCents } from "@/lib/spend";
import { currentDateKey, currentPeriodKey, currentWeekBounds, daysAgo } from "@/lib/period";
import { formatCents } from "@/lib/money";
import { formatDate, todayAsUTCDate } from "@/lib/date";
import { AppShell } from "@/components/app-shell";
import { BucketGrid } from "@/components/bucket-grid";
import { SwipeCarousel } from "@/components/swipe-carousel";
import { StatStrip, type StatTile } from "@/components/stat-strip";
import { NetWorthMiniChart } from "@/components/net-worth-mini-chart";
import { UpcomingBillsCard } from "@/components/upcoming-bills-card";
import { PaidOffCard } from "@/components/paid-off-card";
import { PaydayCard } from "@/components/payday-card";
import { SavingsGoalsCard } from "@/components/savings-goals-card";
import { SpendingTrendCard } from "@/components/spending-trend-card";
import { DebtAmountReviewCard } from "@/components/debt-amount-review-card";
import { BillAmountReviewCard } from "@/components/bill-amount-review-card";
import { PatternPaymentReviewCard } from "@/components/pattern-payment-review-card";
import { DebtBalanceReviewCard } from "@/components/debt-balance-review-card";
import { AttentionLinkCard } from "@/components/attention-link-card";
import { NeedsSetupWarning } from "@/app/debts/needs-setup-warning";
import { MinPaymentWarning } from "@/app/debts/min-payment-warning";
import { BillsNeedDueDateWarning } from "@/app/bills/bills-need-due-date-warning";
import { CountWarning } from "@/components/count-warning";
import { SuggestionListWarning } from "@/components/suggestion-list-warning";
import { DashboardWarnings } from "@/components/dashboard-warnings";
import { SetTheMonthBanner } from "@/components/set-the-month-banner";
import { dismissBnplSuggestion } from "@/app/debts/actions";
import { dismissBillSuggestion } from "@/app/bills/actions";
import { markIncomeSuggestionOneOff } from "@/app/income/actions";
import {
  dismissUnlabeledP2PFromDashboard,
  dismissUncategorizedFromDashboard,
  dismissUntrackedLiabilityFromDashboard,
  dismissStaleAssetFromDashboard,
  dismissBillsThisWeekFromDashboard,
  dismissPaidOffThisWeekFromDashboard,
  dismissReceiptMatchReviewFromDashboard,
  dismissRefundMatchReviewFromDashboard,
  dismissPaydayFromDashboard,
} from "./actions";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    // The example household (Household.isDemo) isn't a real signup — an
    // unauthenticated visitor should still land on /register if it's the only
    // household that exists.
    const householdCount = await db.household.count({ where: { isDemo: false } });
    redirect(householdCount === 0 ? "/register" : "/login");
  }

  // Only the registering OWNER ever sees the setup wizard — an invited
  // member never triggers it, even if it somehow got left incomplete.
  if (session.user.role === "OWNER") {
    const household = await db.household.findUnique({
      where: { id: session.user.householdId },
      select: { onboardingCompletedAt: true },
    });
    if (household && !household.onboardingCompletedAt) redirect("/onboarding");
  }

  const canSeeNetWorth = canViewNetWorth(session.user);
  const canSeeFullFinancials = hasFullAccess(session.user);
  // Debts went fully read-only for non-owner full-access members 2026-08-21
  // — /debts itself, the payoff calendar, and "paid off this week" all stay
  // visible (informative, per that day's household decision), but anything
  // whose only action is a now-owner-only debt edit (confirming a minimum
  // changed, needs-setup/min-payment/BNPL/debt-payment-match suggestions)
  // is gated to isOwner below instead of canSeeFullFinancials, same as the
  // server actions themselves (requireOwner, src/lib/access.ts).
  const isOwner = session.user.role === "OWNER";
  // The dashboard's attention signals (see the destructure further down)
  // don't depend on anything the main batch below loads — started now so
  // the two batches load concurrently instead of one after the other.
  const attentionSignals = Promise.all([
    isOwner ? detectUnlinkedBnpl(session.user.householdId) : [],
    isOwner ? detectDebtPaymentSuggestions(session.user.householdId) : [],
    detectMerchantBillSuggestions(session.user.householdId),
    canSeeFullFinancials ? detectRecurringIncome(session.user.householdId) : [],
    isOwner ? getActiveUntrackedLiabilityAccounts(session.user.householdId) : [],
    // Minus the pending-minimum-change reason — the DebtAmountReviewCard
    // below already asks that exact question with yes/no buttons.
    isOwner
      ? getActiveDebtsNeedingSetup(session.user.householdId).then((debts) =>
          debts.filter((d) => d.reason !== PENDING_REVIEW_SETUP_REASON),
        )
      : [],
    isOwner ? getActiveInsufficientMinimumDebts(session.user.householdId) : [],
    canSeeFullFinancials ? needsBankConnectionAttention(session.user.householdId) : false,
    getActiveBillsNeedingDueDate(session.user.householdId),
    isOwner ? needsAiAttention(session.user.householdId) : false,
    getActiveUncategorizedCount(session.user.householdId),
    canSeeNetWorth ? getActiveStaleAssets(session.user.householdId) : [],
    canSeeFullFinancials ? getActiveUnlabeledP2PTransfers(session.user.householdId, "DEBIT") : [],
    canSeeFullFinancials ? getActiveUnlabeledP2PTransfers(session.user.householdId, "CREDIT") : [],
    canSeeFullFinancials ? getReceiptsAwaitingMatchCount(session.user.householdId) : 0,
    canSeeFullFinancials ? getUnmatchedRefunds(session.user.householdId) : [],
  ]);
  // Awaited below; this only keeps a failure while the main batch is still
  // loading from being reported as an unhandled rejection.
  attentionSignals.catch(() => {});
  const [
    buckets,
    netWorth,
    billsThisWeek,
    debtPaymentsThisWeek,
    billsLastWeek,
    debtPaymentsLastWeek,
    paidOffDebts,
    pendingDebtAmountReviews,
    pendingBillAmountReviews,
    pendingDebtBalanceReviews,
    pendingPatternPaymentReviews,
    paymentCalendar,
    savingsGoals,
    pendingBudgetPlan,
    recentPaydays,
    thisMonthSpendTrend,
    lastMonthSpendTrend,
    spendCeilingCents,
    patternsThisWeek,
    patternsLastWeek,
  ] = await Promise.all([
    getBucketsWithProgress(session.user.householdId),
    canSeeNetWorth ? getNetWorth(session.user.householdId) : null,
    canSeeFullFinancials ? getBillsThisWeek(session.user.householdId) : [],
    canSeeFullFinancials ? getDebtPaymentsThisWeek(session.user.householdId) : [],
    // Same calendar-week machinery, anchored 7 days back — feeds the
    // dashboard's retrospective "Last Week's Bills" card (household request,
    // 2026-09-06).
    canSeeFullFinancials ? getBillsThisWeek(session.user.householdId, daysAgo(7)) : [],
    canSeeFullFinancials ? getDebtPaymentsThisWeek(session.user.householdId, daysAgo(7)) : [],
    canSeeFullFinancials ? getDebtsPaidOffThisWeek(session.user.householdId) : [],
    isOwner ? getPendingDebtAmountReviews(session.user.householdId) : [],
    // hasFullAccess, not isOwner — /bills (where these are also resolvable)
    // is a full-access page, same reasoning as the pattern-payment reviews
    // just below.
    canSeeFullFinancials ? getPendingBillAmountReviews(session.user.householdId) : [],
    isOwner ? getPendingDebtBalanceReviews(session.user.householdId) : [],
    // hasFullAccess, not isOwner — a RecurringPattern is a shared,
    // full-access-managed object (see requireFullAccess on transactions/
    // actions.ts's pattern actions), not owner-only like a debt tracker.
    canSeeFullFinancials ? getPendingPatternPaymentReviews(session.user.householdId) : [],
    canSeeFullFinancials ? getPaymentCalendarThisCycle(session.user.householdId) : null,
    canSeeFullFinancials ? getSavingsGoalsWithProgress(session.user.householdId) : [],
    isOwner ? getPendingBudgetPlan(session.user.householdId) : null,
    canSeeFullFinancials ? getRecentPaydays(session.user.householdId) : [],
    canSeeFullFinancials ? getSpendTrend(session.user.householdId, currentPeriodKey()) : null,
    canSeeFullFinancials ? getSpendTrend(session.user.householdId, monthsAgoPeriodKey(1)) : null,
    canSeeFullFinancials ? getSpendCeilingCents(session.user.householdId) : 0,
    canSeeFullFinancials ? getPatternsThisWeek(session.user.householdId) : [],
    canSeeFullFinancials ? getPatternsThisWeek(session.user.householdId, daysAgo(7)) : [],
  ]);

  // The household's ICS feed URL for the Payment Calendar's "Add to Google /
  // Apple Calendar" buttons — owner-only (a non-owner never gets a feed
  // token generated, same bar as /settings/calendar-sync), and only when the
  // card itself renders. Lazily creates the token on first use.
  const calendarFeedUrl =
    isOwner && canSeeFullFinancials && paymentCalendar
      ? feedUrlForToken(await ensureCalendarFeedToken(session.user.householdId))
      : null;

  // Read-only — the daily snapshot row itself is written by /networth (see
  // recordNetWorthSnapshot), so this can come up empty (null) until that
  // page has been visited at least once, same as the trend line there.
  // Daily, not monthly (see getNetWorthDailyHistory's own comment) — the
  // full interactive chart with month-by-month/year-picker history lives on
  // /networth; this is just a glance. Two trailing windows (2026-09-29): the
  // stat tile shows the past 7 days, the carousel card the past 30 — rolling,
  // not month-to-date, so neither goes near-empty on the 1st, and each one's
  // caption delta is measured over exactly the span its line draws (see
  // netWorthWindow). 40 rows comfortably covers 30 days with today's row.
  // Snapshots used to be written only by /networth, so a week of not opening
  // that page left days missing and flattened these lines. Same getNetWorth
  // figure and same per-day upsert, so recording it here too just fills gaps.
  const netWorthDaily = netWorth
    ? await recordNetWorthSnapshot(session.user.householdId, netWorth.netWorthCents).then(() =>
        getNetWorthDailyHistory(session.user.householdId, 40),
      )
    : [];
  const netWorthTodayKey = currentDateKey();
  const netWorthWeek = netWorth
    ? netWorthWindow(netWorthDaily, currentDateKey(daysAgo(7)), netWorthTodayKey, netWorth.netWorthCents)
    : null;
  const netWorthMonth = netWorth
    ? netWorthWindow(netWorthDaily, currentDateKey(daysAgo(30)), netWorthTodayKey, netWorth.netWorthCents)
    : null;
  // "Past 7 Days" when the window really starts that far back, otherwise the
  // true first date (a gap in snapshots, or a household only days old).
  const windowLabel = (w: { startKey: string }, days: number) =>
    w.startKey === currentDateKey(daysAgo(days))
      ? `Past ${days} Days`
      : `Since ${formatDate(new Date(w.startKey), { month: "short", day: "numeric" })}`;

  // Weekly reminderEnabled push nudges — checked here (not a real schedule,
  // this app has no cron/worker process) so they fire the next time a
  // full-access member loads the dashboard after 7+ days have passed. See
  // checkAndSendGoalReminders, src/lib/savings.ts.
  // after(): the pushes go out once the page has been sent, not ahead of it.
  if (canSeeFullFinancials) after(() => checkAndSendGoalReminders(session.user.householdId));

  // The dashboard's "go do something" triage list (see AttentionLinkCard
  // below) — every signal already exists as a detector/boolean used
  // elsewhere in the app (BNPL/bill/debt-payment/income suggestion lists,
  // untracked liability accounts, and the same needs-attention booleans
  // that already feed the profile nav badge in app-shell.tsx). Kept as its
  // own Promise.all, separate from the one above, since these 9 signals are
  // gated four different ways (hasFullAccess, ungated, OWNER-only for
  // net-worth-adjacent, OWNER-only for debt-editing dead ends) and mixing
  // that into the already-dense array above would be harder to read.
  const [
    bnplSuggestions,
    debtPaymentSuggestions,
    billSuggestions,
    incomeSuggestions,
    untrackedLiabilities,
    debtsNeedingSetup,
    insufficientMinimumDebts,
    bankNeedsAttention,
    billsNeedingDueDate,
    aiNeedsAttention,
    uncategorizedCount,
    staleAssets,
    unlabeledP2PDebits,
    unlabeledP2PCredits,
    receiptsAwaitingMatch,
    unmatchedRefunds,
  ] = await attentionSignals;
  const unlabeledP2PCount = unlabeledP2PDebits.length + unlabeledP2PCredits.length;
  const hasAnyAttention =
    bnplSuggestions.length > 0 ||
    debtPaymentSuggestions.length > 0 ||
    billSuggestions.length > 0 ||
    incomeSuggestions.length > 0 ||
    untrackedLiabilities.length > 0 ||
    debtsNeedingSetup.length > 0 ||
    insufficientMinimumDebts.length > 0 ||
    bankNeedsAttention ||
    billsNeedingDueDate.length > 0 ||
    aiNeedsAttention ||
    uncategorizedCount > 0 ||
    staleAssets.length > 0 ||
    unlabeledP2PCount > 0 ||
    receiptsAwaitingMatch > 0;

  // Bills, scheduled P2P patterns, and debt payments (each debt's minimum +
  // any payoff-plan extra folded into one row — see getDebtPaymentsThisWeek)
  // are separate sources
  // under the hood but read as one "what's due this week" list here — sorted
  // together by due date, not concatenated as blocks.
  const dueThisWeek = [...billsThisWeek, ...patternsThisWeek, ...debtPaymentsThisWeek].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
  );
  // Retrospective-only — no AI summary, no payoff-plan extra overlay (see
  // getDebtPaymentsThisWeek's own comment), never dismissed (nothing to
  // act on, it's history).
  const dueLastWeek = [...billsLastWeek, ...patternsLastWeek, ...debtPaymentsLastWeek].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
  );
  // "9/6–9/12" under each card's title — same Sun–Sat window
  // getBillsThisWeek/getDebtPaymentsThisWeek computed the rows from (see
  // currentWeekBounds), so this always matches what's actually listed
  // instead of drifting if that logic ever changes. `end` is exclusive, so
  // the displayed range's own end is a day back from it.
  const shortDate = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const weekRangeLabel = (weekOf?: Date) => {
    const { start, end } = currentWeekBounds(weekOf);
    return `${shortDate(start)}–${shortDate(new Date(end.getTime() - 86_400_000))}`;
  };
  const thisWeekRangeLabel = weekRangeLabel();
  const lastWeekRangeLabel = weekRangeLabel(daysAgo(7));
  // Matches UpcomingBillsCard's own footer total (same helper).
  const extraToDebtThisWeekCents = dueThisWeek.reduce((sum, b) => sum + principalTowardDebtCents(b), 0);
  // A skipped bill counts as settled here too — nothing's actually owed
  // either way, so a week with one shouldn't be permanently stuck unable to
  // dismiss (household request, 2026-09-14).
  const allPaidThisWeek = dueThisWeek.length > 0 && dueThisWeek.every((b) => b.paid || b.skipped);
  // Independent reads — one round trip instead of five in a row.
  const [
    billsSummary,
    billsThisWeekDismissed,
    paidOffDismissed,
    receiptMatchDismissed,
    refundMatchDismissed,
    paydayDismissed,
  ] = await Promise.all([
    canSeeFullFinancials ? getUpcomingBillsSummary(session.user.householdId, dueThisWeek) : null,
    canSeeFullFinancials && allPaidThisWeek && isBillsThisWeekDismissed(session.user.householdId),
    canSeeFullFinancials &&
      paidOffDebts.length > 0 &&
      isPaidOffThisWeekDismissed(
        session.user.householdId,
        paidOffDebts.map((d) => d.id),
      ),
    canSeeFullFinancials && receiptsAwaitingMatch > 0 && isReceiptMatchReviewDismissed(session.user.householdId),
    canSeeFullFinancials && unmatchedRefunds.length > 0 && isRefundMatchReviewDismissed(session.user.householdId),
    recentPaydays.length > 0 &&
      isPaydayDismissed(
        session.user.householdId,
        recentPaydays.map((p) => p.key),
      ),
  ]);

  // The "at a glance" row up top — each tile only ever pushed for data the
  // viewer is actually allowed to see, so a limited (non-full-access,
  // non-owner) member just gets the one tile buckets are ungated for
  // instead of a broken/empty row. Buckets is the one exception that always
  // renders even with zero data (an empty state, not a missing tile) — no
  // buckets set up is itself a big deal worth surfacing. Savings/due/net
  // worth stay omitted when there's nothing to show. See StatStrip's own
  // comment for how it adapts its column count to whatever survives this.
  const statTiles: StatTile[] = [];
  if (buckets.length > 0) {
    // Same "over pace" definition as the Buckets page's allocation card
    // (onPaceToOvershoot — spend so far vs. a pace-adjusted projection of
    // the cap) rather than the blunter "already spent 80%+ of the cap"
    // bucketStatus threshold — the two used to disagree (e.g. 1/9 here vs.
    // 4/9 there) since bucketStatus doesn't account for how far into the
    // month it is, so it under-flags early and over-flags late.
    // Monthly pace only means something for a monthly bucket — a one-time
    // bucket (a down payment saved toward over months) is left out of both
    // the count and the denominator.
    const paceBuckets = buckets.filter((b) => !b.excludedFromAllocation);
    const attentionCount = paceBuckets.filter((b) => b.onPaceToOvershoot).length;
    statTiles.push({
      key: "buckets",
      label: attentionCount === 1 ? "Bucket Over Pace" : "Buckets Over Pace",
      value: `${attentionCount}/${paceBuckets.length}`,
      icon: Gauge,
      accent: attentionCount > 0 ? "amber" : "emerald",
      href: "/buckets",
      segments: paceBuckets.map((b) => (b.onPaceToOvershoot ? STATUS_BAR_CLASS.warning : STATUS_BAR_CLASS.ok)),
    });
  } else {
    statTiles.push({
      key: "buckets",
      label: "No Buckets Yet",
      value: "—",
      caption: "Add a Bucket →",
      icon: Gauge,
      accent: "neutral",
      href: "/buckets",
    });
  }
  if (canSeeFullFinancials) {
    const unpaid = dueThisWeek.filter((b) => !b.paid);
    const paidThisWeekCents = dueThisWeek.reduce((sum, b) => sum + b.paidCents, 0);
    const stillDueCents = unpaid.reduce((sum, b) => sum + b.expectedCents, 0);
    const weekTotalCents = paidThisWeekCents + stillDueCents;
    statTiles.push({
      key: "due",
      // "8 of 10" once anything's paid — the caption's "Paid So Far" covers
      // every row on the card, including one paid this week for an
      // occurrence due last week (see occurrenceSettledAfterWeek), so a bare
      // unpaid count read as if that money belonged to fewer bills than the
      // card lists (household report, 2026-09-29).
      label:
        unpaid.length < dueThisWeek.length && unpaid.length > 0
          ? `${unpaid.length} of ${dueThisWeek.length} Due This Week`
          : unpaid.length === 1
            ? "Due This Week"
            : `${unpaid.length} Due This Week`,
      value: formatCents(stillDueCents),
      caption: unpaid.length === 0 ? "All Paid" : `${formatCents(paidThisWeekCents)} Paid So Far`,
      icon: Receipt,
      accent: unpaid.length > 0 ? "neutral" : "emerald",
      progressPct: weekTotalCents > 0 ? (paidThisWeekCents / weekTotalCents) * 100 : 100,
    });
  }
  if (canSeeFullFinancials && extraToDebtThisWeekCents > 0) {
    statTiles.push({
      key: "extra-debt",
      label: "Extra To Principal This Week",
      value: formatCents(extraToDebtThisWeekCents),
      icon: Star,
      accent: "emerald",
    });
  }
  if (canSeeFullFinancials && savingsGoals.length > 0) {
    const totalCurrent = savingsGoals.reduce((sum, g) => sum + g.currentAmountCents, 0);
    const totalTarget = savingsGoals.reduce((sum, g) => sum + g.targetAmountCents, 0);
    statTiles.push({
      key: "savings",
      label: "Savings Goals",
      value: totalTarget > 0 ? `${Math.round((totalCurrent / totalTarget) * 100)}%` : formatCents(totalCurrent),
      caption: `${formatCents(totalCurrent)} Saved`,
      icon: PiggyBank,
      accent: "emerald",
      href: "/savings",
      progressPct: totalTarget > 0 ? (totalCurrent / totalTarget) * 100 : undefined,
    });
  }
  if (netWorth) {
    // Past 7 days — deliberately a different span from the carousel's
    // 30-day Net Worth card below, so the two aren't the same chart twice
    // (household feedback, 2026-09-29). Line tinted by direction.
    const w = netWorthWeek;
    const shortKey = (key: string) => formatDate(new Date(key), { month: "short", day: "numeric" });
    statTiles.push({
      key: "networth",
      label: "Net Worth",
      value: formatCents(netWorth.netWorthCents),
      caption:
        w && w.deltaCents !== 0
          ? `${w.deltaCents > 0 ? "+" : ""}${formatCents(w.deltaCents)} ${windowLabel(w, 7)}`
          : undefined,
      icon: Landmark,
      accent: netWorth.netWorthCents < 0 ? "red" : "neutral",
      href: "/networth",
      spark: w ? w.points.map((p) => p.netWorthCents) : undefined,
      sparkRange: w ? { start: shortKey(w.startKey), end: "Today" } : undefined,
      sparkAccent: w ? (w.deltaCents > 0 ? "emerald" : w.deltaCents < 0 ? "red" : undefined) : undefined,
    });
  }

  // Server runs TZ=America/Denver (the household's zone), so the local hour
  // here is the household's wall clock — fine for a morning/afternoon/evening
  // greeting. The date line uses todayAsUTCDate so it names the local
  // calendar day even when a bare `new Date()` has already rolled over in UTC.
  const localHour = new Date().getHours();
  const greeting = localHour < 12 ? "Good Morning" : localHour < 18 ? "Good Afternoon" : "Good Evening";

  // Same household-clock "what day is it" convention as greeting/localHour
  // above — the Spending card's "this month" line draws only through today
  // (see SpendingTrendCard's own comment for why), clamped in case of any
  // month-length edge case.
  const dayOfMonth = new Date().getDate();
  const daysElapsedThisMonth = thisMonthSpendTrend
    ? Math.min(dayOfMonth, thisMonthSpendTrend.recurringCumulativeCentsByDay.length)
    : 0;
  // The combined series SpendingTrendCard draws for last month's comparison
  // line — recurringCumulativeCentsByDay[i] + oneTimeCumulativeCentsByDay[i]
  // is always this by construction (dailySpendTrendFromTxns, spend.ts), so
  // it's derived here rather than carried as its own redundant field on
  // DailySpendTrend (real finding, 2026-09-22 code review).
  const lastMonthCumulativeCents = lastMonthSpendTrend
    ? lastMonthSpendTrend.recurringCumulativeCentsByDay.map((v, i) => v + lastMonthSpendTrend.oneTimeCumulativeCentsByDay[i])
    : [];

  return (
    <AppShell title="flow" user={session.user} width="wide">
      {/* Same viewport-edge breakout as AppShell's pageTitle row (this page
          passes title="flow" so that mechanism doesn't fire, and renders its
          own greeting instead) — hugs the sidebar on the left and reaches
          the true right edge at `lg:`+, independent of `main`'s own centered
          `mx-auto` column that the rest of the dashboard content stays in.
          The added rem term only needs to be HALF the sidebar's width
          (`lg:pl-64`/`xl:pl-72` on AppShell's wrapper), not the full width —
          `calc(50% - 50vw)` alone already lands the breakout halfway to the
          sidebar (percentage margins resolve against `main`'s own centered
          width, which only cancels half of `main`'s sidebar-driven offset).
          Using the full sidebar width here (as this used to) overshoots by
          another half-sidebar-width, landing back at roughly `main`'s own
          centered edge instead of the sidebar — visually indistinguishable
          from not breaking out at all (real bug, 2026-09-23: the greeting
          rendered flush with the stat tiles below it instead of hugging the
          sidebar like every other page's title row was supposed to). */}
      <div className="mx-[calc(50%-50vw)] px-4 lg:mx-[calc(50%-50vw+8rem)] lg:px-8 xl:mx-[calc(50%-50vw+9rem)]">
        <h1 className="text-2xl font-bold text-blue-900 dark:text-blue-300 lg:text-3xl">
          {greeting}, <span className="text-emerald-700 dark:text-emerald-400">{(session.user.name ?? "there").split(" ")[0]}</span>
        </h1>
        <p className="mt-0.5 text-sm text-gray-500 dark:text-neutral-400">
          {formatDate(todayAsUTCDate(), { weekday: "long", month: "long", day: "numeric" })}
        </p>
      </div>

      <StatStrip tiles={statTiles} />

      {/* Primary "new month" CTA — full content width, above the capped alert
          stack (it's a headline action, not a warning). */}
      {/* Owner-only — setting the month's budget is "full financials" (see
          budget/actions.ts requireOwner). A non-owner full-access member can
          still open /budget to view the plan, just not from a "set it" CTA. */}
      {isOwner && pendingBudgetPlan && (
        <SetTheMonthBanner
          month={periodLabel(pendingBudgetPlan.periodKey)}
          periodKey={pendingBudgetPlan.periodKey}
        />
      )}

      {/* Alert / status stack — full width of the mobile column (where each
          carousel is still one-at-a-time; no `max-w`/`mx-auto` here at all
          below `lg`, same as before this section had a desktop grid — a
          `mx-auto` + `max-w` pair on a flex-column child cancels the
          default cross-axis stretch and sizes it to max-content instead,
          which overflowed every mobile card horizontally, 2026-09-22 bug).
          At `lg:`+ each carousel below switches to its own grid
          (SwipeCarousel's `desktopGrid`) and needs the same full width as
          the content grid below to actually lay out 3-4 columns instead of
          being squeezed into 2. `empty:hidden` so it doesn't reserve a
          gap-6 gutter when every child renders null (the common "nothing
          needs you" case). `contents` (2026-09-29): its carousels now sit
          directly in main's own gap-6 column, so when they render only
          out-of-flow empty shells (every card dismissed client-side — see
          SwipeCarousel's allEmpty) there's no zero-height wrapper left over
          to claim a gutter of its own. */}
      <div className="contents">
      <DashboardWarnings hasServerAttention={hasAnyAttention}>
        {
          // Ordered by importance, most urgent first: a warning that's
          // actually costing the household money (red), then broken
          // infrastructure that other features depend on (bank sync, AI,
          // debt setup), then administrative gaps, then "here's something we
          // noticed" nudges, then transaction-hygiene housekeeping, then a
          // low-stakes item (a stale net worth estimate), then push
          // notifications (client-only signal, appended inside
          // DashboardWarnings itself, not here).
        }
          {insufficientMinimumDebts.length > 0 && (
            <MinPaymentWarning key="min-payment" debts={insufficientMinimumDebts} />
          )}
          {bankNeedsAttention && (
            <AttentionLinkCard
              key="bank-sync"
              href="/settings/accounts"
              title="Account Sync Needs Attention"
              subtitle="Connection missing or reporting an error"
              storageKey="bank-sync-attention"
            />
          )}
          {aiNeedsAttention && (
            <AttentionLinkCard
              key="ai-attention"
              href="/settings/ai"
              title="AI Features Need Setup"
              subtitle="No provider configured, or the last one errored"
              storageKey="ai-attention"
            />
          )}
          {debtsNeedingSetup.length > 0 && <NeedsSetupWarning key="needs-setup" debts={debtsNeedingSetup} />}
          {billsNeedingDueDate.length > 0 && <BillsNeedDueDateWarning key="bills-due" bills={billsNeedingDueDate} />}
          {untrackedLiabilities.length > 0 && (
            <SuggestionListWarning
              key="untracked-liabilities"
              items={untrackedLiabilities.map((item) => ({
                key: item.id,
                label: item.name,
                dismiss: dismissUntrackedLiabilityFromDashboard.bind(null, item.id),
              }))}
              title="Untracked Liability Accounts"
              subtitle="Synced, but no debt is tracked for these yet."
              href="/settings/accounts"
              linkLabel="Review in Account Settings →"
              storageKey="untracked-liabilities"
            />
          )}
          {debtPaymentSuggestions.length > 0 && (
            <SuggestionListWarning
              key="debt-payment-suggestions"
              items={debtPaymentSuggestions.map((item) => ({
                key: item.key,
                label: item.merchant,
                dismiss: dismissBillSuggestion.bind(null, item.key),
              }))}
              title="New Debt Payment Matches"
              subtitle="These synced payments match a tracked debt."
              href="/debts"
              linkLabel="Review in Debts →"
              storageKey="debt-payment-suggestions"
            />
          )}
          {billSuggestions.length > 0 && (
            <SuggestionListWarning
              key="bill-suggestions"
              items={billSuggestions.map((item) => ({
                key: item.key,
                label: item.merchant,
                dismiss: dismissBillSuggestion.bind(null, item.key),
              }))}
              title="New Recurring Transaction Suggestions"
              subtitle="These merchants look like a recurring bill."
              href="/buckets"
              linkLabel="Review in Buckets →"
              storageKey="bill-suggestions"
            />
          )}
          {bnplSuggestions.length > 0 && (
            <SuggestionListWarning
              key="bnpl-suggestions"
              items={bnplSuggestions.map((item) => ({
                key: item.key,
                label: item.label,
                dismiss: dismissBnplSuggestion.bind(null, item.key),
              }))}
              title="Untracked BNPL Payments"
              subtitle="These look like Pay-in-4 plans — not tracked as debt yet."
              href="/buckets"
              linkLabel="Review in Buckets →"
              storageKey="bnpl-suggestions"
            />
          )}
          {incomeSuggestions.length > 0 && (
            <SuggestionListWarning
              key="income-suggestions"
              items={incomeSuggestions.map((item) => ({
                key: item.key,
                label: item.merchant,
                dismiss: markIncomeSuggestionOneOff.bind(null, item.key, item.transactionIds),
              }))}
              title="New Income Detected"
              subtitle="These look like recurring deposits."
              href="/income"
              linkLabel="Review in Income →"
              storageKey="income-suggestions"
            />
          )}
          {receiptsAwaitingMatch > 0 && !receiptMatchDismissed && (
            <CountWarning
              key="receipt-match-review"
              count={receiptsAwaitingMatch}
              title="Receipt Matching"
              subtitle={`${receiptsAwaitingMatch} email receipt${receiptsAwaitingMatch === 1 ? "" : "s"} match more than one transaction — pick the right one`}
              href="/settings/email"
              linkLabel="Review Matches →"
              storageKey="receipt-match-review"
              dismiss={dismissReceiptMatchReviewFromDashboard}
            />
          )}
          {unmatchedRefunds.length > 0 && !refundMatchDismissed && (
            <CountWarning
              key="refund-match-review"
              count={unmatchedRefunds.length}
              title="Refund Matching"
              subtitle={`${unmatchedRefunds.length} refund${unmatchedRefunds.length === 1 ? "" : "s"} match${unmatchedRefunds.length === 1 ? "es" : ""} more than one past purchase — pick the right one`}
              href="/transactions?status=unmatchedRefund"
              linkLabel="Review Refunds →"
              storageKey="refund-match-review"
              dismiss={dismissRefundMatchReviewFromDashboard}
            />
          )}
          {unlabeledP2PCount > 0 && (
            <CountWarning
              key="unlabeled-p2p"
              count={unlabeledP2PCount}
              title="Needs P2P Review"
              subtitle={`${unlabeledP2PCount} transaction${unlabeledP2PCount === 1 ? "" : "s"} need${unlabeledP2PCount === 1 ? "s" : ""} a bucket/debt/recurring pattern, or a call on income vs. reimbursement`}
              href="/transactions?status=unlabeledP2P"
              linkLabel="Review Transactions →"
              storageKey="unlabeled-p2p-combined"
              dismiss={dismissUnlabeledP2PFromDashboard}
            />
          )}
          {uncategorizedCount > 0 && (
            <CountWarning
              key="uncategorized"
              count={uncategorizedCount}
              title="Uncategorized Transactions"
              subtitle={`${uncategorizedCount} transaction${uncategorizedCount === 1 ? "" : "s"} from the last month ${uncategorizedCount === 1 ? "needs" : "need"} a bucket`}
              href="/buckets"
              linkLabel="Review Transactions →"
              storageKey="uncategorized-transactions"
              dismiss={dismissUncategorizedFromDashboard}
            />
          )}
          {staleAssets.length > 0 && (
            <SuggestionListWarning
              key="stale-assets"
              items={staleAssets.map((item) => ({
                key: item.id,
                label: item.name,
                dismiss: dismissStaleAssetFromDashboard.bind(null, item.id),
              }))}
              title="Asset Values Need a Check"
              subtitle="Not updated or confirmed in 3+ months."
              href="/networth"
              linkLabel="Review in Net Worth →"
              storageKey="stale-assets"
            />
          )}
      </DashboardWarnings>

      {/* Swipeable, one-at-a-time carousel — the four review cards used to
          stack as separate full-width "Needs a Quick Confirm" boxes
          (household feedback, 2026-09-22: looked redundant/cluttered with
          more than one visible at once). Payday/Paid-Off joined the same
          grid 2026-09-23 (household feedback: they used to render as their
          own full-width blocks below this carousel instead of sitting in a
          section with the rest of these small alert-style cards) and lead
          it — good news the household wants to see first, ahead of the
          "needs a decision" review cards, same day's follow-up feedback.
          Same SwipeCarousel mechanics as DashboardWarnings above; a card
          with nothing pending renders null and drops out of rotation — and
          out of the desktop grid — on its own (see SwipeCarousel's
          empty-slide handling; SwipeCarousel itself already no-ops to null
          when every child is absent, so no outer length check is needed
          here). */}
      <SwipeCarousel desktopGrid>
        {canSeeFullFinancials && !paydayDismissed && (
          <PaydayCard
            key="payday"
            paydays={recentPaydays.map((p) => ({ ...p, receivedDate: p.receivedDate.toISOString().slice(0, 10) }))}
            onDismiss={dismissPaydayFromDashboard.bind(
              null,
              recentPaydays.map((p) => p.key),
            )}
          />
        )}
        {canSeeFullFinancials && !paidOffDismissed && (
          <PaidOffCard
            key="paid-off"
            debts={paidOffDebts}
            onDismiss={dismissPaidOffThisWeekFromDashboard.bind(
              null,
              paidOffDebts.map((d) => d.id),
            )}
          />
        )}
        {isOwner && <DebtAmountReviewCard key="debt-amount-review" reviews={pendingDebtAmountReviews} />}
        {canSeeFullFinancials && <BillAmountReviewCard key="bill-amount-review" reviews={pendingBillAmountReviews} />}
        {isOwner && <DebtBalanceReviewCard key="debt-balance-review" reviews={pendingDebtBalanceReviews} />}
        {canSeeFullFinancials && <PatternPaymentReviewCard key="pattern-payment-review" reviews={pendingPatternPaymentReviews} />}
      </SwipeCarousel>
      </div>

      {/* -mt-3 tightens this section's share of AppShell's shared gap-6 —
          appropriate most days, when the warnings/reviews block above has
          collapsed to nothing (empty:hidden) and this carousel is left
          sitting a full 24px below the stat cards with nothing between them
          to justify it (household report, 2026-09-25: "too big of gap"). */}
      <div className="-mt-3">
      {/* 10s/slide — long enough to actually read a card's numbers (unlike
          the 3-5s standard for an image-only carousel), short enough that a
          household glancing at the dashboard sees more than one card before
          moving on. Only this carousel auto-plays — the warnings/review
          carousel above is action items, not something to passively browse. */}
      <SwipeCarousel desktopGrid threeUp defaultKey="bills" autoPlayMs={10_000}>
        {canSeeFullFinancials && dueLastWeek.length > 0 && (
          <UpcomingBillsCard
            key="bills-last-week"
            title="Last Week's Bills"
            period="Last Week"
            dateRange={lastWeekRangeLabel}
            bills={dueLastWeek.map((b) => ({ ...b, dueDate: b.dueDate.toISOString().slice(0, 10) }))}
            aiSummary={null}
            allPaid={dueLastWeek.every((b) => b.paid || b.skipped)}
          />
        )}

        {canSeeFullFinancials && !billsThisWeekDismissed && (
          <UpcomingBillsCard
            key="bills"
            dateRange={thisWeekRangeLabel}
            bills={dueThisWeek.map((b) => ({ ...b, dueDate: b.dueDate.toISOString().slice(0, 10) }))}
            aiSummary={billsSummary}
            allPaid={allPaidThisWeek}
            onDismiss={dismissBillsThisWeekFromDashboard}
          />
        )}

        {canSeeFullFinancials && paymentCalendar && (
          // Mobile height tightened 400px -> 340px (household request,
          // 2026-09-12 — same target as the stat-strip pass: a baseline
          // dashboard shouldn't need a scrollbar). Safe regardless of how
          // many bills land on any one day: a day cell's own size never
          // depends on its event count (just the date number + up to two
          // tiny corner badges) — every bill on it lists in the popover
          // instead, which is deliberately un-capped/un-scrolled and floats
          // outside this card's box entirely (see CycleCalendarView's own
          // comment on why, after three rounds of clipping incidents). The
          // real constraint is a 6-row month's cells not dropping below a
          // tappable floor — see CycleCalendarView's min-h-8, sized against
          // this card's own chrome budget to hold that even at 340px. `lg:`
          // stays 400px — desktop already has room to spare.
          <div key="payment-calendar" className="flex h-[340px] lg:h-[400px] flex-col rounded-2xl border border-blue-100 dark:border-neutral-800 p-3 lg:p-4">
            <div className="mb-1.5 lg:mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Payment Calendar</h2>
              {calendarFeedUrl && <CalendarSubscribeButtons feedUrl={calendarFeedUrl} />}
            </div>
            <div className="min-h-0 flex-1">
              <CycleCalendarView fillHeight monthDate={paymentCalendar.monthDate} eventsByDay={paymentCalendar.eventsByDay} />
            </div>
            <div className="mt-2 lg:mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-blue-100 dark:border-neutral-800 pt-2 text-[11px] text-gray-500 dark:text-neutral-400">
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-emerald-100 dark:bg-emerald-950" /> Paid
              </span>
              {[...paymentCalendar.eventsByDay.values()].some(
                (events) =>
                  events.some((e) => e.status === "paid") &&
                  events.some((e) => e.status === "due" || e.status === "expected"),
              ) && (
                <span className="flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-sm bg-amber-100 dark:bg-amber-950" /> Partially Paid
                </span>
              )}
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-blue-100 dark:bg-blue-950" /> Upcoming
              </span>
              {[...paymentCalendar.eventsByDay.values()].some((events) => events.some((e) => e.status === "skipped")) && (
                <span className="flex items-center gap-1">
                  <CircleSlash size={12} className="text-neutral-400 dark:text-neutral-600" /> Skipped
                </span>
              )}
              {[...paymentCalendar.eventsByDay.values()].some((events) =>
                events.some((e) => e.kind === "bill"),
              ) && (
                <span className="flex items-center gap-1">
                  <Receipt size={12} className="text-blue-700 dark:text-blue-300" /> Bill
                </span>
              )}
              {[...paymentCalendar.eventsByDay.values()].some((events) =>
                events.some((e) => e.status === "expected" || e.isExtraPayment),
              ) && (
                <span className="flex items-center gap-1">
                  <BanknoteArrowUp size={13} className="text-emerald-600 dark:text-emerald-400" /> Extra Payment
                </span>
              )}
              {[...paymentCalendar.eventsByDay.values()].some((events) => events.some((e) => e.isPayoff)) && (
                <span className="flex items-center gap-1">
                  <Star size={11} className="fill-emerald-400 text-emerald-500" /> Pays Off
                </span>
              )}
            </div>
          </div>
        )}

        {canSeeFullFinancials && thisMonthSpendTrend && lastMonthSpendTrend && (
          <SpendingTrendCard
            key="spending-trend"
            thisMonthRecurringCumulativeCents={thisMonthSpendTrend.recurringCumulativeCentsByDay.slice(0, daysElapsedThisMonth)}
            thisMonthOneTimeCumulativeCents={thisMonthSpendTrend.oneTimeCumulativeCentsByDay.slice(0, daysElapsedThisMonth)}
            thisMonthDaysInMonth={thisMonthSpendTrend.recurringCumulativeCentsByDay.length}
            lastMonthCumulativeCents={lastMonthCumulativeCents}
            lastMonthAtSameDayCents={
              lastMonthCumulativeCents[Math.min(daysElapsedThisMonth, lastMonthCumulativeCents.length) - 1] ?? 0
            }
            periodKey={currentPeriodKey()}
            ceilingCents={spendCeilingCents}
          />
        )}

        {/* Same fixed h-[340px]/lg:h-[400px] box as the other three carousel
            cards (household request, 2026-09-12: "same size as the others",
            not just close) — BucketGrid's tile size/row cap were sized
            against this exact budget so 3 full rows land just under it;
            overflow-hidden is a safety margin against that being off by a
            couple px on a real device, not an expected clip. */}
        <div key="buckets" className="flex h-[340px] lg:h-[400px] flex-col overflow-hidden rounded-2xl border border-blue-100 dark:border-neutral-800 p-3 lg:p-4">
          <div className="mb-2 lg:mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              This Month&apos;s Buckets
            </h2>
            <Link href="/buckets" className="text-sm text-gray-500 dark:text-neutral-400">
              View All →
            </Link>
          </div>

          {buckets.length === 0 ? (
            <>
              <p className="text-sm text-gray-600 dark:text-neutral-400">No buckets set up yet.</p>
              <Link
                href="/buckets"
                className="mt-3 inline-block rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white"
              >
                Set Up Buckets
              </Link>
            </>
          ) : (
            <BucketGrid buckets={[...buckets].sort((a, b) => b.spentPct - a.spentPct)} />
          )}
        </div>

        {netWorth && (
          // Matches Payment Calendar/SpendingTrendCard's own 340px mobile
          // target (400 at lg:) — the three fixed-height carousel cards were
          // designed to match each other, so all three trim together. A
          // chart, unlike a list, has no item-density concern shrinking it —
          // the flex-1 NetWorthMiniChart wrapper below just gets a smaller
          // share of the box.
          <Link
            key="net-worth"
            href="/networth"
            className="flex h-[340px] lg:h-[400px] flex-col rounded-2xl border border-blue-100 dark:border-neutral-800 p-3 lg:p-4 transition-colors hover:border-blue-300 dark:hover:border-neutral-700"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Net Worth</h2>
                <p
                  className={`text-2xl lg:text-3xl font-semibold ${netWorth.netWorthCents < 0 ? "text-red-600 dark:text-red-400" : "text-blue-900 dark:text-blue-300"}`}
                >
                  {formatCents(netWorth.netWorthCents)}
                </p>
                {netWorthMonth && (
                  <p
                    className={`mt-1 flex items-center gap-1 text-sm font-medium ${
                      netWorthMonth.deltaCents > 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : netWorthMonth.deltaCents < 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-gray-500 dark:text-neutral-400"
                    }`}
                  >
                    {netWorthMonth.deltaCents > 0 ? (
                      <TrendingUp size={16} />
                    ) : netWorthMonth.deltaCents < 0 ? (
                      <TrendingDown size={16} />
                    ) : (
                      <Minus size={16} />
                    )}
                    {netWorthMonth.deltaCents === 0
                      ? "No Change"
                      : `${netWorthMonth.deltaCents > 0 ? "+" : ""}${formatCents(netWorthMonth.deltaCents)}`}
                    <span className="font-normal text-gray-500 dark:text-neutral-400">
                      {windowLabel(netWorthMonth, 30)}
                    </span>
                  </p>
                )}
              </div>
              <span className="mt-1 shrink-0 text-sm text-gray-500 dark:text-neutral-400">Details →</span>
            </div>
            {netWorthMonth ? (
              <div className="mt-2 lg:mt-3 min-h-0 flex-1">
                <NetWorthMiniChart
                  points={netWorthMonth.points}
                  className={netWorth.netWorthCents < 0 ? "text-red-600 dark:text-red-400" : "text-blue-900 dark:text-blue-300"}
                />
              </div>
            ) : (
              <div className="flex-1" />
            )}
            <div className="mt-3 lg:mt-4 grid grid-cols-3 gap-3 border-t border-blue-100 dark:border-neutral-800 pt-2 lg:pt-3 text-sm">
              <div>
                <p className="text-gray-500 dark:text-neutral-400">Cash</p>
                <p className="font-medium text-neutral-900 dark:text-neutral-100">
                  {formatCents(netWorth.liquidCashCents)}
                </p>
              </div>
              <div>
                <p className="text-gray-500 dark:text-neutral-400">Assets</p>
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  {formatCents(netWorth.totalAssetsCents)}
                </p>
              </div>
              <div>
                <p className="text-gray-500 dark:text-neutral-400">Debts</p>
                <p className="font-medium text-red-600 dark:text-red-400">
                  {formatCents(netWorth.totalDebtsCents)}
                </p>
              </div>
            </div>
          </Link>
        )}

        {canSeeFullFinancials && <SavingsGoalsCard key="savings" goals={savingsGoals} />}
      </SwipeCarousel>
      </div>
    </AppShell>
  );
}
