import { db } from "@/lib/db";
import { currentPeriodKey, utcPeriodBounds, monthElapsedFraction, daysAgo } from "@/lib/period";
import { occurrencesInPeriod } from "@/lib/cycle-slots";
import { sendPushToBucketForType } from "@/lib/push";
import { formatCents } from "@/lib/money";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import { currentPeriodBillWhere } from "@/lib/recurring-bills";
import { isPayoffPlanEnabled } from "@/lib/debt-payments";
import { SPEND_TX_SELECT, netSpendCents, ACCOUNTED_FOR_SELECT, accountedForCents } from "@/lib/spend";
import { budgetedDebtPaymentCents } from "@/lib/debt-payment-budget";
import { todayAsUTCDate } from "@/lib/date";
import { budgetTrackedWhere } from "@/lib/budget-tracked";
import type { BucketAlertLevel, BucketTrackingMode, BillCadence, NotificationType, Prisma } from "@prisma/client";

const NOTIFICATION_TYPE_BY_ALERT_LEVEL: Record<BucketAlertLevel, NotificationType> = {
  WARNING: "BUCKET_WARNING",
  EXCEEDED: "BUCKET_EXCEEDED",
  PACE: "BUCKET_PACE",
};

// A transaction this stale can't affect the current month's bucket totals or
// reports anyway — nagging to pick a bucket for it just piles up noise
// forever. Once a month passes unpicked, it silently drops out of the
// "Needs a bucket" queue and the dashboard's attention count rather than
// being tracked as a permanent gap — still fully visible/reassignable via
// /transactions, which has no such filter.
const UNCATEGORIZED_LOOKBACK_DAYS = 30;

export function uncategorizedTransactionWhere(householdId: string): Prisma.TransactionWhereInput {
  return {
    householdId,
    bucketId: null,
    isIncome: false,
    isTransfer: false,
    // Debit-only — a not-yet-linked refund candidate (see isRefundCandidate,
    // transaction-row.tsx) sits in this exact bucketId:null/isTransfer:false/
    // isIncome:false state on the credit side too, but it's never resolved
    // by picking a bucket here (a credit never gets this queue's Move
    // action) — it has its own dedicated surface instead (getUnmatchedRefunds,
    // the "Possible Refunds" filter/dashboard card). Without this, every
    // unresolved refund candidate double-counted here as well (real
    // household request, 2026-09-06) — the same shape of bug the P2P
    // exclusion below already fixed for P2P specifically. This alone also
    // covers the already-linked-but-bucketless case the old
    // reimbursesTransactionId/reimbursesMerchant check below existed for
    // (a linked refund is still a credit), so that check is redundant now
    // and removed.
    amountCents: { gt: 0 },
    // A P2P debit (Venmo/Zelle/PayPal) lands in exactly this same
    // bucketId:null/isTransfer:false/isIncome:false state by default (see
    // simplefin-sync.ts) — but it already has its own dedicated "needs
    // review" surface (getUnlabeledP2PTransfers, p2p-transfers.ts), shown
    // on these same three pages. Without this exclusion every P2P debit
    // double-counted: once here, once in the P2P card, for the same
    // transaction (real report, 2026-08-23).
    NOT: { OR: P2P_DISCOVERY_KEYWORDS.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })) },
    occurredOn: { gte: daysAgo(UNCATEGORIZED_LOOKBACK_DAYS) },
    // A still-pending transaction's merchant/date are provisional (see
    // categorizeUncategorizedTransactions' own pending guard, simplefin-sync.ts)
    // — asking the household to pick a bucket now risks asking twice, once
    // for the placeholder and again once it posts under a cleaned-up
    // merchant string. It can still silently auto-match an existing
    // bucket/bill/debt while pending (matchBillPayments etc. have no
    // pending filter); this queue is only for the "needs a human decision"
    // case, which should wait until the transaction is real (household
    // request, 2026-09-22: a pending charge showing up here read as another
    // "suggestion" even with its AI hint suppressed).
    pending: false,
    ...budgetTrackedWhere(),
  };
}

export async function countUncategorizedTransactions(householdId: string): Promise<number> {
  return db.transaction.count({ where: uncategorizedTransactionWhere(householdId) });
}

// Dashboard-card counterpart to countUncategorizedTransactions above — same
// "newer than the dismissal" reappear rule as
// getActiveUnlabeledP2PTransfers (p2p-transfers.ts): dismissing the
// dashboard's reminder isn't permanent, just "I've seen this batch," and
// it comes back once a transaction newer than the dismissal shows up
// uncategorized. Doesn't touch — and isn't touched by — the actual
// worklist on /buckets (UncategorizedList), which always shows the real
// backlog regardless of whether this reminder is dismissed.
export async function getActiveUncategorizedCount(householdId: string): Promise<number> {
  const [count, newest] = await Promise.all([
    countUncategorizedTransactions(householdId),
    db.transaction.findFirst({
      where: uncategorizedTransactionWhere(householdId),
      orderBy: { occurredOn: "desc" },
      select: { occurredOn: true },
    }),
  ]);
  if (count === 0 || !newest) return 0;
  const dismissal = await db.suggestionDismissal.findUnique({
    where: { householdId_kind_key: { householdId, kind: "UNCATEGORIZED_TXN", key: "all" } },
  });
  if (dismissal && newest.occurredOn <= dismissal.createdAt) return 0;
  return count;
}

export async function dismissUncategorized(householdId: string): Promise<void> {
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId, kind: "UNCATEGORIZED_TXN", key: "all" } },
    create: { householdId, kind: "UNCATEGORIZED_TXN", key: "all" },
    update: { createdAt: new Date() },
  });
}

// A month-scale bill/debt-payment obligation — the shape needed to figure
// out how much of a bucket's recurring commitments are due by today, vs.
// still to come this month.
type ScheduledItem = { amountCents: number; cadence: BillCadence; nextDueDate: Date };

export type BucketProgress = {
  id: string;
  name: string;
  monthlyCapCents: number;
  warningThresholdPct: number;
  paceAlertEnabled: boolean;
  spentCents: number;
  spentPct: number;
  remainingCents: number;
  paceFraction: number;
  // "schedule": paceFraction came from this bucket's actual bill/debt-
  // payment due dates (RECURRING/MIXED buckets with something due this
  // month) — the marker shows how much of what's actually scheduled has
  // come due, not a generic day-of-month guess. "calendar": no schedule to
  // reason about (SPEND buckets, or a RECURRING/MIXED bucket with nothing
  // due this particular month), so it falls back to day-of-month/days-in-
  // month, same as every bucket used before 2026-08-22.
  paceBasis: "schedule" | "calendar";
  onPaceToOvershoot: boolean;
  projectedMonthEndCents: number;
  // Bubbles the Buckets nav tab's red-dot badge (see hasBillsNeedingAttention
  // in recurring-bills.ts) down to the specific bucket whose bill(s) are the
  // actual reason for it — true when this bucket has an active RecurringBill
  // with an unconfirmed due date. Only ever true for RECURRING/MIXED
  // buckets, matching hasBillsNeedingAttention's own scope.
  needsAttention: boolean;
  trackingMode: BucketTrackingMode;
  // Stored lucide icon key (an AI pick for a name the keyword rules miss —
  // see Bucket.icon / ensureBucketIcons); null means resolve live from the
  // keyword rules. Feed both to bucketIconComponent (src/lib/bucket-icons).
  icon: string | null;
  // A one-time/irregular bucket funded from outside this month's regular
  // income (a Tesla down payment, a big home repair) — see the schema
  // comment on this field. Spends/caps/alerts completely normally; every
  // *forward-looking* caller that sums monthlyCapCents against income
  // (getHouseholdSavingsCapacity, BucketAllocationCard, budget-plan.ts) must
  // skip a bucket where this is true. Deliberately not skipped by the
  // monthly report, a retrospective record of what actually happened.
  excludedFromAllocation: boolean;
  // This period's cumulative BucketAdHocTopUp draw, already folded into
  // monthlyCapCents/remainingCents/spentPct above — surfaced separately so
  // a bucket card can show "+$60 from extra income" rather than silently
  // presenting a cap the household never actually set. 0 for every
  // household with Household.autoApplyAdHocIncomeToBuckets off (the
  // default) or a bucket that hasn't needed one this period.
  topUpCents: number;
};

// Fraction (0-1) of this bucket's actual bill/debt-payment dollars that are
// due on or before today, out of everything due this calendar month — null
// when nothing is scheduled this month (nothing to be schedule-aware
// about), so the caller can fall back to the calendar-day fraction.
export function dueDateAwareFraction(items: ScheduledItem[], periodStart: Date, periodEnd: Date, today: Date): number | null {
  let totalDueCents = 0;
  let dueSoFarCents = 0;
  for (const item of items) {
    for (const occ of occurrencesInPeriod(item.nextDueDate, item.cadence, periodStart, periodEnd)) {
      totalDueCents += item.amountCents;
      // An occurrence strictly before the tracker's own nextDueDate has
      // already been matched to a real payment and rolled past it — by
      // construction (matchBillPayments/matchDebtPayments only ever advance
      // nextDueDate once a payment satisfies the current occurrence) — so it
      // counts as "due" regardless of its own calendar date relative to
      // today. Without this, a subscription that charges a few days *before*
      // its own recorded due date (real report, 2026-09-26: a bill paid
      // Sep 25, but its derived September occurrence — one cadence back
      // from nextDueDate, already rolled to Oct 27 — was Sep 27, a day past
      // "today") understated the whole bucket's pace fraction (75% shown,
      // should've read 100%) even though every tracked bill had already
      // posted and nextDueDate had already rolled forward for each one.
      if (occ <= today || occ < item.nextDueDate) dueSoFarCents += item.amountCents;
    }
  }
  return totalDueCents > 0 ? dueSoFarCents / totalDueCents : null;
}

export function resolvePaceFraction(
  bucket: { trackingMode: BucketTrackingMode; recurringBills: ScheduledItem[]; debtPayments: ScheduledItem[] },
  utcPeriodStart: Date,
  utcPeriodEnd: Date,
  today: Date,
  calendarElapsedFraction: number,
): { paceFraction: number; paceBasis: "schedule" | "calendar" } {
  if (bucket.trackingMode !== "SPEND") {
    const schedule = dueDateAwareFraction(
      [...bucket.recurringBills, ...bucket.debtPayments],
      utcPeriodStart,
      utcPeriodEnd,
      today,
    );
    if (schedule !== null) return { paceFraction: schedule, paceBasis: "schedule" };
  }
  return { paceFraction: calendarElapsedFraction, paceBasis: "calendar" };
}


export function computeProgress(
  bucket: {
    id: string;
    name: string;
    monthlyCapCents: number;
    warningThresholdPct: number;
    paceAlertEnabled: boolean;
    paceSensitivity: number;
    trackingMode: BucketTrackingMode;
    icon: string | null;
    excludedFromAllocation: boolean;
  },
  spentCents: number,
  paceFraction: number,
  paceBasis: "schedule" | "calendar",
  needsAttention: boolean,
  // This period's BucketAdHocTopUp sum (getBucketTopUpCentsByBucketId,
  // bucket-ad-hoc-topup.ts) — added on top of the household's own configured
  // monthlyCapCents for every computation below, so a bucket already
  // covered by applied ad hoc income doesn't also read as still over/
  // on-pace-to-overshoot/needing an alert. Defaults to 0 so callers that
  // never touch the feature (autoApplyAdHocIncomeToBuckets off) don't have
  // to thread a param they'll never use.
  topUpCents = 0,
): BucketProgress {
  const effectiveCapCents = bucket.monthlyCapCents + topUpCents;
  const spentPct = effectiveCapCents > 0 ? (spentCents / effectiveCapCents) * 100 : 0;
  const projectedMonthEndCents =
    paceFraction > 0 ? Math.round(spentCents / paceFraction) : spentCents;
  const onPaceToOvershoot =
    bucket.paceAlertEnabled &&
    paceFraction > 0 &&
    spentCents > effectiveCapCents * paceFraction * bucket.paceSensitivity;

  return {
    id: bucket.id,
    name: bucket.name,
    monthlyCapCents: effectiveCapCents,
    warningThresholdPct: bucket.warningThresholdPct,
    paceAlertEnabled: bucket.paceAlertEnabled,
    spentCents,
    spentPct,
    remainingCents: effectiveCapCents - spentCents,
    paceFraction,
    paceBasis,
    onPaceToOvershoot,
    projectedMonthEndCents,
    needsAttention,
    trackingMode: bucket.trackingMode,
    icon: bucket.icon,
    topUpCents,
    excludedFromAllocation: bucket.excludedFromAllocation,
  };
}

// A bucket's total spend within an arbitrary date range — same debt-payment-
// aware logic getBucketsWithProgress needs for "this month," generalized so
// the weekly bucket digest (checkWeeklyBucketDigests, scheduled-
// notifications.ts) can ask "how much this week" against the exact same
// rules instead of reimplementing them a second time. A DebtPayment
// assigned to a bucket (DebtPayment.bucketId) counts toward that bucket's
// spend total same as a real bill — a household's monthly cap on a "Bills"
// bucket is meant to cover everything recurring, debt or not (confirmed
// directly, 2026-08-15: this used to work when a debt payment was
// informally tracked as a plain RecurringBill, and the household noticed it
// drop out of the total once it became a proper DebtPayment — see the
// WORKING_ON.md incident this same day). A DebtPayment's own
// Transaction.bucketId is always null (mutual-exclusion: bucketId vs.
// debtId+isTransfer, see WORKING_ON.md's core data conventions), so this
// can't reuse the plain `transactions` relation alone — has to go through
// debtPaymentId too. The counting rule itself (budgetedDebtPaymentCents) now
// lives in its own leaf module, debt-payment-budget.ts, so spend.ts's
// dashboard trend card can share it too — see that file's own comment.

export async function spendByBucketInRange(
  householdId: string,
  utcStart: Date,
  utcEnd: Date,
): Promise<Map<string, number>> {
  // Callers must pass already-UTC-anchored bounds (utcPeriodBounds,
  // currentWeekBounds — anything shaped like a UTC-midnight instant), not
  // periodBounds' local-time ones: every date compared against them here
  // (Transaction.occurredOn, DebtPayment.nextDueDate) is a UTC-midnight
  // @db.Date, so the comparison only lines up when both sides are already
  // UTC (see utcPeriodBounds's own doc comment).
  //
  // This function used to accept local-time bounds and re-derive UTC ones
  // itself via todayAsUTCDate(start)/todayAsUTCDate(end) — which reads
  // LOCAL calendar getters off whatever Date it's given. That was correct
  // for a periodBounds()-shaped caller (genuinely local-time), but
  // currentWeekBounds() already returns UTC-anchored instants (built via
  // Date.UTC), so re-deriving through local getters on an
  // already-UTC-midnight Sunday read back as Saturday evening on a
  // TZ-behind-UTC server and shifted the whole window a day earlier — a
  // real bug that corrupted checkWeeklyBucketDigestsForHousehold's spend
  // total (real finding, 2026-09-12 code review). Rather than have this
  // function guess which shape it was handed, every caller now does its own
  // conversion up front (periodBounds callers wrap with todayAsUTCDate;
  // currentWeekBounds/utcPeriodBounds callers pass their bounds straight
  // through) and this function trusts what it's given.
  const [buckets, debtPaymentTxns, payoffPlanEnabled] = await Promise.all([
    db.bucket.findMany({
      where: { householdId },
      select: {
        id: true,
        // netSpendCents, not a raw sum — a refund folds onto the month of
        // the charge it offsets, not the month it posted (see src/lib/spend.ts).
        transactions: { where: { occurredOn: { gte: utcStart, lt: utcEnd } }, select: SPEND_TX_SELECT },
      },
    }),
    db.transaction.findMany({
      where: {
        householdId,
        debtPaymentId: { not: null },
        occurredOn: { gte: utcStart, lt: utcEnd },
      },
      select: {
        amountCents: true,
        debtPaymentId: true,
        debtPayment: {
          select: { bucketId: true, amountCents: true, cadence: true, nextDueDate: true },
        },
        // See the schema comment on Transaction.accountedForLinks — partial,
        // not all-or-nothing: only the linked purchases' own net amounts are
        // excluded below, not the whole payment.
        ...ACCOUNTED_FOR_SELECT,
      },
    }),
    isPayoffPlanEnabled(householdId),
  ]);

  const spentByBucketId = new Map<string, number>();
  for (const b of buckets) {
    spentByBucketId.set(b.id, netSpendCents(b.transactions));
  }

  // Roll every payment up per DebtPayment first — the budgeted ceiling
  // (minimum(s) this cycle, plan off) is a per-cycle concept, so two payments
  // in one period share one ceiling rather than each getting their own.
  // Math.abs() since a card/loan payment can post on the debt's own
  // liability account as a negative credit (see filterDebtPaymentTwins,
  // debt-payments.ts) — this is "amount paid," never the account-native sign.
  const byDebtPayment = new Map<
    string,
    { bucketId: string; minimumCents: number; cadence: BillCadence; nextDueDate: Date; paidCents: number }
  >();
  for (const t of debtPaymentTxns) {
    const dp = t.debtPayment;
    if (!dp?.bucketId || !t.debtPaymentId) continue;
    const accountedFor = accountedForCents(t);
    const net = Math.max(0, Math.abs(t.amountCents) - accountedFor);
    const existing = byDebtPayment.get(t.debtPaymentId);
    if (existing) {
      existing.paidCents += net;
    } else {
      byDebtPayment.set(t.debtPaymentId, {
        bucketId: dp.bucketId,
        minimumCents: dp.amountCents,
        cadence: dp.cadence,
        nextDueDate: dp.nextDueDate,
        paidCents: net,
      });
    }
  }

  for (const g of byDebtPayment.values()) {
    const { countedCents } = budgetedDebtPaymentCents({
      paidCents: g.paidCents,
      minimumCents: g.minimumCents,
      occurrencesThisPeriod: occurrencesInPeriod(g.nextDueDate, g.cadence, utcStart, utcEnd).length,
      payoffPlanEnabled,
    });
    spentByBucketId.set(g.bucketId, (spentByBucketId.get(g.bucketId) ?? 0) + countedCents);
  }
  return spentByBucketId;
}

// Every bucket's cumulative BucketAdHocTopUp draw this calendar period —
// getBucketsWithProgress/checkAndSendBucketAlerts add this on top of
// Bucket.monthlyCapCents when computing progress (see computeProgress's own
// topUpCents param and BucketAdHocTopUp's schema comment for why this is a
// summed ledger and never a direct mutation of the household's own
// configured cap). Lives here, not alongside the allocation engine that
// writes to this table (bucket-ad-hoc-topup.ts), specifically so that file
// can import getBucketsWithProgress from this one without the two importing
// each other.
export async function getBucketTopUpCentsByBucketId(
  householdId: string,
  periodKey: string,
): Promise<Map<string, number>> {
  const rows = await db.bucketAdHocTopUp.groupBy({
    by: ["bucketId"],
    where: { householdId, periodKey },
    _sum: { amountCents: true },
  });
  return new Map(rows.map((r) => [r.bucketId, r._sum.amountCents ?? 0]));
}

// `includeBucketId`: a bucket's own detail page still needs its progress
// after it's retired (Bucket.retiredAt) — every other caller gets live
// buckets only.
export async function getBucketsWithProgress(
  householdId: string,
  opts: { includeBucketId?: string } = {},
): Promise<BucketProgress[]> {
  const period = currentPeriodKey();
  const { start: utcStart, end: utcEnd } = utcPeriodBounds(period);
  const today = todayAsUTCDate();
  const elapsedFraction = monthElapsedFraction();

  // topUpCentsByBucketId has no dependency on the other three queries below
  // — folded into the same Promise.all instead of paying for it as its own
  // serial round-trip ahead of them (2026-09-14 code review).
  const [topUpCentsByBucketId, buckets, unconfirmedBills, spentByBucketId] = await Promise.all([
    getBucketTopUpCentsByBucketId(householdId, period),
    db.bucket.findMany({
      // Retired one-time buckets (Bucket.retiredAt) are history, not a live
      // bucket — off the dashboard, /buckets, and everything built on this.
      where: {
        householdId,
        OR: [{ retiredAt: null }, ...(opts.includeBucketId ? [{ id: opts.includeBucketId }] : [])],
      },
      orderBy: { sortOrder: "asc" },
      include: {
        // Only feeds the schedule-aware pace fraction (resolvePaceFraction)
        // for RECURRING/MIXED buckets below — irrelevant, but harmless, for
        // SPEND ones.
        // currentPeriodBillWhere, not a bare active:true — a bill cancelled
        // but already paid this month is still part of this month's pace math
        // (and the AI report that reads it), then drops out at rollover.
        recurringBills: { where: currentPeriodBillWhere(), select: { amountCents: true, cadence: true, nextDueDate: true } },
        debtPayments: { where: { active: true }, select: { amountCents: true, cadence: true, nextDueDate: true } },
      },
    }),
    // Same criteria as hasBillsNeedingAttention (recurring-bills.ts), just
    // grouped by bucket instead of collapsed to one household-wide boolean.
    db.recurringBill.findMany({
      where: {
        householdId,
        active: true,
        dueDateLocked: false,
        bucket: { trackingMode: { in: ["RECURRING", "MIXED"] } },
      },
      select: { bucketId: true },
    }),
    spendByBucketInRange(householdId, utcStart, utcEnd),
  ]);
  const bucketIdsNeedingAttention = new Set(unconfirmedBills.map((b) => b.bucketId).filter((id) => id !== null));

  // A one-time-purchase bucket (excludedFromAllocation) tracks progress
  // toward a target, not spend within a month — a $6k down payment paid as
  // three $2k charges across three months should read 1/3 → 2/3 → done, not
  // snap back to $0 each rollover. So its "spent" is every charge ever
  // assigned to it, not just this period's (2026-09-10 household call). Plain
  // transactions only — a one-time bucket never holds a tracked bill or debt
  // payment, so spendByBucketInRange's debt-payment arm has nothing to add.
  const oneTimeBucketIds = buckets.filter((b) => b.excludedFromAllocation).map((b) => b.id);
  const lifetimeSpentByBucketId = new Map<string, number>();
  if (oneTimeBucketIds.length > 0) {
    const rows = await db.bucket.findMany({
      where: { id: { in: oneTimeBucketIds } },
      // Genuinely lifetime, unlike every other bucket's per-period query
      // above — no date filter is correct here (see the comment above). But
      // "no filter at all" also means nothing bounds it as a long-lived
      // one-time bucket keeps collecting charges over years; this cap is
      // just a safety net against unbounded growth, not a real limit any
      // realistic one-time purchase should ever hit.
      select: { id: true, transactions: { select: SPEND_TX_SELECT, take: 2000 } },
    });
    for (const r of rows) lifetimeSpentByBucketId.set(r.id, netSpendCents(r.transactions));
  }

  return buckets.map((b) => {
    const spentCents = b.excludedFromAllocation
      ? (lifetimeSpentByBucketId.get(b.id) ?? 0)
      : (spentByBucketId.get(b.id) ?? 0);
    const { paceFraction, paceBasis } = resolvePaceFraction(b, utcStart, utcEnd, today, elapsedFraction);
    return computeProgress(
      b,
      spentCents,
      paceFraction,
      paceBasis,
      bucketIdsNeedingAttention.has(b.id),
      topUpCentsByBucketId.get(b.id) ?? 0,
    );
  });
}

// A one-time-purchase bucket (excludedFromAllocation) is funded toward a
// target across however many charges/months it takes — it has no monthly cap
// to "approach", "exceed" or "overshoot", so none of the threshold/pace
// pushes apply (2026-09-20: one $5,999.94 Tesla charge fired both a monthly-
// style "budget exceeded" push and the per-transaction push). Its only
// alerts: a progress push per new charge (when the bucket's per-transaction
// alerts are on) and ONE "Fully Funded" push, ever.
export function oneTimeBucketStatus(spentCents: number, targetCents: number): { fullyFunded: boolean; pctFunded: number } {
  const pctFunded = targetCents > 0 ? Math.min(100, Math.floor((spentCents / targetCents) * 100)) : 0;
  return { fullyFunded: targetCents > 0 && spentCents >= targetCents, pctFunded };
}

// BucketAlert.period is "YYYY-MM" for the monthly levels; this sentinel makes
// the unique (bucketId, period, level) row a *lifetime* "already told you it
// was funded" marker instead of a per-month one.
const ONE_TIME_ALERT_PERIOD = "ONE_TIME";

// Called after any transaction create/update/delete. Sends at most one
// threshold push per bucket/period/level (enforced by BucketAlert's unique
// constraint — the DB is the source of truth for "already notified," so
// concurrent transaction writes can't double-send), plus — for a bucket with
// transactionAlertEnabled — one BUCKET_TRANSACTION push per not-yet-alerted
// transaction currently in the period (see sendUnalertedBucketTransactions).
export async function checkAndSendBucketAlerts(bucketId: string): Promise<void> {
  const bucket = await db.bucket.findUnique({
    where: { id: bucketId },
    include: {
      recurringBills: { where: { active: true }, select: { amountCents: true, cadence: true, nextDueDate: true } },
      debtPayments: { where: { active: true }, select: { amountCents: true, cadence: true, nextDueDate: true } },
    },
  });
  if (!bucket) return;

  const period = currentPeriodKey();
  const { start: utcStart, end: utcEnd } = utcPeriodBounds(period);
  const today = todayAsUTCDate();
  const elapsedFraction = monthElapsedFraction();
  const { paceFraction, paceBasis } = resolvePaceFraction(bucket, utcStart, utcEnd, today, elapsedFraction);

  // spendByBucketInRange, not a plain bucket.transactions query — this used
  // to only sum the bucket's own Transactions, missing any bucket-assigned
  // DebtPayment spend (a debt payment's own Transaction is bucketId:null by
  // convention, see reassignTransaction's comment). getBucketsWithProgress
  // (what /buckets actually renders) already folds that in, so a bucket
  // holding a mortgage payment could sit at 100%+ there while this function
  // computed a much lower percentage and never fired the alert (2026-09-11
  // fix) — this is now the single source of truth both read.
  const oneTime = bucket.excludedFromAllocation;
  // A one-time bucket's progress is lifetime (every charge ever assigned, same
  // as getBucketsWithProgress) — this month's spend says nothing about it.
  const spentCents = oneTime
    ? netSpendCents(
        await db.transaction.findMany({ where: { bucketId }, select: SPEND_TX_SELECT, take: 2000 }),
      )
    : ((await spendByBucketInRange(bucket.householdId, utcStart, utcEnd)).get(bucketId) ?? 0);
  const topUpCents = (await getBucketTopUpCentsByBucketId(bucket.householdId, period)).get(bucketId) ?? 0;
  // needsAttention doesn't factor into alert thresholds — irrelevant here.
  const progress = computeProgress(bucket, spentCents, paceFraction, paceBasis, false, topUpCents);

  const levelsToTry: { level: BucketAlertLevel; title: string; body: string; period?: string }[] = [];

  const oneTimeStatus = oneTime ? oneTimeBucketStatus(spentCents, progress.monthlyCapCents) : null;
  if (oneTimeStatus) {
    // The only level a one-time bucket ever fires, deduped for life.
    if (oneTimeStatus.fullyFunded) {
      levelsToTry.push({
        level: "EXCEEDED",
        period: ONE_TIME_ALERT_PERIOD,
        title: `${bucket.name} Fully Funded`,
        body: `${formatCents(spentCents)} of ${formatCents(progress.monthlyCapCents)} funded.`,
      });
    }
  } else if (progress.spentPct >= 100) {
    levelsToTry.push({
      level: "EXCEEDED",
      title: `${bucket.name} budget exceeded`,
      body: `${formatCents(progress.spentCents)} of ${formatCents(progress.monthlyCapCents)} spent this month.`,
    });
  } else if (progress.spentPct >= bucket.warningThresholdPct) {
    levelsToTry.push({
      level: "WARNING",
      title: `${bucket.name} approaching its budget`,
      body: `${Math.round(progress.spentPct)}% of ${formatCents(progress.monthlyCapCents)} spent this month.`,
    });
  } else if (progress.onPaceToOvershoot) {
    const paceDescription =
      progress.paceBasis === "schedule"
        ? `${Math.round(progress.paceFraction * 100)}% of this month's bills due so far`
        : `${Math.round(progress.paceFraction * 100)}% of the month gone`;
    levelsToTry.push({
      level: "PACE",
      title: `${bucket.name} is spending fast`,
      body: `${paceDescription}, already ${Math.round(progress.spentPct)}% of budget spent — on pace for ${formatCents(progress.projectedMonthEndCents)}.`,
    });
  }

  for (const { level, title, body, period: alertPeriod } of levelsToTry) {
    try {
      await db.bucketAlert.create({ data: { bucketId, period: alertPeriod ?? period, level } });
    } catch {
      continue; // unique constraint hit — already notified this period/level
    }
    await sendPushToBucketForType(bucket.id, bucket.householdId, NOTIFICATION_TYPE_BY_ALERT_LEVEL[level], {
      title,
      body,
      url: `/buckets/${bucket.id}`,
    });
  }

  if (bucket.transactionAlertEnabled) {
    await sendUnalertedBucketTransactions(
      bucket.id,
      bucket.name,
      bucket.householdId,
      progress.monthlyCapCents,
      spentCents,
      oneTimeStatus,
    );
  }
}

// One push per current-period transaction in this bucket that hasn't been
// pushed yet (BucketTransactionAlert.transactionId is the per-transaction
// dedup key — see that model's comment). `spentCents` is the bucket's
// already-computed period total *including* every one of these, so every
// push in one batch shows the same final running total rather than a
// step-by-step replay — simpler, and the only case where a batch is bigger
// than one transaction is a first-time enable (catching up on the whole
// period at once) or a burst of synced transactions landing together.
async function sendUnalertedBucketTransactions(
  bucketId: string,
  bucketName: string,
  householdId: string,
  monthlyCapCents: number,
  spentCents: number,
  // Set for a one-time-purchase bucket — see oneTimeBucketStatus.
  oneTimeStatus: { fullyFunded: boolean; pctFunded: number } | null = null,
): Promise<void> {
  const period = currentPeriodKey();
  // UTC bounds, not local periodBounds — occurredOn is a UTC-midnight
  // @db.Date (see spendByBucketInRange's comment on this same distinction).
  // A one-time-purchase bucket's progress is lifetime, not period-scoped
  // (see checkAndSendBucketAlerts' own `oneTime` branch above) — searching
  // only the current period here meant a transaction reassigned into a
  // one-time bucket from a prior period never got its per-transaction push,
  // even though it correctly counted toward spentCents/oneTimeStatus (real
  // finding, 2026-09-22 code review).
  const { start, end } = utcPeriodBounds(period);
  const scopedWhere = { bucketId, ...(oneTimeStatus === null ? { occurredOn: { gte: start, lt: end } } : {}) };

  // Every transaction in scope, not just the unalerted ones — the "N
  // transactions, $X today" line each push carries needs the whole day's
  // activity in this bucket, including whatever already alerted earlier
  // today. Deliberately no `pending` filter: a pending hold counts toward
  // today's total same as a posted transaction (see the dedup note below on
  // why a pending transaction firing this alert never double-fires once it
  // posts).
  const scoped = await db.transaction.findMany({
    where: scopedWhere,
    select: { id: true, merchant: true, occurredOn: true, bucketTransactionAlert: true, ...SPEND_TX_SELECT },
    orderBy: { occurredOn: "asc" },
  });
  const unalerted = scoped.filter((t) => t.bucketTransactionAlert === null);
  if (unalerted.length === 0) return;

  const byDay = new Map<number, typeof scoped>();
  for (const t of scoped) {
    const key = t.occurredOn.getTime();
    const list = byDay.get(key);
    if (list) list.push(t);
    else byDay.set(key, [t]);
  }

  for (const t of unalerted) {
    try {
      // The dedup row is created (and keyed) off this transaction's own id,
      // which SimpleFIN sync upserts in place across pending -> posted (see
      // simplefin-sync.ts) rather than creating a new row — so a pending
      // transaction that fires this alert here is never re-alerted once it
      // settles, even if the posted amount differs from the pending hold
      // (household requirement, 2026-09-24).
      await db.bucketTransactionAlert.create({ data: { transactionId: t.id } });
    } catch {
      continue; // unique constraint hit — already alerted (race with another caller)
    }
    // A funded one-time bucket already got (or is getting, from the caller's
    // level loop) its single "Fully Funded" push — the charge that completes
    // it, and any after, stay silent instead of doubling up. The row above is
    // still recorded so it can never re-alert later.
    if (oneTimeStatus?.fullyFunded) continue;

    const dayTxns = byDay.get(t.occurredOn.getTime()) ?? [];
    const dailyCount = dayTxns.length;
    const dailyLine = `${dailyCount} transaction${dailyCount === 1 ? "" : "s"} today totaling ${formatCents(netSpendCents(dayTxns))}.`;

    await sendPushToBucketForType(bucketId, householdId, "BUCKET_TRANSACTION", {
      title: `${formatCents(Math.abs(t.amountCents))} at ${t.merchant}`,
      body: oneTimeStatus
        ? `${bucketName}: ${formatCents(spentCents)} of ${formatCents(monthlyCapCents)} funded (${oneTimeStatus.pctFunded}%). ${dailyLine}`
        : `${bucketName}: ${formatCents(spentCents)} of ${formatCents(monthlyCapCents)} spent this month. ${dailyLine}`,
      url: `/buckets/${bucketId}`,
    });
  }
}

// Pure — the day a one-time bucket's running total (oldest charge first,
// refunds negative) reached its target and stayed there; null if it isn't
// funded now. A refund that drops it back under the target un-funds it.
export function oneTimeFundedOn(
  txns: { amountCents: number; occurredOn: Date }[],
  targetCents: number,
): Date | null {
  if (targetCents <= 0) return null;
  const sorted = [...txns].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
  let running = 0;
  let fundedOn: Date | null = null;
  for (const t of sorted) {
    running += t.amountCents;
    if (running < targetCents) fundedOn = null;
    else if (fundedOn === null) fundedOn = t.occurredOn;
  }
  return fundedOn;
}

// A one-time bucket (excludedFromAllocation — a Tesla down payment) is done
// once its lifetime spend reaches its target, and drops off every live list
// the month AFTER the one that filled it (household rule, 2026-10-02): it
// stays visible, "Fully Funded", for the rest of the month it completed in,
// then retires. Retiring only sets Bucket.retiredAt — transactions, the
// detail page, and past reports are untouched. Runs from the hourly
// scheduled checks; returns how many buckets it retired.
export async function retireFundedOneTimeBuckets(householdId: string): Promise<number> {
  const { start: monthStart } = utcPeriodBounds(currentPeriodKey());
  const candidates = await db.bucket.findMany({
    where: { householdId, excludedFromAllocation: true, retiredAt: null, monthlyCapCents: { gt: 0 } },
    select: {
      id: true,
      monthlyCapCents: true,
      transactions: { orderBy: { occurredOn: "asc" }, select: { ...SPEND_TX_SELECT, occurredOn: true } },
    },
  });
  const toRetire: string[] = [];
  for (const b of candidates) {
    // Each charge net of its linked refunds/offsets (netSpendCents on a
    // one-row list) — the same figure the bucket's own progress bar uses, so
    // a $6K charge with a $1K refund reads 83% funded here too, not retired
    // as fully funded (2026-10-03 code review).
    const fundedOn = oneTimeFundedOn(
      b.transactions.map((t) => ({ amountCents: netSpendCents([t]), occurredOn: t.occurredOn })),
      b.monthlyCapCents,
    );
    if (fundedOn && fundedOn < monthStart) toRetire.push(b.id);
  }
  if (toRetire.length === 0) return 0;
  await db.bucket.updateMany({ where: { id: { in: toRetire } }, data: { retiredAt: new Date() } });
  return toRetire.length;
}
