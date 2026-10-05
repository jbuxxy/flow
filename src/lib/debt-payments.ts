import { cache } from "react";
import { db } from "@/lib/db";
import { sendPushToHouseholdForType } from "@/lib/push";
import { formatCents } from "@/lib/money";
import {
  nextBillDueDate,
  amountToleranceCents,
  subtractCadence,
  currentPeriodBillWhere,
  MAX_CATCHUP_CYCLES,
  getActiveBillCycleSkips,
  type UpcomingBill,
} from "@/lib/recurring-bills";
import {
  nextPaidOffDate,
  projectCyclePlan,
  debtsWithInsufficientMinimum,
  computeAttackOrder,
  computeAlreadyFreedMinimums,
  monthlyRateOf,
  pickPayoffPaymentTime,
  correctedNextDueDate,
  supersededPayoffExtraCents,
  supersededPayoffTargetAmounts,
  type PayoffExtraSnapshotLine,
  type DebtInput,
  type PayoffOrder,
  type PoolBreakdown,
  type InsufficientMinimumDebt,
  type FreedMinimumSource,
  type CyclePlanMonth,
} from "@/lib/debt-payoff";
import type { CalendarDayEvent } from "@/app/debts/cycle-calendar-view";
import type { IcsEvent } from "@/lib/ics";
import { getPrimaryIncomeSchedule } from "@/lib/income";
import { currentWeekBounds, currentPeriodKey, utcPeriodBounds, daysAgo } from "@/lib/period";
import { todayAsUTCDate } from "@/lib/date";
import {
  buildCycleSlots,
  occurrencesInPeriod,
  slotBounds,
  extraPaymentsBeyondSlots,
  splitPlanExtraPayments,
} from "@/lib/cycle-slots";
import {
  extraTowardPrincipalCents,
  occurrenceSettledAfterWeek,
  parkedOccurrenceSettledLate,
} from "@/lib/upcoming-bills-shared";
import { coveredMinimumDates, ledgerMinimumCents } from "@/lib/minimum-ledger";
import { allBnplKeywords, resolveBnplKeyword } from "@/lib/bnpl-detect";
import { upsertMerchantRule } from "@/lib/merchant-rules";
import { isGenericCardPaymentDescriptor } from "@/lib/debt-payment-pattern";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import { DAY_MS, classifyCadence, MIN_OCCURRENCES, getDismissedBillKeys, type BillSuggestion } from "@/lib/bill-detect";
import { mapConcurrent } from "@/lib/concurrency";
import { SPEND_TX_SELECT, netChargeCents } from "@/lib/spend";
import type { BillCadence } from "@prisma/client";

// The debt-payment counterpart to src/lib/recurring-bills.ts — split out
// because a card/loan's tracked payment (DebtPayment) diverged enough from
// a real bill (RecurringBill) to stop sharing one model/engine: matching is
// exact debtId equality (no merchant-text ambiguity to guard a window
// against), the expected amount drifts automatically within a tolerance
// band with a human asked to confirm anything further out (see
// DebtAmountReview below), and every matching payment stays linked — not
// just the one that completes a cycle — so extra/additional payments toward
// the same debt are visible too.

// The obvious-default resolver behind DebtPayment.bucketId (2026-08-14) —
// every tracked debt payment should surface in the household's Bills view
// too, not just on /debts, without anyone having to flip that on
// card-by-card. Prefers a bucket literally named "Bills" (case-insensitive
// — the household's own convention for where recurring payments belong,
// 2026-08-16), then falls back to the first RECURRING-tracking-mode bucket
// by sort order. Previously required *exactly one* RECURRING bucket to
// exist at all — real report, 2026-08-16: a household with a "Bills" bucket
// plus other RECURRING-tracking buckets got null every time, silently
// orphaning a freshly-tracked BNPL plan with no bucket and no visible way
// to find it again (Bills only ever renders inside a specific bucket's own
// page). Returns null only when the household truly has nothing to default
// to — still recoverable via DebtPaymentRow's own bucket picker, or the
// bucket-selection field now on every debt-payment setup form. Called both
// at creation time (debts/actions.ts, so a freshly-set-up debt payment shows
// up immediately, not after the next sync) and as a self-heal in
// matchDebtPayments below (so it also catches a bucket created/renamed
// after the fact).
export async function defaultDebtPaymentBucketId(householdId: string): Promise<string | null> {
  const billsBucket = await db.bucket.findFirst({
    where: { householdId, name: { equals: "Bills", mode: "insensitive" } },
    select: { id: true },
  });
  if (billsBucket) return billsBucket.id;

  const recurringBucket = await db.bucket.findFirst({
    where: { householdId, trackingMode: "RECURRING" },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });
  return recurringBucket?.id ?? null;
}

// Shared by matchDebtPayments/matchInstallmentPayments below — applies the
// same default-bucket self-heal (see defaultDebtPaymentBucketId) to
// whichever subset of DebtPayments (REVOLVING or INSTALLMENT) the caller
// already scoped its query to.
async function applyDefaultBucketIfMissing(
  householdId: string,
  debtPayments: { id: string; bucketId: string | null }[],
): Promise<void> {
  const missingBucket = debtPayments.filter((dp) => dp.bucketId === null);
  if (missingBucket.length === 0) return;
  const defaultBucketId = await defaultDebtPaymentBucketId(householdId);
  if (!defaultBucketId) return;
  await db.debtPayment.updateMany({
    where: { id: { in: missingBucket.map((dp) => dp.id) } },
    data: { bucketId: defaultBucketId },
  });
  for (const dp of missingBucket) dp.bucketId = defaultBucketId;
}

// The DebtPayment.hiddenFromBucket/Debt.hiddenAt counterpart to
// nextPaidOffDate (debt-payoff.ts) — called from every path that writes
// Debt.balanceCents (per-sync balance refresh, manual balance edit,
// installment terms, linking a synced account) so a household's "remove
// this" call (hideDebt, debts/actions.ts, which sets both flags together)
// automatically undoes itself the moment a new charge lands on a debt that
// had been sitting at $0, without needing a human to remember to re-add it.
// Scoped to the actual <=0 -> >0 transition, not just "is the new balance
// positive" — a household can now hide a still-owed debt too (hideDebt no
// longer requires balanceCents <= 0), and an unrelated balance change on
// one of those (500 -> 600, say) must never force-revive it against their
// wishes; only a debt that was genuinely paid off and then got a new
// charge should reappear on its own. A no-op updateMany when there's
// nothing currently hidden.
export async function unhideDebtPaymentIfBalanceReturned(
  debtId: string,
  oldBalanceCents: number,
  newBalanceCents: number,
  oldPaidOffDate?: Date | null,
): Promise<void> {
  if (newBalanceCents <= 0 || oldBalanceCents > 0) return;
  const unhiddenPayments = await db.debtPayment.updateMany({
    where: { debtId, hiddenFromBucket: true },
    data: { hiddenFromBucket: false },
  });
  const unhiddenDebt = await db.debt.updateMany({
    where: { id: debtId, hiddenAt: { not: null } },
    data: { hiddenAt: null },
  });
  // A debt that was sitting at $0 and just regained a balance needs its
  // "no minimum" call re-asked (see ignoreMinimumPayment on the Debt
  // model) too — this one's independent of whether the debt was ever
  // hidden (an ordinary tracked-but-no-minimum debt can hit this too), so
  // it doesn't factor into wasHidden below.
  await db.debt.updateMany({ where: { id: debtId, ignoreMinimumPayment: true }, data: { ignoreMinimumPayment: false } });

  // Only genuinely a "this was paid off and archived, and now isn't"
  // moment when something was actually hidden — both updateMany calls
  // above are harmless no-ops otherwise, but the push below wasn't
  // similarly gated, so it fired on every ordinary $0 -> positive
  // transition regardless (a routine autopay-then-new-purchase cycle on a
  // card that was never hidden at all), falsely claiming the debt "was
  // paid off" (real finding, 2026-09-14 code review).
  //
  // `wasHidden` alone missed the far more common case: a household that
  // never bothers hiding a paid-off debt (Sam's Club, live household data
  // 2026-09-25 — hiddenAt null, DebtPayment.hiddenFromBucket false, despite
  // paidOffDate genuinely set) got no notification either way once its
  // balance returned. `oldPaidOffDate` is a more direct signal for "was this
  // genuinely known paid off" than hiding ever was — it's the same field
  // notifyIfDebtJustPaidOff above and DEBT_BALANCE_PAID_OFF_REVIEW's manual
  // confirm both drive — and it doesn't reopen the 2026-09-14 false positive:
  // that one only ever fired because balanceCents briefly touched $0 with
  // nothing else true about it, and a debt that never previously turned
  // balanceCents<=0 into a real paidOffDate is exactly the case this stays
  // silent for, same as `wasHidden` already did.
  const wasHidden = unhiddenPayments.count > 0 || unhiddenDebt.count > 0;
  if (!wasHidden && oldPaidOffDate == null) return;

  // Household request, 2026-09-11: a heads-up the moment a paid-off debt
  // carries a real balance again — the reverse of DEBT_BALANCE_PAID_OFF_REVIEW's
  // "is this actually paid off?" nudge. Every caller of this function
  // (SimpleFIN sync, and every manual balance-edit action in
  // src/app/debts/actions.ts) already writes the new balanceCents to the DB
  // *before* calling this, so a fresh read here is always the real,
  // already-persisted current state.
  const debt = await db.debt.findUnique({
    where: { id: debtId },
    select: { name: true, householdId: true, account: { select: { displayName: true } } },
  });
  if (!debt) return;
  await sendPushToHouseholdForType(debt.householdId, "DEBT_BALANCE_RETURNED", {
    title: "This Debt Has a Balance Again",
    body: `${debtDisplayName(debt)} was paid off, but now shows ${formatCents(newBalanceCents)} owed.`,
    url: "/",
  });
}

// The synced-debt counterpart of DEBT_BALANCE_PAID_OFF_REVIEW. That review
// flow only ever fires for a *manual* revolving debt (matchDebtPayments'
// derivedBalanceCents branch below) — the whole point there is asking "is
// this calculated $0 real?" before writing it down. A SimpleFIN-synced
// debt's balance comes straight from the bank, so there's nothing to
// confirm, but that also meant it paid off with no notification at all —
// household report, 2026-09-25: "I've never received any for paying off
// Sam's [Club]." Reuses the same NotificationType (one household toggle
// covers debt-payoff news either way, matching DEBT_BALANCE_RETURNED already
// being the shared reverse case for both) with copy that states it rather
// than asking. Called from simplefin-sync.ts's per-account balance-update
// loop, alongside unhideDebtPaymentIfBalanceReturned above.
export async function notifyIfDebtJustPaidOff(
  debtId: string,
  oldBalanceCents: number,
  newBalanceCents: number,
): Promise<void> {
  if (newBalanceCents !== 0 || oldBalanceCents <= 0) return;
  const debt = await db.debt.findUnique({
    where: { id: debtId },
    select: { name: true, householdId: true, account: { select: { displayName: true } } },
  });
  if (!debt) return;
  await sendPushToHouseholdForType(debt.householdId, "DEBT_BALANCE_PAID_OFF_REVIEW", {
    title: "Debt Paid Off!",
    body: `${debtDisplayName(debt)} is paid off.`,
    url: "/",
  });
}

// The same real-world card/loan payment routinely posts TWICE — once as a
// positive debit leaving a depository account (checking/savings), once as a
// negative credit reducing the balance on the debt's own CREDIT_CARD/LOAN
// account (see the isLiabilityAccount branch under CARD_PAYMENT_MERCHANT_
// PATTERN, simplefin-sync.ts) — whenever both accounts are SimpleFIN-tracked.
// Real report, 2026-08-25: a household's Sam's Club card showed its balance
// updated but a just-made payment missing from "This cycle"/dashboard —
// turned out the card-side posting ("Credit Card Payment," -$200, card
// posts first) had synced days before its checking-side twin (+$200,
// settles ~2-3 days later), and every candidate query below only ever
// looked at amountCents > 0, so a solo card-side posting with no checking
// twin yet (or, per this household's live data, 9 of them going back to
// May) sat correctly tagged isTransfer/debtId but never actually linked.
// Loosening the sign filter alone would double-count once both sides
// exist — this filters a same-debt candidate pool down to one entry per
// real payment: a positive (depository) candidate always passes through
// unchanged (matches this engine's original single-sided behavior byte for
// byte when a checking twin exists); a negative (card/loan) candidate only
// passes through when NO opposite-sign, same-magnitude counterpart exists
// either among the current candidates or already linked to this
// DebtPayment from a prior sync — otherwise it's dropped, staying
// permanently unlinked (still correctly isTransfer:true, just never
// independently counted), exactly like the historical card-side orphans
// already were before this fix, just for the correct reason now.
const TWIN_WINDOW_DAYS = 10;

export async function filterDebtPaymentTwins<
  T extends { id: string; amountCents: number; occurredOn: Date; accountId: string | null },
>(
  debtPaymentId: string,
  candidates: T[],
  // The debt's own linked liability account, when it has one. A real payment
  // posts twice — a positive debit on checking and a negative credit on the
  // lender's own feed — and exactly one leg is kept. When one leg of a pair
  // sits on this account (the lender's own posting) it wins, because that's
  // the authoritative credit date (2-3 days ahead of the checking settlement,
  // and from the same feed as the balance). Otherwise the legacy tiebreak
  // (positive depository leg wins) stands. Omit for a debt with no synced
  // liability account.
  debtLinkedAccountId?: string | null,
): Promise<T[]> {
  if (candidates.length === 0) return candidates;

  const windowMs = TWIN_WINDOW_DAYS * DAY_MS;
  const isTwinPair = (a: { amountCents: number; occurredOn: Date }, b: { amountCents: number; occurredOn: Date }) =>
    a.amountCents === -b.amountCents && Math.abs(a.occurredOn.getTime() - b.occurredOn.getTime()) <= windowMs;

  const alreadyLinked = await db.transaction.findMany({
    where: { debtPaymentId },
    select: { amountCents: true, occurredOn: true },
  });

  const onLenderFeed = (t: T) => debtLinkedAccountId != null && t.accountId === debtLinkedAccountId;

  return candidates.filter((c) => {
    if (alreadyLinked.some((l) => isTwinPair(c, l))) return false; // its twin already recorded this payment
    const twin = candidates.find((o) => o.id !== c.id && isTwinPair(c, o));
    if (!twin) return true; // solo leg links regardless of sign
    // Twin pair present — exactly one leg survives (the branches are mutually
    // exclusive; the sign tiebreak resolves the neither/both cases).
    if (onLenderFeed(c) && !onLenderFeed(twin)) return true; // lender's own credit entry is authoritative
    if (onLenderFeed(twin) && !onLenderFeed(c)) return false;
    return c.amountCents > 0; // legacy tiebreak: depository leg wins
  });
}

// Last-resort candidate search for a cycle window that's otherwise about to
// be treated as unpaid — a synced transaction that never got auto-flagged as
// a transfer at all (isTransfer:false, debtId:null) but whose merchant text
// carries the debt's own linked account's lender name (Account.orgName).
// Exists because the *normal* transfer-detection in simplefin-sync.ts leans
// on seeing both legs of a transfer (the checking-side debit AND a matching
// credit on the debt's own linked account) to flag one confidently — a debt
// whose linked account never gets a transaction feed at all (common for loan
// servicers, which often report balance only — real case, 2026-08-26: Best
// Egg personal loan, zero synced transactions on the loan account itself,
// ever) can never produce that second leg, so its real checking-side payment
// sits misclassified as ordinary spend forever, no matter how long anything
// waits for it. Same "lender name is a real signal" idea as
// matchInstallmentPayments' own bnplKeyword fallback, generalized to
// REVOLVING debts. Links every qualifying match found (not just the first)
// and writes a MerchantRule off it so this same lender auto-matches on every
// future sync — one correction here should be the last time this debt ever
// needs it. Returns whatever it linked (empty array if nothing qualified).
//
// Deliberately excludes any transaction sitting on a CREDIT_CARD/LOAN
// account (the debt's own linked liability account included) — a genuine
// payment toward a debt always originates from where the household actually
// holds cash (checking/savings, or a manual no-account entry), never from
// the liability account's own feed. Without this, a brand-new debt added
// "at purchase" with its first payment not due for a month (household
// question, 2026-08-26) could wrongly match its own origination/annual fee
// — routinely posted under the lender's own name, right there on the new
// account — as if it were this cycle's payment, marking a genuinely unpaid
// fresh cycle "paid" before anything was ever actually sent.
// The amount floor for "does this transaction roughly cover the cycle
// amount" — cycleAmountCents/dp.amountCents minus tolerance, but clamped so
// tolerance can never eat more than half of it. amountToleranceCents has
// its own $5 floor, so a debt with a genuinely small minimum (a $3-7
// store-card payment) could otherwise see tolerance exceed the cycle
// amount outright, driving the floor to zero or negative and matching
// almost any same-lender transaction as "the payment" — the exact
// incident this clamp exists to prevent (real incident, 2026-09-11: a
// paid-off, no-minimum Sam's Club Mastercard swept in a genuine $15
// purchase at the warehouse club itself). Halving keeps a genuine partial-
// payment match (the actual reason this floor is looser than an exact
// match) while guaranteeing it's still a real discriminator. Every reader
// of a cycle/debt amount against a tolerance-widened floor goes through
// this one function — matchDebtPayments' own lender sweep and its
// linkedInSpan coverage check, and backfillDebtPaymentHistory's identical
// lender-sweep fallback — after the halving clamp was first introduced
// (2026-09-12) only in the first of those three and quietly missed the
// other two (real finding, 2026-09-14 code review).
function sweepAmountFloor(cycleAmountCents: number, tolerance: number): number {
  return cycleAmountCents - Math.min(tolerance, Math.floor(cycleAmountCents / 2));
}

async function linkUnclassifiedLenderPayments(householdId: string, debtId: string, orgName: string | null, since: Date, until: Date, minAmountCents: number) {
  const keyword = orgName?.trim().toLowerCase();
  if (!keyword || keyword.length < 3) return [];
  const unlinked = await db.transaction.findMany({
    where: {
      householdId,
      debtPaymentId: null,
      debtId: null,
      isTransfer: false,
      amountCents: { gte: minAmountCents },
      occurredOn: { gte: since, lt: until },
      merchant: { contains: keyword, mode: "insensitive" },
      OR: [{ accountId: null }, { account: { accountType: { notIn: ["CREDIT_CARD", "LOAN"] } } }],
    },
    orderBy: { occurredOn: "desc" },
  });
  if (unlinked.length === 0) return [];
  await db.transaction.updateMany({
    where: { id: { in: unlinked.map((t) => t.id) } },
    data: { debtId, isTransfer: true, bucketId: null, categoryId: null, isIncome: false },
  });
  // Skip the learned rule when the merchant text is a generic issuer payment
  // descriptor ("Capital One Credit Card Payment") — it names no specific
  // card, so a household with two cards at that issuer would have every one
  // of them (and an untracked spouse's card) misfiled onto this debt (real
  // incident, 2026-09-01). These stay attributed per-transaction instead.
  if (!isGenericCardPaymentDescriptor(unlinked[0].merchant)) {
    await upsertMerchantRule(
      householdId,
      unlinked[0].merchant,
      { bucketId: null, debtId, categoryId: null, isTransfer: true, isIncome: false },
      { confidence: 1, source: "USER" },
    );
  }
  return unlinked;
}

// Called once, immediately after a DebtPayment is first created with a
// confirmed due date (updateSyncedDebtTerms, upsertDebtPayment in
// debts/actions.ts) — without this, a payment that already happened
// *before* the tracker existed can never be found: matchDebtPayments' own
// sweep only ever looks forward from `dp.lastPaidDate ?? dp.createdAt`, so
// a household confirming terms today for a card whose current cycle was
// already paid (a real report, 2026-08-15 — a car loan showing "due next
// month" with no record the current month was paid) would sit with no
// `lastPaidDate` forever, even though the household typed the *next*
// unpaid due date exactly as this app's own nextDueDate convention asks
// for. Looks back exactly one cadence period before that entered due date
// — "this cycle" and no further, so it can't reach into an old, unrelated
// payment — for the closest already-synced, unlinked transfer toward this
// debt within the normal tolerance band. Deliberately does NOT roll
// `nextDueDate` again if it finds one: the household already typed the
// correct next-due date, so this only fills in the paid-history record
// behind it, exactly the way `matchDebtPayments` would have if it had
// existed at payment time.
export async function backfillDebtPaymentHistory(
  householdId: string,
  dp: {
    id: string;
    debtId: string;
    nextDueDate: Date;
    cadence: BillCadence;
    amountCents: number;
    amountDueCents: number;
    toleranceCents: number | null;
  },
): Promise<void> {
  const since = subtractCadence(dp.nextDueDate, dp.cadence);
  const tolerance = dp.toleranceCents ?? amountToleranceCents(dp.amountCents);
  const debt = await db.debt.findUnique({
    where: { id: dp.debtId },
    select: { accountId: true, ignoreMinimumPayment: true, account: { select: { orgName: true } } },
  });
  let rawCandidates = await db.transaction.findMany({
    where: {
      householdId,
      debtPaymentId: null,
      isTransfer: true,
      debtId: dp.debtId,
      amountCents: { not: 0 },
      occurredOn: { gte: since, lt: dp.nextDueDate },
      debtAmountReview: null,
    },
    orderBy: { occurredOn: "desc" },
  });

  // Nothing already tagged toward this debt in the lookback window — before
  // giving up, fall back to a lender-name search (linkUnclassifiedLenderPayments
  // above) in case the real payment is just sitting unclassified rather than
  // genuinely missing. Skipped for an ignoreMinimumPayment debt — same guard
  // matchDebtPayments' own lender sweep has (see its comment above): amountCents
  // is pinned at $0 for one, so sweepAmountFloor(0, tolerance) degenerates to
  // 0 and would sweep in any ordinary purchase at that lender as "the
  // payment" (real finding, 2026-09-22 code review — this fallback had the
  // same gap matchDebtPayments was already fixed for).
  if (rawCandidates.length === 0 && !debt?.ignoreMinimumPayment && dp.amountCents > 0) {
    const linked = await linkUnclassifiedLenderPayments(
      householdId,
      dp.debtId,
      debt?.account?.orgName ?? null,
      since,
      dp.nextDueDate,
      sweepAmountFloor(dp.amountCents, tolerance),
    );
    if (linked.length > 0) rawCandidates = linked;
  }

  const candidates = await filterDebtPaymentTwins(dp.id, rawCandidates, debt?.accountId ?? null);
  if (candidates.length === 0) return;
  const qualifying = candidates.filter((c) => Math.abs(c.amountCents) >= sweepAmountFloor(dp.amountCents, tolerance));
  if (qualifying.length === 0) return;

  // The earliest qualifying payment is the one that actually satisfied this
  // cycle's obligation — a household's extra/principal payment made *after*
  // the real minimum has already been covered doesn't un-satisfy it (fixed
  // 2026-08-16: originally picked whichever candidate's amount was closest
  // to expected, which mistakes "this cycle's payment" for "whichever
  // transaction happens to match the tracked dollar amount" — a real report,
  // Sam's Club: two earlier $200 extras (8/4, 8/10) plus an 8/13 $150
  // payment matching the tracked amount exactly meant lastPaidDate landed on
  // the 13th, when the 4th is what actually completed the cycle). Every
  // *other* candidate in the window still links too, not just this one — a
  // real gap otherwise: an extra/principal payment in the same
  // already-happened cycle was left completely unlinked here, invisible
  // everywhere, even though the ongoing sweep would have caught it fine.
  const earliestQualifying = qualifying.reduce((earliest, c) => (c.occurredOn < earliest.occurredOn ? c : earliest));

  await db.transaction.updateMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    data: { debtPaymentId: dp.id },
  });
  // Reduce the freshly-created amountDueCents by real money that already
  // moved toward *this* cycle — same as the ongoing sweep (matchDebtPayments)
  // would if it had been running back then; without it a tracker created for
  // a debt whose current cycle was already paid would still show its full
  // minimum as due. Only payments belonging to the cycle that ends at
  // nextDueDate count, though: when the household sets a tracker up with its
  // *next* (still-future) due date, the payment sitting one cadence back
  // belongs to the PRIOR, already-closed cycle — nextDueDate has correctly
  // rolled past it and amountDueCents must stay at the fresh minimum, not
  // drop to $0 (real report, 2026-08-30: Voyager / Amazon / PayPal trackers
  // each set up with next month's due date read "$0.00 owed" and vanished
  // from "this week's bills" the week their real payment actually came due).
  // A payment lands in "this cycle" when it's closer to nextDueDate than to
  // the prior due date (`since`).
  const cycleMidpointMs = (since.getTime() + dp.nextDueDate.getTime()) / 2;
  const thisCyclePaidCents = candidates
    .filter((c) => c.occurredOn.getTime() >= cycleMidpointMs)
    .reduce((s, c) => s + Math.abs(c.amountCents), 0);
  await db.debtPayment.update({
    where: { id: dp.id },
    data: {
      lastPaidDate: earliestQualifying.occurredOn,
      amountDueCents: Math.max(0, dp.amountDueCents - thisCyclePaidCents),
    },
  });
}

// "Which debt is the paydown plan currently attacking" — same attack-order
// notion payoff-planner.tsx computes client-side for its priority badge,
// re-derived here from the household's live saved settings (not gated on
// Household.payoffPlanEnabled, which only controls whether the plan's extra
// payments feed the dashboard/bucket projections — an attack order exists
// the moment there's more than one active debt, whether or not that toggle
// is on). Used by matchDebtPayments below to decide whether an out-of-band
// overpayment deserves a "did your minimum change?" prompt: the priority
// debt routinely gets extra thrown at it on purpose, so an oversized payment
// there is expected plan behavior, not a signal the tracked minimum changed.
// Null when there's nothing left to attack (no active included debts).
async function getPriorityDebtId(householdId: string): Promise<string | null> {
  const debts = await db.debt.findMany({
    where: { householdId, balanceCents: { gt: 0 }, includeInPayoffPlan: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, balanceCents: true, aprBasisPoints: true, minPaymentCents: true, debtType: true },
  });
  if (debts.length === 0) return null;
  const household = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { payoffOrder: true } });
  const order = computeAttackOrder(debts, household.payoffOrder as PayoffOrder);
  return order[0] ?? null;
}

// How many days past a due date matchDebtPayments waits before compounding
// it into the next cycle's amountDueCents — SimpleFIN routinely lags the
// real bank by "a few days" (see the maintainer notes' gas-utility/card entry,
// 2026-08-23) and never surfaces a still-pending transaction the bank's own
// site already shows, so a payment that's genuinely already made can easily
// not be visible here yet right on the due date. Doesn't delay a real
// payment from counting the moment it IS found, just the "assume it never
// happened" rollover.
const SYNC_LAG_GRACE_DAYS = 7;

// Runs every sync (see simplefin-sync.ts), alongside matchBillPayments.
// Rolling-balance model (2026-08-26 rework — household feedback: the old
// per-cycle catch-up loop, walking forward one cycle at a time waiting for
// a matching payment before advancing each one, "isn't realistic to how
// something is caught up," and real card statements don't work that way
// either). Now: nextDueDate always advances on schedule below, a new
// statement arriving whether or not the last one got paid, and
// DebtPayment.amountDueCents is one continuously-updated running total
// instead of N discrete per-cycle slots (see that field's schema comment).
// A missed cycle's shortfall just carries into the next cycle's
// amountDueCents — same "past due + new minimum" a real statement shows,
// compounding additively across however many cycles were missed in a row.
// Any real synced payment, full or partial, just subtracts from that
// running total directly — no tolerance-matching or "which cycle does this
// satisfy" bookkeeping anymore, since a partial payment is now just a
// normal partial reduction, not something that has to exactly clear a slot.
// REVOLVING only — see matchInstallmentPayments below for INSTALLMENT/BNPL,
// which still uses its own fixed-payment-count engine, unaffected by this.
//
// hiddenAt: null (2026-08-26 household feedback) — a hidden debt stops
// being matched/advanced entirely, not just hidden from the UI, the same
// way matchInstallmentPayments now does below. A synced debt's balance
// still keeps updating from the bank feed regardless (that's the separate
// balance-copy loop in simplefin-sync.ts, unaffected by this filter — see
// its own comment) and self-heals (un-hides) via
// unhideDebtPaymentIfBalanceReturned the moment a real balance shows up
// again; only THIS matching engine — the per-cycle minimum-payment ledger —
// pauses while hidden.
export async function matchDebtPayments(householdId: string): Promise<void> {
  const debtPayments = await db.debtPayment.findMany({
    where: { householdId, active: true, debt: { debtType: "REVOLVING", hiddenAt: null } },
  });
  if (debtPayments.length === 0) return;

  await applyDefaultBucketIfMissing(householdId, debtPayments);

  const now = new Date();
  const priorityDebtId = await getPriorityDebtId(householdId);
  // A debt flagged ignoreMinimumPayment tracks its amountCents at $0 on
  // purpose (see debtSetupReason) — the rolling total then simply never
  // grows (0 shortfall + $0 minimum, every cycle) and every real payment on
  // it counts as pure overpayment-on-a-fresh-cycle, so it's excluded from
  // the drift check below the same way it always was.
  const debtInfoById = new Map(
    (
      await db.debt.findMany({
        where: { id: { in: debtPayments.map((dp) => dp.debtId) } },
        select: {
          id: true,
          ignoreMinimumPayment: true,
          accountId: true,
          balanceCents: true,
          aprBasisPoints: true,
          account: { select: { orgName: true } },
        },
      })
    ).map((d) => [
      d.id,
      {
        ignoreMinimumPayment: d.ignoreMinimumPayment,
        orgName: d.account?.orgName ?? null,
        accountId: d.accountId,
        balanceCents: d.balanceCents,
        aprBasisPoints: d.aprBasisPoints,
      },
    ]),
  );

  for (const dp of debtPayments) {
    // Rollover pass — purely time-based, decoupled from any payment: every
    // due date that's already fully passed closes out and a new one opens,
    // carrying forward whatever's still unpaid (0 if the prior cycle was
    // covered) plus that new cycle's own regular minimum. Capped at
    // MAX_CATCHUP_CYCLES, same safety bound the old loop used, so a
    // years-stale tracker can't iterate unbounded — a household that far
    // behind has bigger problems than one more cycle's precision here.
    // Rolls over once the due date is SYNC_LAG_GRACE_DAYS behind today, not
    // the moment it passes — SimpleFIN itself lags the real bank by "a few
    // days" as a matter of course (see the maintainer notes' gas-utility/card entry,
    // 2026-08-23, and household report 2026-08-26: SimpleFIN also never
    // surfaces a still-pending transaction the bank's own site already
    // shows), so a payment that's genuinely already cleared or pending can
    // easily not be visible here yet on the due date itself. Rolling over
    // immediately would show a real, already-made payment as a carried-over
    // shortfall until the sync catches up days later. This grace only
    // delays *compounding* the shortfall/advancing the date — a real
    // payment found in the meantime (payment matching pass, below) still
    // applies against amountDueCents the instant it's found, same as ever.
    // Anchored to the household's local calendar day (todayAsUTCDate), not
    // `now` read via getUTC* — the latter is tomorrow's date after ~6pm here
    // (TZ=America/Denver), shaving a day off the grace window.
    const today = todayAsUTCDate(now);
    const rolloverCutoffUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - SYNC_LAG_GRACE_DAYS),
    );
    let nextDueDate = dp.nextDueDate;
    let amountDueCents = dp.amountDueCents;
    let lastPaidDateFromRollover = dp.lastPaidDate;
    const cycleAmountCents = dp.amountCents;
    const tolerance = dp.toleranceCents ?? amountToleranceCents(cycleAmountCents);
    const orgName = debtInfoById.get(dp.debtId)?.orgName ?? null;
    // Read early — needed here to gate linkUnclassifiedLenderPayments below,
    // and reused as-is further down where it also drives the drift check.
    const ignoreMinForSweep = debtInfoById.get(dp.debtId)?.ignoreMinimumPayment ?? false;

    // Every cycle boundary this rollover pass is about to walk, computed up
    // front (pure date math, no DB) — a years-stale tracker can run up to
    // MAX_CATCHUP_CYCLES iterations here, and querying the lender-name
    // fallback once per cycle would mean that many sequential round trips
    // for a single sync. One query across the whole combined span instead,
    // bucketed back into cycles below.
    const cycleBounds: { start: Date; due: Date }[] = [];
    // `walkDate` keeps its value after the loop — it's the first due date
    // still within the grace window (or in the future), i.e. the correct
    // post-rollover nextDueDate (see the write below).
    let walkDate = dp.nextDueDate;
    for (let i = 0; walkDate < rolloverCutoffUtc && i < MAX_CATCHUP_CYCLES; i++) {
      cycleBounds.push({ start: subtractCadence(walkDate, dp.cadence), due: walkDate });
      walkDate = nextBillDueDate(dp.cadence, walkDate, []);
    }
    // Before assuming any of these cycles went unpaid, two ways a real
    // payment for one can already be on file:
    //  1. sitting unclassified under the lender's name — the same gap
    //     backfillDebtPaymentHistory covers at creation time can just as
    //     easily hit an *already-tracked* debt every cycle afterward (a
    //     household whose "Best Egg"-style lender never posts literal "loan
    //     payment" text and whose own liability account never syncs a
    //     transaction feed): linkUnclassifiedLenderPayments below.
    //  2. already tagged to this debt on an earlier sync — linked straight
    //     to this tracker (debtPaymentId) or just to the debt (debtId,
    //     awaiting the payment-matching pass): `linkedInSpan` below.
    // (2) is what the first cut of this rollover missed: it consulted only
    // (1), so a cycle whose payment was matched on a *prior* sync looked
    // unpaid forever and re-added its whole minimum to amountDueCents on
    // every sync after — unbounded (real incident 2026-09-02: Personal loan
    // (9156), fully caught up, both real payments linked, amountDueCents
    // ballooned past $23k, one minimum per ~20-minute sync).
    // Skipped entirely for an ignoreMinimumPayment debt — cycleAmountCents
    // is pinned at $0 for one (see debtSetupReason), so there's no real
    // minimum to "catch up on" for a debt that intentionally tracks none.
    // Real incident, 2026-09-11: a paid-off, no-minimum Sam's Club
    // Mastercard swept in a genuine $15 debit-card *purchase* at the
    // co-branded warehouse club itself (merchant "Sam's Club", same text a
    // real payment would use) as a "payment," stripping its bucket/category
    // and crediting it toward the debt.
    //
    // The amount floor itself is clamped via sweepAmountFloor (see its own
    // comment) — a debt with a genuinely small minimum (a $3-7 store-card
    // payment) could otherwise see tolerance exceed cycleAmountCents
    // outright, driving the floor to zero or negative and reproducing the
    // exact same incident — this time for a *tracked* minimum, not the
    // ignoreMinimumPayment case above (real finding, 2026-09-12 code
    // review). Applied identically to both checks below (the lender-sweep
    // query and linkedInSpan's own coverage check) — the two used to apply
    // different floors here, an inconsistency a 2026-09-14 code review
    // caught.
    const lenderMatches =
      cycleBounds.length > 0 && !ignoreMinForSweep && cycleAmountCents > 0
        ? await linkUnclassifiedLenderPayments(
            householdId,
            dp.debtId,
            orgName,
            cycleBounds[0].start,
            cycleBounds[cycleBounds.length - 1].due,
            sweepAmountFloor(cycleAmountCents, tolerance),
          )
        : [];
    const linkedInSpan =
      cycleBounds.length > 0
        ? await db.transaction.findMany({
            where: {
              householdId,
              debtId: dp.debtId,
              isTransfer: true,
              occurredOn: { gte: cycleBounds[0].start, lt: cycleBounds[cycleBounds.length - 1].due },
            },
            select: { amountCents: true, occurredOn: true },
          })
        : [];
    for (const { start, due } of cycleBounds) {
      // Any payment landing in this cycle window that roughly covers the
      // minimum — a freshly-linked lender match, or one already on file from
      // a past sweep. Same tolerance band linkUnclassifiedLenderPayments
      // applies at the query level.
      const coveredBy = [
        ...lenderMatches.filter((t) => t.occurredOn >= start && t.occurredOn < due),
        ...linkedInSpan.filter(
          (t) =>
            t.occurredOn >= start &&
            t.occurredOn < due &&
            Math.abs(t.amountCents) >= sweepAmountFloor(cycleAmountCents, tolerance),
        ),
      ];
      if (coveredBy.length > 0) {
        // Advance lastPaidDateFromRollover to the LATEST payment seen across
        // every cycle walked so far, never backward — this loop runs oldest
        // cycle first, and a straight reassignment here used to overwrite a
        // later cycle's already-correct value with an earlier cycle's own
        // covering payment (or, within one cycle window that happens to
        // contain more than one real payment — routine for an
        // ignoreMinimumPayment card the household pays off ad hoc several
        // times a cycle — the *earliest* of that window's own payments, not
        // its latest). Real report, 2026-09-14: Sam's Club Card's tracker
        // stayed stuck on an Aug 21 payment through this every-sync
        // unconditional write (line ~880 below) even after real Sep 1/Sep 8
        // payments had already linked, hiding it from "Last Week's Bills"
        // (getDebtPaymentsThisWeek's own lastPaidDate-in-window check).
        for (const t of coveredBy) {
          if (lastPaidDateFromRollover === null || t.occurredOn > lastPaidDateFromRollover) {
            lastPaidDateFromRollover = t.occurredOn;
          }
        }
      } else {
        amountDueCents += cycleAmountCents;
      }
    }
    // Advance PAST every cycle just walked, to the first due date still
    // inside the grace window (or in the future) — the pre-refactor
    // `nextBillDueDate(...)` step. The build-then-consume refactor left this
    // pinned at the last *closed* cycle's own due date, so a debt whose due
    // date had slipped one grace window past never advanced and re-walked
    // (re-accrued) that same cycle on every subsequent sync (2026-09-02
    // incident above).
    if (cycleBounds.length > 0) nextDueDate = walkDate;

    // Only ever ask once per debt about a possible minimum change while
    // one's already pending — same "ask once" rule the rest of this file
    // uses everywhere. Doesn't block anything else below: real payments
    // keep applying against the running total regardless, this only
    // suppresses creating a second question.
    let hasPendingDriftReview = Boolean(await db.debtAmountReview.findFirst({ where: { debtPaymentId: dp.id } }));

    // Balance auto-derivation setup — manual (not synced-account) REVOLVING
    // debts only; a synced debt already gets balanceCents straight from the
    // bank feed (the balance-copy loop in simplefin-sync.ts, which runs
    // before matchDebtPayments/matchInstallmentPayments every sync — see
    // syncHousehold), and that real number always wins over an
    // approximation. Computed here (before the payment loop, not after) so
    // the "did your minimum change?" check below can tell a payment that
    // pays a debt off entirely from one that's merely a large-but-still-
    // owing overpayment — a debt that's done doesn't need its future
    // minimum re-confirmed. Interest accrues for every elapsed cycle up
    // front; each matched payment then subtracts from the running total as
    // it's applied in the loop below, so the eventual "current" figure is
    // exactly what the post-loop write uses.
    const debtMeta = debtInfoById.get(dp.debtId);
    const isManualRevolving = debtMeta !== undefined && debtMeta.accountId === null;
    let derivedBalanceCents = isManualRevolving && debtMeta!.balanceCents > 0 ? debtMeta!.balanceCents : null;
    if (derivedBalanceCents !== null) {
      // Once per distinct CALENDAR MONTH represented in cycleBounds, not
      // once per cycleBounds entry — a cycle is one occurrence of the
      // tracker's own cadence (BIWEEKLY/WEEKLY), so a stale tracker with a
      // non-monthly cadence used to compound a full monthlyRateOf tick 2-4x
      // too often per month walked (2026-09-11 fix — same root gap as
      // debt-payoff.ts's projectCyclePlan). cycleBounds is chronological, so
      // walking it and skipping a `due` date already counted for its own
      // month reduces to "once per calendar month," same as a real
      // statement cycle.
      let lastInterestMonthKey: number | null = null;
      for (const { due } of cycleBounds) {
        const monthKey = due.getUTCFullYear() * 12 + due.getUTCMonth();
        if (monthKey === lastInterestMonthKey) continue;
        lastInterestMonthKey = monthKey;
        derivedBalanceCents += Math.round(derivedBalanceCents * monthlyRateOf(debtMeta!.aprBasisPoints));
      }
    }

    // Payment matching pass — every real, not-yet-linked synced transfer
    // against this debt, oldest first, each one just subtracting from the
    // running total directly. No per-cycle window bookkeeping needed
    // anymore — a payment either reduces what's owed or it doesn't, same as
    // reading a real ledger. Still bounded to on-or-after this tracker's own
    // createdAt, though: unlike the old per-cycle window (which could never
    // reach further back than the cycle currently being walked), an
    // unbounded query here would also happily conscript a transaction that
    // predates this debt ever being tracked at all — a year-old synced
    // transfer sitting unlinked on the account, say — into "paying down"
    // a backlog that started accruing today. backfillDebtPaymentHistory
    // already handles the one real pre-creation case (this cycle's own
    // payment, made just before the household confirmed terms).
    const rawCandidates = await db.transaction.findMany({
      where: {
        householdId,
        debtPaymentId: null,
        isTransfer: true,
        debtId: dp.debtId,
        amountCents: { not: 0 },
        occurredOn: { gte: dp.createdAt },
        debtAmountReview: null,
      },
      orderBy: { occurredOn: "asc" },
    });
    const candidates = await filterDebtPaymentTwins(
      dp.id,
      rawCandidates,
      debtInfoById.get(dp.debtId)?.accountId ?? null,
    );

    let lastPaidDate = lastPaidDateFromRollover;
    for (const candidate of candidates) {
      const paymentAmount = Math.abs(candidate.amountCents);
      if (derivedBalanceCents !== null) derivedBalanceCents -= paymentAmount;
      // A debt this payment just paid off entirely doesn't need its future
      // minimum re-confirmed — only one of these two questions is relevant
      // once there's nothing left to pay (household feedback, 2026-08-26).
      // Manual debts use the running derivedBalanceCents computed above
      // (not yet floored/written — this is deliberately the raw, possibly-
      // negative projection); synced debts already have the real
      // post-payoff balance in debtMeta.balanceCents by this point (the
      // sync's balance-copy loop runs before this function).
      const debtNowPaidOff = isManualRevolving ? (derivedBalanceCents !== null && derivedBalanceCents <= 0) : debtMeta?.balanceCents === 0;
      // The only remaining "did your minimum change?" signal: a single
      // payment landing on an otherwise-fresh cycle (no carried-over
      // backlog) that's notably more than the tracked minimum — a genuine
      // partial/catch-up payment during a backlog is now just normal
      // rolling-balance behavior, not something to ask about. The opposite
      // direction (a calculated total that's too high — surplus applied,
      // household paying less than expected on purpose) has no automatic
      // prompt at all now; that's what the inline "Mark Caught Up" button
      // is for (settleDebtAmountDue, debts/actions.ts) — asking on every
      // partial payment during a backlog would be exactly the nag the
      // household pushed back on.
      const wasFreshCycle = amountDueCents === cycleAmountCents;
      const overpaid = paymentAmount > cycleAmountCents + tolerance;

      await db.transaction.update({ where: { id: candidate.id }, data: { debtPaymentId: dp.id } });
      lastPaidDate = candidate.occurredOn;
      amountDueCents = Math.max(0, amountDueCents - paymentAmount);

      if (wasFreshCycle && overpaid && dp.debtId !== priorityDebtId && !hasPendingDriftReview && !ignoreMinForSweep && !debtNowPaidOff) {
        // Kept from the old cycleAlreadyAdvanced:true branch — an
        // out-of-band overpayment on a debt the plan isn't currently
        // targeting is worth asking about (the priority debt routinely
        // gets extra thrown at it on purpose, so an oversized payment there
        // is expected plan behavior, not a signal the tracked minimum
        // changed). Never blocks anything — the payment above already
        // applied regardless — only asks whether amountCents itself should
        // follow suit for future cycles.
        await db.debtAmountReview.create({
          data: {
            householdId,
            debtPaymentId: dp.id,
            transactionId: candidate.id,
            observedAmountCents: paymentAmount,
            expectedAmountCents: cycleAmountCents,
            cycleAlreadyAdvanced: true,
          },
        });
        hasPendingDriftReview = true;
        const debt = await db.debt.findUnique({
          where: { id: dp.debtId },
          select: { name: true, account: { select: { displayName: true } } },
        });
        await sendPushToHouseholdForType(householdId, "DEBT_AMOUNT_REVIEW", {
          title: "Did your minimum payment change?",
          body: `${debt ? debtDisplayName(debt) : "A debt"}: expected ${formatCents(cycleAmountCents)}, saw ${formatCents(paymentAmount)} instead.`,
          url: "/",
        });
      }
    }

    // Balance auto-derivation write — derivedBalanceCents was computed
    // above (before the payment loop) and decremented per matched payment
    // inside it; skipped entirely once already at $0 — nothing to derive,
    // and re-entering here every sync after a confirmed payoff would just
    // recreate the review row forever (see DebtBalanceReview's own comment
    // for why creation is gated on the >0 -> <=0 transition, not "is it
    // currently <=0").
    if (isManualRevolving && derivedBalanceCents !== null && derivedBalanceCents !== debtMeta!.balanceCents) {
      if (derivedBalanceCents > 0) {
        await db.debt.update({ where: { id: dp.debtId }, data: { balanceCents: derivedBalanceCents } });
      } else {
        // Computed paid off — don't write balanceCents down to 0 yet (that
        // alone is what the UI treats as "Paid Off" everywhere, see
        // debt-row.tsx's `paidOff` derivation), and don't stamp paidOffDate
        // either. Frozen at its last value until a human confirms via
        // confirmDebtBalancePaidOff/declineDebtBalancePaidOff
        // (src/app/debts/actions.ts) — the interest-accrual approximation
        // landing on exactly $0 doesn't mean the real-world balance did.
        const hasPendingBalanceReview = Boolean(await db.debtBalanceReview.findFirst({ where: { debtId: dp.debtId } }));
        if (!hasPendingBalanceReview) {
          await db.debtBalanceReview.create({ data: { householdId, debtId: dp.debtId } });
          const debt = await db.debt.findUnique({
            where: { id: dp.debtId },
            select: { name: true, account: { select: { displayName: true } } },
          });
          await sendPushToHouseholdForType(householdId, "DEBT_BALANCE_PAID_OFF_REVIEW", {
            title: "Is this debt paid off?",
            body: `${debt ? debtDisplayName(debt) : "A debt"}'s calculated balance just hit $0.`,
            url: "/",
          });
        }
      }
    }

    await db.debtPayment.update({
      where: { id: dp.id },
      data: { nextDueDate, amountDueCents, lastPaidDate },
    });
  }
}

export type AccountedForCandidate = {
  id: string;
  merchant: string;
  amountCents: number;
  occurredOn: string; // ISO date
  bucketName: string | null;
};

// A return/reimbursement's window (see SUGGESTION_WINDOW_DAYS,
// reimbursements.ts) doesn't apply here — this is the same idea inverted (a
// payment "accounted for" by a purchase instead of a credit reimbursed by a
// debit), so the same generous window makes sense for the same reason: a
// household might not pay off a purchase for weeks.
const ACCOUNTED_FOR_WINDOW_DAYS = 45;

// Suggestions for the "already accounted for" per-payment linker
// (DebtPaymentRow) — the inverse of getReimbursementSuggestions
// (reimbursements.ts): instead of a refund credit pointing at the debit it
// pays back, a debt-payment debit points at the specific already-bucketed
// purchase debit it's paying off. Candidates are scoped to the *same synced
// account as the debt itself* — this only ever makes sense for "the
// purchase that's on this same card" (see WORKING_ON.md's Sam's Club
// example) — with a bucketId already set (must already be real counted
// spend; otherwise there's nothing to avoid double-counting against).
// How many of these run at once — bounded the same way simplefin-sync.ts
// bounds its own per-row DB work (mapConcurrent), so a page with a lot of
// unmatched payments doesn't fire that many concurrent queries at once and
// risk exhausting Postgres's connection pool.
const ACCOUNTED_FOR_CONCURRENCY = 8;

export async function getAccountedForSuggestions(
  householdId: string,
  // alreadyLinkedCents: the net sum of whatever this payment is already
  // matched to (0 for an untouched payment) — candidates rank against what's
  // still unexplained, not the payment's full amount, so a payment already
  // matched to one purchase gets sensible suggestions for a *second* one
  // (e.g. a $248.81 payment with $176.56 already linked ranks candidates
  // against the remaining $72.25, not the full $248.81).
  payments: { id: string; debtId: string; amountCents: number; occurredOn: Date; alreadyLinkedCents: number }[],
): Promise<Record<string, AccountedForCandidate[]>> {
  if (payments.length === 0) return {};

  const debtIds = [...new Set(payments.map((p) => p.debtId))];
  const debts = await db.debt.findMany({ where: { id: { in: debtIds } }, select: { id: true, accountId: true } });
  const accountIdByDebtId = new Map(debts.map((d) => [d.id, d.accountId]));

  const result: Record<string, AccountedForCandidate[]> = {};
  for (const p of payments) result[p.id] = [];

  // One query per payment, its own tight ±45-day window — not one shared
  // query per account covering the whole group's combined date range. That
  // grouped version (2026-09-12 perf pass) ordered by occurredOn desc with
  // one take cap shared across the group; a cluster of recent transactions
  // could fill the cap before an older payment's own window was ever
  // considered, silently returning it an empty/degraded suggestion list
  // even though real candidates existed further back (real finding,
  // 2026-09-12 code review — the fix that introduced the bug and the review
  // that caught it landed the same day). Running these concurrently
  // (mapConcurrent, not a sequential loop) keeps the original perf win —
  // this was never about the query being merged, only about not paying for
  // N round trips one at a time — while restoring the exact per-payment
  // correctness the pre-refactor per-payment query had.
  await mapConcurrent(payments, ACCOUNTED_FOR_CONCURRENCY, async (p) => {
    const accountId = accountIdByDebtId.get(p.debtId);
    if (!accountId) return;

    const windowStart = new Date(p.occurredOn.getTime() - ACCOUNTED_FOR_WINDOW_DAYS * DAY_MS);
    const windowEnd = new Date(p.occurredOn.getTime() + ACCOUNTED_FOR_WINDOW_DAYS * DAY_MS);
    // Math.abs(p.amountCents): the debt-payment leg can be the lender-feed
    // credit (negative) — see filterDebtPaymentTwins.
    const targetCents = Math.max(Math.abs(p.amountCents) - p.alreadyLinkedCents, 0);

    const purchases = await db.transaction.findMany({
      where: {
        householdId,
        accountId,
        bucketId: { not: null },
        amountCents: { gt: 0 },
        occurredOn: { gte: windowStart, lte: windowEnd },
        // A purchase already claimed by another payment (see
        // accountedForByLinks' back-relation) can't also be suggested here —
        // each purchase is only ever "already accounted for" once, so a $150
        // purchase already linked to one card payment shouldn't also show up
        // as a candidate for a different one.
        accountedForByLinks: { none: {} },
      },
      orderBy: { occurredOn: "desc" },
      take: 200,
      select: { id: true, merchant: true, occurredOn: true, bucket: { select: { name: true } }, ...SPEND_TX_SELECT },
    });

    // Ranked (and shown) by *net* amount — a purchase with its own linked
    // refund should read and rank at what it actually cost, not its gross
    // charge (household report, 2026-09-24: a $185.28 Sam's Club purchase
    // with an $8.72 refund needed to rank as $176.56 to make sense against a
    // $248.81 payment split across two purchases).
    result[p.id] = purchases
      .map((d) => ({ ...d, netCents: netChargeCents(d) }))
      .sort((a, b) => Math.abs(a.netCents - targetCents) - Math.abs(b.netCents - targetCents))
      .slice(0, 5)
      .map((d) => ({
        id: d.id,
        merchant: d.merchant,
        amountCents: d.netCents,
        occurredOn: d.occurredOn.toISOString().slice(0, 10),
        bucketName: d.bucket?.name ?? null,
      }));
  });

  return result;
}

// Position of each given transaction within its BNPL plan's schedule —
// "this charge is payment 3" — computed as its 1-based rank among that
// plan's linked installment payments in date order. Only transactions
// linked to an INSTALLMENT DebtPayment get an entry; everything else is
// simply absent from the returned map. Feeds installmentDisplayTitle
// (src/lib/transaction-display.ts) so the /transactions row title reads
// "<plan name> 3/6" instead of the opaque per-charge bank descriptor.
//
// Ranks against the FULL set of the plan's linked payments (not just the
// page's visible slice), so payment 3 still reads "3/6" on a page that
// doesn't also show payments 1 and 2. Same (occurredOn, createdAt, id)
// ordering the /transactions ledger itself uses, so the numbering matches
// the visible chronological order exactly.
export async function installmentNumbersForTransactions(
  householdId: string,
  transactionIds: string[],
): Promise<Map<string, number>> {
  const numbers = new Map<string, number>();
  if (transactionIds.length === 0) return numbers;

  const linked = await db.transaction.findMany({
    where: {
      id: { in: transactionIds },
      debtPaymentId: { not: null },
      debt: { debtType: "INSTALLMENT" },
    },
    select: { debtPaymentId: true },
  });
  const debtPaymentIds = [...new Set(linked.map((t) => t.debtPaymentId).filter((id): id is string => id !== null))];
  if (debtPaymentIds.length === 0) return numbers;

  const allPayments = await db.transaction.findMany({
    where: { householdId, debtPaymentId: { in: debtPaymentIds }, amountCents: { gt: 0 } },
    select: { id: true, debtPaymentId: true },
    orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const wanted = new Set(transactionIds);
  const seen = new Map<string, number>();
  for (const t of allPayments) {
    const n = (seen.get(t.debtPaymentId!) ?? 0) + 1;
    seen.set(t.debtPaymentId!, n);
    if (wanted.has(t.id)) numbers.set(t.id, n);
  }
  return numbers;
}

// The INSTALLMENT/BNPL counterpart to matchDebtPayments (2026-08-16) — runs
// every sync (see simplefin-sync.ts) and once synchronously right after a
// new INSTALLMENT DebtPayment is created (see createDebt/updateInstallmentTerms
// in debts/actions.ts), so a freshly-tracked plan's already-happened
// installments backfill immediately instead of waiting for the next sync.
// Diverges from matchDebtPayments enough to need its own engine: a plan has
// a *fixed* payment count (not "rolls forward forever"), its amount is set
// by contract rather than a drifting minimum (so no DebtAmountReview — an
// out-of-tolerance candidate just stays unmatched for a human to sort out
// via /transactions, same as any other unexplained spend), and it matches
// one cycle at a time in date order (like matchBillPayments' catch-up loop)
// rather than bulk-linking every qualifying candidate in one pass — a
// backfill from purchaseDate can easily contain several already-happened,
// individually-distinct installments that each need their own decrement,
// not one shared lastPaidDate.
//
// hiddenAt: null (2026-08-26 household feedback) — once a BNPL plan is paid
// off and hidden, it's genuinely done: unlike a synced revolving debt,
// there's no live account balance to keep watching, so a new charge from
// the same merchant later is a new plan, not a continuation of this one.
// Matching stops the moment it's hidden rather than continuing to run
// (and potentially self-heal/un-hide it) in the background forever — see
// matchDebtPayments' own comment above for the synced-debt contrast.
export async function matchInstallmentPayments(householdId: string): Promise<void> {
  const debtPayments = await db.debtPayment.findMany({
    where: { householdId, active: true, debt: { debtType: "INSTALLMENT", hiddenAt: null } },
    include: {
      debt: {
        select: {
          id: true,
          name: true,
          bnplKeyword: true,
          installmentsRemaining: true,
          installmentsTotal: true,
          purchaseDate: true,
          balanceCents: true,
          paidOffDate: true,
        },
      },
      payments: { select: { merchant: true } },
    },
  });
  if (debtPayments.length === 0) return;

  await applyDefaultBucketIfMissing(householdId, debtPayments);
  const bnplKeywords = await allBnplKeywords(householdId);

  type MatchState = {
    tolerance: number;
    cursor: Date;
    installmentsRemaining: number;
    // Null only for a legacy plan created before totalPayments was captured
    // at setup — those keep the old always-approximate behavior below since
    // there's no way to tell installment 2 apart from installment 5.
    installmentsTotal: number | null;
    balanceCents: number;
    paidOffDate: Date | null;
    nextDueDate: Date;
    lastPaidDate: Date | null;
    matchedAny: boolean;
    // Whether nextDueDate above should read as confirmed rather than "~"
    // approximate — see the comment where this is written back, below.
    dueDateLocked: boolean;
    // A plan's very first purchase-triggering charge routinely syncs in
    // *before* the household ever gets around to tracking it as a debt —
    // by then, categorizeUncategorizedTransactions (simplefin-sync.ts) has
    // already seen it once, found no matching Debt yet, and moved on;
    // nothing ever revisits it afterward (its own candidate query only
    // looks at isTransfer:false rows, and this one's stuck isTransfer:true
    // with no debtId — real reports, 2026-08-16 GlassesUSA and 2026-08-17
    // Nike, both sitting unmatched with the "Overdue" badge never clearing
    // because there was nothing left to ever link them). So the candidate
    // search below also accepts an unlinked (debtId: null) transaction
    // whose merchant text still carries this debt's own BNPL keyword — the
    // same substring check simplefin-sync.ts's sync-time categorizer uses.
    bnplKeyword: string | undefined;
    // A plan whose real charges don't carry any BNPL keyword at all — real
    // report, 2026-08-20: a household's PayPal Credit installments post as
    // bare "PayPal", textually identical to a normal PayPal payment, so
    // there's no keyword to match on going in. But once at least one real
    // payment is linked (by the manual /transactions assignment this same
    // limitation forces the first time), that payment's own merchant text
    // *is* a known-good signal for every installment after it — the same
    // provider always posts the same way. Learned fresh each sweep from
    // whatever's actually linked so far, not stored, so it strengthens
    // automatically as more installments confirm the pattern.
    knownMerchants: string[];
  };
  const active = new Map<string, MatchState>();
  for (const dp of debtPayments) {
    // Already paid off — nothing left to match. installmentsRemaining is
    // only ever null for a legacy INSTALLMENT debt from before this tracker
    // existed (see WORKING_ON.md); skip those too rather than divide by an
    // unknown remaining count.
    if (dp.debt.installmentsRemaining === null || dp.debt.installmentsRemaining <= 0) continue;
    active.set(dp.id, {
      tolerance: dp.toleranceCents ?? 10, // ~$0.10 default — see the schema comment on DebtPayment
      cursor: dp.lastPaidDate ?? dp.debt.purchaseDate ?? dp.createdAt,
      installmentsRemaining: dp.debt.installmentsRemaining,
      installmentsTotal: dp.debt.installmentsTotal,
      balanceCents: dp.debt.balanceCents,
      paidOffDate: dp.debt.paidOffDate,
      nextDueDate: dp.nextDueDate,
      lastPaidDate: dp.lastPaidDate,
      matchedAny: false,
      dueDateLocked: false,
      bnplKeyword: resolveBnplKeyword(dp.debt, bnplKeywords),
      knownMerchants: [...new Set(dp.payments.map((p) => p.merchant.trim().toLowerCase()).filter(Boolean))],
    });
  }

  // Round-robin, one candidate claim per tracker per pass, instead of each
  // DebtPayment fully draining its own installmentsRemaining against the
  // shared candidate pool before its sibling gets a turn — real report,
  // 2026-08-17: two simultaneous, genuinely identical Afterpay plans (same
  // amount/cadence/purchase date, so their real charges are indistinguishable
  // transaction-for-transaction) where the first plan was tracked days before
  // the second existed, so its own backfill sweep greedily claimed 4 of the
  // 6 real charges that should have split 3/3 — the first debt read "paid
  // off" while the second sat $100 (2 unmatched payments) short of reality.
  // A plain per-debt while-loop can't fix that even with both plans tracked
  // at once, since whichever one is processed first in the outer loop still
  // drains the pool before the next gets to look — this has to interleave.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const dp of debtPayments) {
      const s = active.get(dp.id);
      if (!s || s.installmentsRemaining <= 0) continue;

      const candidate =
        // Exact debtId match, queried alone — unambiguous (this transaction
        // was already specifically attributed to this debt, e.g. by
        // categorizeUncategorizedTransactions' resolveBnplDebtId), so it
        // must never be shadowed by an earlier same-keyword transaction
        // that actually belongs to a *different* (possibly still-untracked)
        // plan from the same provider. Real report, 2026-08-24: an
        // unrelated, not-yet-tracked Klarna plan's own charge (debtId: null)
        // landed between Nike's cursor and its real next payment — being
        // earlier and also matching the fuzzy keyword-fallback branch below,
        // it used to win when both branches were queried together via one
        // `orderBy: occurredOn asc`, got rejected on amount tolerance, and
        // silently blocked Nike's tracker forever (a tolerance rejection
        // skips this whole pass rather than trying the next candidate).
        // Querying the unambiguous branch on its own first means an already
        // debtId-tagged payment is found (or fails tolerance) on its own
        // merit, never masked by a same-keyword stranger.
        (await db.transaction.findFirst({
          where: {
            householdId,
            debtPaymentId: null,
            debtId: dp.debtId,
            isTransfer: true,
            amountCents: { gt: 0 },
            occurredOn: { gte: s.cursor },
          },
          orderBy: { occurredOn: "asc" },
        })) ??
        (s.bnplKeyword
          ? await db.transaction.findFirst({
              where: {
                householdId,
                debtPaymentId: null,
                debtId: null,
                isTransfer: true,
                amountCents: { gt: 0 },
                occurredOn: { gte: s.cursor },
                merchant: { contains: s.bnplKeyword, mode: "insensitive" as const },
              },
              orderBy: { occurredOn: "asc" },
            })
          : null) ??
        // Fallback for a plan with no BNPL keyword to go on at all (bare
        // "PayPal", see knownMerchants above) — merchant text alone isn't
        // unique enough to trust unbounded the way a real keyword is, so
        // this path also caps how far past the expected due date it'll
        // reach, on top of the tight amount tolerance already enforced
        // below. Tried last, only when neither branch above found anything,
        // so it never overrides a more certain match.
        (s.knownMerchants.length > 0
          ? await db.transaction.findFirst({
              where: {
                householdId,
                debtPaymentId: null,
                debtId: null,
                isTransfer: true,
                amountCents: { gt: 0 },
                occurredOn: { gte: s.cursor, lte: nextBillDueDate(dp.cadence, s.nextDueDate, []) },
                OR: s.knownMerchants.map((m) => ({ merchant: { equals: m, mode: "insensitive" as const } })),
              },
              orderBy: { occurredOn: "asc" },
            })
          : null);
      // Nothing found, or the nearest candidate misses the tight tolerance
      // band — stop here rather than skipping ahead to a later transaction,
      // which could link installments out of date order. Left for the next
      // sync, or a human via /transactions.
      if (!candidate || Math.abs(candidate.amountCents - dp.amountCents) > s.tolerance) continue;

      await db.transaction.update({ where: { id: candidate.id }, data: { debtPaymentId: dp.id, debtId: dp.debtId } });
      progressed = true;
      s.matchedAny = true;
      s.installmentsRemaining -= 1;
      const newBalanceCents = dp.amountCents * s.installmentsRemaining;
      s.paidOffDate = nextPaidOffDate(s.balanceCents, newBalanceCents, s.paidOffDate);
      s.balanceCents = newBalanceCents;
      s.lastPaidDate = candidate.occurredOn;
      // Anchored to the real payment date just matched, not the previous
      // *scheduled* nextDueDate — a BNPL plan's first installment fires at
      // purchase while the rest snap to the provider's real billing cycle,
      // so the gap from installment 1 to 2 is routinely longer than every
      // gap after it. Advancing off the stale schedule compounds that first
      // error forever; advancing off the actual date self-corrects as soon
      // as the next real payment posts (confirmed against this household's
      // real Nike Klarna plan, 2026-08-20: purchased Aug 3, 1st payment Aug
      // 5, but the 2nd/3rd/4th real payments land Aug 21/Sep 4/Sep 18 —
      // exactly 14 days apart from each other despite the irregular start).
      s.nextDueDate = nextBillDueDate(dp.cadence, candidate.occurredOn, []);
      s.cursor = candidate.occurredOn;
      // Installment 1's real date is routinely off-cadence from the rest
      // (see comment above), so the date projected right after it — for
      // installment 2 — stays approximate. But installment 2's own real
      // date confirms the provider's actual steady-state cadence (the same
      // Nike Klarna example: 2nd/3rd/4th real payments land exactly 14 days
      // apart), so every projection after that is trustworthy. Household
      // feedback, 2026-09-09: only the 2nd payment should ever show "~".
      const paidCount = s.installmentsTotal === null ? null : s.installmentsTotal - s.installmentsRemaining;
      s.dueDateLocked = paidCount !== null && paidCount >= 2;
    }
  }

  for (const dp of debtPayments) {
    const s = active.get(dp.id);
    if (!s) continue;
    // dueDateLocked is recomputed here from the *current* paidCount every
    // sweep, not only inside the match loop above — a plan whose 2nd (or
    // later) installment already matched on some earlier sweep, before this
    // paidCount>=2 rule existed, would otherwise sit stuck on whatever
    // dueDateLocked an old sweep wrote and never self-heal, since matchedAny
    // only goes true again on a *new* real payment (real case, 2026-09-09:
    // Affirm - Dick's, 3 of 4 installments already matched, still showing
    // "~Sep 15" because nothing new matched this sweep to trigger the write).
    const paidCount = s.installmentsTotal === null ? null : s.installmentsTotal - s.installmentsRemaining;
    const dueDateLocked = paidCount !== null && paidCount >= 2;
    if (s.matchedAny) {
      await db.debtPayment.update({
        where: { id: dp.id },
        data: {
          lastPaidDate: s.lastPaidDate,
          nextDueDate: s.nextDueDate,
          // s.nextDueDate above is a projection (last real installment's date +
          // cadence, see its own comment) — never a confirmed date, since Flow
          // has no way to see a BNPL provider's actual future schedule (only
          // posted transactions, via SimpleFIN). dueDateLocked drives the "~"
          // approximate marker debt-row.tsx already shows for a REVOLVING
          // debt's inferred due date. Real report, 2026-09-07: Klarna - Puma's
          // 2nd installment showed a confident Sep 3 when the real charge — per
          // Klarna's own schedule — was Sep 11, because installment 1 -> 2
          // gaps routinely miss the plan's steady-state cadence. But that same
          // plan's later gaps land exactly on schedule every time, so paidCount
          // above only keeps this unlocked for the one projection that's
          // actually unreliable — the date projected right after installment 1
          // posts. Everything projected once installment 2 or later has
          // posted is locked, since by then the real cadence is established.
          dueDateLocked,
        },
      });
      await db.debt.update({
        where: { id: dp.debtId },
        data: { installmentsRemaining: s.installmentsRemaining, balanceCents: s.balanceCents, paidOffDate: s.paidOffDate },
      });
    } else if (dueDateLocked !== dp.dueDateLocked) {
      await db.debtPayment.update({ where: { id: dp.id }, data: { dueDateLocked } });
    }
  }
}

// The single per-debt "needs setup" predicate — REVOLVING only. An
// INSTALLMENT/BNPL plan can carry a DebtPayment too now (2026-08-16, see
// matchInstallmentPayments above), but it has no equivalent "needs setup"
// concept: purchase date/cadence/payment amount are all required at
// creation (createDebt), so there's nothing left unconfirmed the way a
// bare-quick-created REVOLVING debt or an unlocked due date can leave
// behind. Shared by /debts (debts/page.tsx) and Account
// Settings (settings/simplefin/page.tsx) so the two can't drift the way they
// did until 2026-08-16: Settings' copy never checked for a pending
// DebtAmountReview at all, so a debt with a pending "did your minimum
// change?" question showed as fully confirmed there while /debts (and the
// nav badge, hasDebtsNeedingAttention below) correctly flagged it — real
// report, a synced card that looked done in Settings but amber on /debts.
// `dueDateLocked` is `null` when the debt has no DebtPayment tracker at all
// yet (same as "not locked").
export function debtNeedsSetup(
  debt: {
    debtType: "REVOLVING" | "INSTALLMENT";
    termsConfirmed: boolean;
    balanceCents: number;
    minPaymentCents: number;
    ignoreMinimumPayment: boolean;
  },
  dueDateLocked: boolean | null,
  hasPendingReview: boolean,
): boolean {
  return debtSetupReason(debt, dueDateLocked, hasPendingReview) !== null;
}

// The dashboard filters this one out of its "Debts Need Setup" card — the
// pending DebtAmountReview already has its own "Needs a Quick Confirm" card
// there, with the actual yes/no buttons (household report, 2026-10-05: the
// same minimum-change question showed up twice).
export const PENDING_REVIEW_SETUP_REASON = "Confirm minimum payment change";

// The specific reason a debt fails debtNeedsSetup, in the same priority
// order — settings/simplefin/page.tsx used to compute its own copy of this
// message inline, which is exactly what drifted out of sync with this
// function once before (see the comment above); this is the one place the
// message and the boolean can't disagree.
export function debtSetupReason(
  debt: {
    debtType: "REVOLVING" | "INSTALLMENT";
    termsConfirmed: boolean;
    balanceCents: number;
    minPaymentCents: number;
    ignoreMinimumPayment: boolean;
  },
  dueDateLocked: boolean | null,
  hasPendingReview: boolean,
): string | null {
  if (debt.debtType !== "REVOLVING") return null;
  if (!debt.termsConfirmed) return "Add APR/minimum payment";
  // A $0 minimum was legitimate while the balance was $0 but is stale now
  // that it isn't — see the hasDebtsNeedingAttention comment for why
  // nothing else would ever catch this. Same rule that badge uses.
  // Skipped once the household has explicitly said this debt has no real
  // minimum (ignoreMinimumPayment) — a card can genuinely carry a balance
  // with no minimum on file. That flag is cleared the next time the
  // balance returns from $0 (unhideDebtPaymentIfBalanceReturned), so a
  // paid-off card that racks up a new charge gets asked again.
  if (debt.balanceCents > 0 && debt.minPaymentCents === 0 && !debt.ignoreMinimumPayment) return "Confirm minimum payment";
  if (!dueDateLocked) return "Add a due date";
  if (hasPendingReview) return PENDING_REVIEW_SETUP_REASON;
  return null;
}

// SuggestionDismissal.key for the "needs setup" banner — keyed on the debt
// plus the specific reason text, so fixing the flagged field (or the
// underlying condition changing to a different reason) naturally
// un-dismisses it instead of silently reusing a stale dismissal for a
// now-different problem.
export function debtSetupDismissKey(debtId: string, reason: string): string {
  return `${debtId}:${reason}`;
}

export type DebtNeedingSetup = { id: string; name: string; reason: string };

// Aggregate counterpart to debtNeedsSetup/debtSetupReason above, filtered
// through a per-debt-per-reason dismissal the same way
// getActiveInsufficientMinimumDebts handles the min-payment banner: dismiss
// silences it until the debt's next billing cycle starts, then it
// re-evaluates and comes back if the underlying problem is still there. A
// debt with no DebtPayment yet (terms never confirmed at all, so there's no
// cadence to anchor a cycle to) falls back to a flat 30-day snooze instead.
export async function getActiveDebtsNeedingSetup(householdId: string): Promise<DebtNeedingSetup[]> {
  const debts = await db.debt.findMany({
    where: { householdId, debtType: "REVOLVING" },
    select: {
      id: true,
      name: true,
      debtType: true,
      termsConfirmed: true,
      balanceCents: true,
      minPaymentCents: true,
      ignoreMinimumPayment: true,
      account: { select: { displayName: true } },
    },
  });
  if (debts.length === 0) return [];

  const [payments, pendingReviews, dismissals] = await Promise.all([
    db.debtPayment.findMany({
      where: { householdId, debtId: { in: debts.map((d) => d.id) }, active: true },
      select: { debtId: true, dueDateLocked: true, nextDueDate: true, cadence: true },
    }),
    db.debtAmountReview.findMany({
      where: { householdId },
      select: { debtPayment: { select: { debtId: true } } },
    }),
    db.suggestionDismissal.findMany({
      where: { householdId, kind: "DEBT_NEEDS_SETUP" },
      select: { key: true, createdAt: true },
    }),
  ]);
  const paymentByDebtId = new Map(payments.map((p) => [p.debtId, p]));
  const debtIdsWithPendingReview = new Set(pendingReviews.map((r) => r.debtPayment.debtId));
  const dismissedAtByKey = new Map(dismissals.map((d) => [d.key, d.createdAt]));

  const flagged: DebtNeedingSetup[] = [];
  for (const d of debts) {
    const payment = paymentByDebtId.get(d.id);
    const reason = debtSetupReason(d, payment?.dueDateLocked ?? null, debtIdsWithPendingReview.has(d.id));
    if (!reason) continue;

    const dismissedAt = dismissedAtByKey.get(debtSetupDismissKey(d.id, reason));
    if (dismissedAt) {
      const cycleStart = payment ? subtractCadence(payment.nextDueDate, payment.cadence) : daysAgo(30);
      if (dismissedAt >= cycleStart) continue;
    }
    flagged.push({ id: d.id, name: d.account?.displayName ?? d.name, reason });
  }
  return flagged;
}

// SuggestionDismissal.key for the "minimum doesn't cover interest" banner
// (see debtsWithInsufficientMinimum in debt-payoff.ts). Keyed on minimum
// payment + APR — the two fields a household can actually edit to fix
// this — deliberately NOT on balance, which drifts with every sync/purchase
// and would silently un-dismiss a warning nobody actually addressed.
export function minPaymentDismissKey(debt: { id: string; minPaymentCents: number; aprBasisPoints: number }): string {
  return `${debt.id}:${debt.minPaymentCents}:${debt.aprBasisPoints}`;
}

// Every currently-insufficient-minimum debt (see debtsWithInsufficientMinimum,
// debt-payoff.ts) whose warning isn't dismissed *for the current billing
// cycle* — shared by /debts (MinPaymentWarning) and hasDebtsNeedingAttention
// below so the nav badge and the banner it points at always agree. A
// dismissal (dismissMinPaymentWarning, actions.ts) only silences the warning
// through the debt's current cycle: once its DebtPayment.nextDueDate rolls
// to a new cycle, a dismissal timestamped before that cycle started is
// stale and the debt re-qualifies — same "still broken, snooze expired"
// behavior a household expects from a recurring bill reminder, not a
// one-and-done mute. A debt with no tracked DebtPayment yet has no cycle to
// expire against, so its dismissal (if any) is honored indefinitely, same
// as before this cycle-awareness existed.
export async function getActiveInsufficientMinimumDebts(householdId: string): Promise<InsufficientMinimumDebt[]> {
  const debts = await db.debt.findMany({
    where: { householdId },
    select: {
      id: true,
      name: true,
      balanceCents: true,
      aprBasisPoints: true,
      minPaymentCents: true,
      debtType: true,
      ignoreMinimumPayment: true,
    },
  });
  const flagged = debtsWithInsufficientMinimum(debts);
  if (flagged.length === 0) return [];

  const [dismissals, debtPayments] = await Promise.all([
    db.suggestionDismissal.findMany({
      where: { householdId, kind: "MIN_PAYMENT_LOW", key: { in: flagged.map((d) => minPaymentDismissKey(d)) } },
      select: { key: true, createdAt: true },
    }),
    db.debtPayment.findMany({
      where: { householdId, debtId: { in: flagged.map((d) => d.id) } },
      select: { debtId: true, nextDueDate: true, cadence: true },
    }),
  ]);
  const dismissedAtByKey = new Map(dismissals.map((d) => [d.key, d.createdAt]));
  const paymentByDebtId = new Map(debtPayments.map((p) => [p.debtId, p]));

  return flagged.filter((d) => {
    const dismissedAt = dismissedAtByKey.get(minPaymentDismissKey(d));
    if (!dismissedAt) return true;
    const payment = paymentByDebtId.get(d.id);
    if (!payment) return false;
    const cycleStart = subtractCadence(payment.nextDueDate, payment.cadence);
    return dismissedAt < cycleStart;
  });
}

// Drives the Debts nav tab's red-dot badge (see app-shell.tsx/bottom-nav.tsx)
// and each row's "Needs setup" tag (see debtNeedsSetup above) — any
// REVOLVING debt whose terms were never confirmed (the bare "+ Add a new
// lender" quick-create path), has no tracked DebtPayment yet, has one whose
// due date is still just an approximation, has a pending DebtAmountReview
// awaiting an answer, or carries a real balance with a $0 minimum payment on
// file. That last case is legitimate at the moment it's set (a $0-balance
// card genuinely owes nothing — see updateSyncedDebtTerms) but goes stale
// the instant a real charge lands: matchDebtPayments' tolerance band floors
// at $5 (amountToleranceCents(0)), so any real payment above that lands
// outside it and — absent ignoreMinimumPayment — trips its own "did your
// minimum change?" review instead of this nag, which is worse (a recurring
// question instead of a one-time setup step), so this is what re-surfaces
// it for a household to fill in the real number. Unless the household has
// explicitly said this debt has no real minimum (ignoreMinimumPayment,
// cleared again by unhideDebtPaymentIfBalanceReturned once a paid-off card
// regains a balance) — matchDebtPayments also honors that flag, so a
// genuinely no-minimum debt with a tracked due date doesn't get nagged
// either way. Also lights up
// for a non-dismissed (or cycle-stale-dismissed) "minimum won't cover
// interest" warning — see getActiveInsufficientMinimumDebts above — so the
// badge matches everything the /debts page itself would flag red.
export async function hasDebtsNeedingAttention(householdId: string): Promise<boolean> {
  const [unconfirmedDebt, pendingReview, insufficientMinimumDebts] = await Promise.all([
    db.debt.findFirst({
      where: {
        householdId,
        debtType: "REVOLVING",
        OR: [
          { termsConfirmed: false },
          { debtPayment: null },
          { debtPayment: { dueDateLocked: false } },
          { balanceCents: { gt: 0 }, minPaymentCents: 0, ignoreMinimumPayment: false },
        ],
      },
      select: { id: true },
    }),
    db.debtAmountReview.findFirst({ where: { householdId }, select: { id: true } }),
    getActiveInsufficientMinimumDebts(householdId),
  ]);
  return Boolean(unconfirmedDebt || pendingReview || insufficientMinimumDebts.length > 0);
}

// The DebtPayment counterpart to getBillsThisWeek (recurring-bills.ts) —
// same calendar-week window and "due or paid this week" convention, same
// UpcomingBill shape, so the two merge into one list on the dashboard's
// "This week's bills" card (2026-08-15). Households don't experience a
// card/loan payment as structurally different from a bill due the same
// week — the split into separate models exists for the matching/tolerance
// engine underneath, not because they belong in different lists.
//
// Each debt gets ONE row (2026-08-28 rework): its rolling minimum still due
// plus any payoff-plan extra allocated to it this week
// (plannedExtraByDebtThisWeek), with extraCents carrying anything paid over
// and above both. A plan debt with no minimum-payment tracker of its own
// still gets a standalone payoff-extra row at the end.
// `weekOf` picks which Sun–Sat calendar week to report on (see
// getBillsThisWeek's own comment) — used only for the display window
// (`start`/`end` below); the rollover/accrual engine always anchors to the
// real `now`, never this. The payoff-plan extra overlay is different for the
// real current week vs. any other: the current week asks the live plan
// (plannedExtraByDebtThisWeek), which is always accurate for "now"; any
// other week reads PayoffExtraSnapshot instead (plannedExtraSnapshotForWeek)
// — a persisted record of what the live plan actually said *during* that
// week, since re-asking the live plan for a past week only ever answers with
// *today's* current balances/priority order, which can have moved on
// entirely (real household correction, 2026-09-06: today's plan had shifted
// its priority to Amazon/Venture; the household's own real answer for last
// week was Sam's Club, then Quicksilver, then Amazon). See both functions'
// own comments for the full history — an earlier cut tried reusing the live
// plan for past weeks two different ways and got it wrong both times.
export async function getDebtPaymentsThisWeek(householdId: string, weekOf: Date = new Date()): Promise<UpcomingBill[]> {
  const { start, end } = currentWeekBounds(weekOf);
  // UTC midnight of the local day — it's only ever compared against `@db.Date`
  // values (dp.nextDueDate below), so a raw `new Date()` would be a day off in
  // the evening here (TZ=America/Denver) and misplace the cycle boundary.
  const now = todayAsUTCDate();

  const isCurrentWeek = start.getTime() === currentWeekBounds().start.getTime();
  const plannedExtraByDebt = isCurrentWeek
    ? await plannedExtraByDebtThisWeek(householdId)
    : await plannedExtraSnapshotForWeek(householdId, start);

  // Whether the household is running the debt-payoff plan at all — gates the
  // card's green target marker (per-debt opt-in is Debt.includeInPayoffPlan).
  const household = await db.household.findUnique({
    where: { id: householdId },
    select: { payoffPlanEnabled: true },
  });
  const payoffPlanOn = household?.payoffPlanEnabled ?? false;

  const debtPayments = await db.debtPayment.findMany({
    where: {
      householdId,
      active: true,
      OR: [
        // The hiddenAt gate below is scoped to *this* branch specifically —
        // a hidden debt (household archived it — usually a long-since
        // paid-off BNPL plan) is never a real obligation, but
        // matchInstallmentPayments stops advancing its frozen nextDueDate
        // once installmentsRemaining hits 0, so that stale date drifts into
        // an arbitrary future week and resurfaced the plan here as a
        // phantom $0.00 row (real report, 2026-08-30: two paid-off Afterpay
        // plans). lastPaidDate/paidOffDate below don't have this problem —
        // they're real, one-time dates that only ever match the single week
        // they actually happened in, so they can't phantom-resurface the
        // same way and shouldn't be gated on hiddenAt too (real report,
        // 2026-09-11: hiding Sam's Club right after paying it off made it
        // vanish from both weeks' cards entirely instead of showing the
        // payoff it just earned — the Payment Calendar, which never checks
        // hiddenAt at all, kept showing it correctly the whole time).
        { nextDueDate: { gte: start, lt: end }, debt: { hiddenAt: null } },
        { lastPaidDate: { gte: start, lt: end } },
        // A debt the payoff plan is throwing extra at this week must show
        // even when its own minimum tracker's nextDueDate sits outside the
        // week — otherwise it falls through to the "untracked extra" path
        // and the card never learns its real cycle state (real report,
        // 2026-08-30: Capital One Quicksilver, nextDueDate blind-rolled to
        // Sept, showing only its $15.33 plan allocation). Same hiddenAt gate
        // as the nextDueDate branch above — projectHouseholdExtraAllocations
        // (the source of plannedExtraByDebt) has no hiddenAt filter of its
        // own, so a household-hidden debt with a stale positive balance can
        // still earn a planned-extra allocation and would otherwise phantom-
        // resurface here the exact way the nextDueDate branch was already
        // fixed against (2026-09-14 code review).
        ...(plannedExtraByDebt.size > 0
          ? [{ debtId: { in: [...plannedExtraByDebt.keys()] }, debt: { hiddenAt: null } }]
          : []),
        // Paid off this week — nextDueDate/lastPaidDate can both have already
        // rolled/gone stale by the time the balance actually hit $0 (same
        // Quicksilver debt, second incident: the payoff-closing payment
        // landed via an ACH descriptor matchDebtPayments didn't confidently
        // tie to this tracker specifically — debtId set, debtPaymentId
        // null — so it never advanced lastPaidDate, and the extra-netting
        // above zeroed plannedExtraCents once the real payment covered it,
        // leaving none of the three checks above true). The household still
        // considers it done the moment the balance/paidOffDate says so, same
        // as the "Paid Off This Week" card and the Payment Calendar's own
        // paidOffDate fallback (below, and getPaymentCalendarThisCycle).
        { debt: { paidOffDate: { gte: start, lt: end } } },
      ],
    },
    orderBy: { nextDueDate: "asc" },
    include: {
      debt: {
        select: {
          id: true,
          name: true,
          debtType: true,
          balanceCents: true,
          includeInPayoffPlan: true,
          purchaseDate: true,
          installmentsRemaining: true,
          paidOffDate: true,
          paidOffAmountCents: true,
          accountId: true,
          account: { select: { displayName: true, orgName: true } },
        },
      },
      payments: { select: { amountCents: true, occurredOn: true } },
    },
  });
  // amountDueCents / cadence / nextDueDate come along via `include: { ... }`
  // selecting the whole row's scalar fields by default — no separate select.

  // Real slot-based cycle status (every expected cadence occurrence this
  // calendar month paired positionally against real linked payments) — the
  // exact primitive /debts' CycleMinimum and the Payoff Plan calendar card
  // derive "paid this cycle" from. Replaces reading it off
  // DebtPayment.amountDueCents, which routinely sits stale-high (a
  // tracker-creation action that linked but never credited the cycle's
  // payment) and is REVOLVING-only anyway.
  const { start: monthStart, end: monthEnd } = utcPeriodBounds(currentPeriodKey());
  const debtMetaById = new Map(
    debtPayments.map((dp) => [
      dp.debtId,
      {
        debtType: dp.debt.debtType,
        purchaseDate: dp.debt.purchaseDate,
        installmentsRemaining: dp.debt.installmentsRemaining,
        balanceCents: dp.debt.balanceCents,
        paidOffDate: dp.debt.paidOffDate,
      },
    ]),
  );
  const correctedByDebtId = correctedDueDateByDebtId(
    debtPayments,
    monthStart,
    monthEnd,
    debtMetaById,
    new Set(),
    await planExtraTargetsByDebt(householdId, monthStart, monthEnd),
  );
  // Covered minimums the household skipped on /debts (DebtMinimumSkip) whose
  // due date lands in this week — the row reads "Skipped" instead of an open
  // minimum (real report, 2026-10-02: Venture's $84 due Sep 27, already
  // covered by a $177 Sep 18 payment, sat open on the card all week).
  const skippedMinimumKeys = await getSkippedMinimumKeys(householdId, start, end);

  // The most recent real payment that paid a debt down (or off) but never
  // got tied to its specific DebtPayment tracker — debtId set, debtPaymentId
  // null, same gap as the paidOffDate OR-condition above (matchDebtPayments'
  // merchant-text match was confident enough to credit the debt but not to
  // advance a specific tracker's own nextDueDate/lastPaidDate). Not
  // date-bounded here — a SimpleFIN balance sync can confirm the payoff a
  // few days after the closing payment actually posted, so the payment
  // itself may sit just outside this week's window even though paidOffDate
  // (checked per-candidate below) lands inside it. Folded into receivedCents
  // whenever either date is in-week, so a payoff that closes this way still
  // reads as "paid this week" and gets the payoff star, instead of silently
  // crediting $0 against a tracker whose own linked payments say nothing
  // happened.
  const untrackedPaymentByDebtId = new Map<string, { cents: number; occurredOn: Date }>();
  if (debtPayments.length > 0) {
    // A payment can also arrive with debtId itself still null — the closing
    // leg on a revolving card's own lender feed routinely reads as a bare
    // issuer name ("Capital One") with no "payment"/"autopay"/"credit card"
    // token for the sync-time categorizer to key off (CARD_PAYMENT_MERCHANT_
    // PATTERN), so it never gets tagged at all, not even loosely. Real case,
    // 2026-09-05: Quicksilver's actual closing payment sat fully unclassified
    // while an unrelated, already-tracked $25 minimum from days earlier kept
    // getting picked as "the" payment instead. Scoped to the debt's own
    // linked account and — same lender-name requirement as
    // simplefin-sync.ts's own isLiabilityAccount branch — merchant text
    // naming that account's own lender: negative sign and account identity
    // alone aren't enough, since that same feed also carries cash-back/
    // rewards credits (real case, 2026-09-06: a "Cashback" -$2.94 on this
    // same Quicksilver account got folded into a payoff row's total,
    // inflating $37.72 to $40.66) and return credits for a prior purchase.
    const debtAccountInfo = debtPayments
      .map((dp) => ({ accountId: dp.debt.accountId, lenderName: dp.debt.account?.orgName ?? null }))
      .filter((a): a is { accountId: string; lenderName: string | null } => a.accountId != null);
    const debtAccountIds = debtAccountInfo.map((a) => a.accountId);
    const untrackedPayments = await db.transaction.findMany({
      where: {
        householdId,
        // A couple of weeks' lookback comfortably covers a balance sync
        // confirming a payoff a few days after the closing payment posted,
        // without scanning a debt's whole untracked-transaction history.
        occurredOn: { gte: new Date(start.getTime() - 14 * 86_400_000) },
        OR: [
          { debtId: { in: debtPayments.map((dp) => dp.debtId) }, debtPaymentId: null },
          ...(debtAccountIds.length > 0
            ? [{ debtId: null, accountId: { in: debtAccountIds }, amountCents: { lt: 0 } }]
            : []),
        ],
      },
      orderBy: { occurredOn: "desc" },
      select: { id: true, debtId: true, accountId: true, amountCents: true, occurredOn: true, merchant: true },
    });
    const debtIdByAccountId = new Map<string, string>();
    for (const dp of debtPayments) if (dp.debt.accountId) debtIdByAccountId.set(dp.debt.accountId, dp.debtId);
    const lenderNameByAccountId = new Map(debtAccountInfo.map((a) => [a.accountId, a.lenderName]));
    const trackerIdByDebtId = new Map(debtPayments.map((dp) => [dp.debtId, dp.id]));
    const accountIdByDebtId = new Map(debtPayments.map((dp) => [dp.debtId, dp.debt.accountId]));

    const candidatesByDebtId = new Map<string, typeof untrackedPayments>();
    for (const t of untrackedPayments) {
      const debtId = t.debtId ?? debtIdByAccountId.get(t.accountId ?? "");
      if (!debtId) continue;
      if (!t.debtId) {
        // The debtId:null branch matched purely on account+sign — still
        // needs the lender-name check before it counts as a real payment.
        const lenderName = lenderNameByAccountId.get(t.accountId ?? "");
        if (!lenderName || !t.merchant.toLowerCase().includes(lenderName.trim().toLowerCase())) continue;
      }
      const arr = candidatesByDebtId.get(debtId) ?? [];
      arr.push(t);
      candidatesByDebtId.set(debtId, arr);
    }
    // A "debtId set, debtPaymentId null" match can still be a stale, already-
    // counted duplicate — the checking-side debit twin of a payment that's
    // *already* tracked via its card-side credit (filterDebtPaymentTwins
    // exists precisely to pick one leg of a real payment over its twin; this
    // fallback bypassed it entirely). Real case, 2026-09-06: a "Capital One
    // Credit Card Payment" +$25 sitting on checking with debtId set but no
    // debtPaymentId — the twin of Aug 27's already-tracked card-side −$25 —
    // got counted a second time on top of Quicksilver's real $37.72 closing
    // payment, inflating $37.72 to $62.72. Reusing the same twin filter here
    // (against each debt's own already-linked payments) drops it the same
    // way a normal sync would.
    for (const [debtId, candidates] of candidatesByDebtId) {
      const trackerId = trackerIdByDebtId.get(debtId);
      if (!trackerId) continue;
      const survivors = await filterDebtPaymentTwins(trackerId, candidates, accountIdByDebtId.get(debtId) ?? null);
      const mostRecent = survivors[0]; // filter() preserves the query's occurredOn-desc order
      if (mostRecent) {
        untrackedPaymentByDebtId.set(debtId, { cents: Math.abs(mostRecent.amountCents), occurredOn: mostRecent.occurredOn });
      }
    }
  }

  const trackedDebtIds = new Set<string>();

  const candidates = debtPayments
    .map((dp) => {
      const isInstallment = dp.debt.debtType === "INSTALLMENT";
      const minimumCents = dp.amountCents;
      // A no-minimum debt (ignoreMinimumPayment tracks amountCents at $0 —
      // see debtSetupReason) has no "over vs. under the minimum" to reason
      // about, so it never gets an extra tag — every payment on it is just
      // a payment.
      const tracksMinimum = minimumCents > 0;

      const abs = (cents: number) => Math.abs(cents);
      const paymentsThisWeek = dp.payments
        .filter((p) => p.occurredOn >= start && p.occurredOn < end)
        .sort((a, b) => b.occurredOn.getTime() - a.occurredOn.getTime());
      const paidOffThisWeek = !!dp.debt.paidOffDate && dp.debt.paidOffDate >= start && dp.debt.paidOffDate < end;
      // Only counted when it's genuinely relevant to this week — either it
      // posted this week itself, or the balance sync that confirmed the
      // payoff (which may lag the actual payment by a few days) landed this
      // week. Otherwise a household glancing back next week would see the
      // same untracked payment credited a second time.
      const rawUntracked = untrackedPaymentByDebtId.get(dp.debtId);
      const untracked =
        rawUntracked && (paidOffThisWeek || (rawUntracked.occurredOn >= start && rawUntracked.occurredOn < end))
          ? rawUntracked
          : undefined;
      const rawReceivedCents = paymentsThisWeek.reduce((s, p) => s + abs(p.amountCents), 0) + (untracked?.cents ?? 0);
      // A balance-sync-confirmed payoff with no linked transaction or
      // untracked candidate yet (SimpleFIN lag between the balance dropping
      // and the closing charge posting/matching) still has a real dollar
      // figure available: paidOffAmountCents, the balance right before the
      // transition (see nextPaidOffAmountCents, debt-payoff.ts). Without
      // this the row read "$0.00" for a debt that genuinely paid off this
      // week (real report, 2026-09-17: Sam's Club Card, the same week its
      // identical Payment Calendar fallback was fixed to show a real amount
      // instead of a bare star).
      const receivedCents = rawReceivedCents === 0 && paidOffThisWeek ? (dp.debt.paidOffAmountCents ?? 0) : rawReceivedCents;
      const latestPayment =
        paymentsThisWeek[0] && (!untracked || paymentsThisWeek[0].occurredOn >= untracked.occurredOn)
          ? paymentsThisWeek[0]
          : untracked
            ? { occurredOn: untracked.occurredOn }
            : rawReceivedCents === 0 && paidOffThisWeek
              ? { occurredOn: dp.debt.paidOffDate! }
              : undefined;

      // The tracker's next-owed occurrence lands in this Sun–Sat week, and
      // what that occurrence still owes (see the fuller notes on the
      // identical expressions further down, where minimumMet consumes them).
      const dueDateInWeek = dp.nextDueDate >= start && dp.nextDueDate < end;
      const owedThisWeekCents = dp.amountDueCents > 0 ? dp.amountDueCents : minimumCents;

      // Payments toward this debt this cycle vs. just this calendar week.
      // "This cycle" ≈ the one cadence period ending at the next due date,
      // but nextDueDate can sit a few days in the past inside the rollover
      // grace window (see SYNC_LAG_GRACE_DAYS) — anchor to whichever of
      // nextDueDate / now is later so a payment landing a day or two after
      // the due date still counts.
      const cycleStart = (() => {
        // This week's own occurrence is already covered by a payment that
        // landed this week (and the debt isn't being paid off — a payoff
        // keeps the wide window so its "For Payoff!" amount counts this
        // cycle's earlier minimum too, per the F-150 note below). "This
        // cycle" then starts at this week, not a full cadence back: reaching
        // a cadence further back sweeps in the *previous* occurrence's
        // payment, which routinely posts a few days after its own due date
        // (so anchoring to nextDueDate alone doesn't exclude it), and a
        // MONTHLY debt then reads one whole extra payment of "principal
        // toward debt" every cycle (real report 2026-09-02: a mortgage that
        // paid its $1,790.35 minimum on Sep 1 showed "$1,790.35 Extra"
        // because August's payment posted Aug 3 — two days past the Aug 1
        // due date — so both it and the Sep 1 payment landed inside the
        // cadence-back window).
        if (
          dueDateInWeek &&
          tracksMinimum &&
          dp.debt.balanceCents > 0 &&
          receivedCents >= owedThisWeekCents
        ) {
          return start;
        }
        // The occurrence still parked on nextDueDate was due before this
        // week and paid late — the payments on/after its due date are its
        // own minimum, and anything earlier belongs to the occurrence before
        // it (see parkedOccurrenceSettledLate, real report 2026-10-05).
        if (
          tracksMinimum &&
          dp.debt.balanceCents > 0 &&
          parkedOccurrenceSettledLate({
            nextDueDate: dp.nextDueDate,
            weekStart: start,
            owedCents: owedThisWeekCents,
            payments: dp.payments,
          })
        ) {
          return dp.nextDueDate;
        }
        const anchor = dp.nextDueDate > now ? dp.nextDueDate : now;
        const approx = subtractCadence(anchor, dp.cadence);
        // Never let the cycle window open after this week's start: once a
        // debt's minimum is paid, nextDueDate rolls forward, which can push
        // `approx` past `start`, and "this week" must always sit inside
        // "this cycle." No createdAt floor — `approx` already scopes this to
        // a single cadence period, and a real payment linked to this tracker
        // within that period belongs to the cycle no matter when the tracker
        // row itself was created (real report 2026-08-28: an F-150 payoff
        // read "$776.66 For Payoff!" instead of the full $934.66 because
        // that cycle's regular minimum, paid 9 days before the tracker was
        // created, was excluded from receivedThisCycleCents — so
        // surplusThisCycleCents subtracted a minimumCents the counted
        // receipts never actually included).
        return approx < start ? approx : start;
      })();
      // "This cycle" = the real current calendar month for an INSTALLMENT
      // (matches /debts' CycleMinimum and buildCycleSlots) — a cadence-back
      // window off nextDueDate swept in the *previous* installment's payment
      // (it lands exactly one cadence before the next due date on a clean
      // BIWEEKLY plan, and the `>= cycleStart` bound is inclusive), so every
      // BNPL plan with any synced history read as already paid this cycle
      // (real report, 2026-08-30: Affirm–Dick's, Klarna–Puma showing $0.00 +
      // a check). REVOLVING keeps the cadence window (its own history of
      // grace-window fixes).
      const cycleWindowStart = isInstallment ? monthStart : cycleStart;
      const receivedThisCycleCents = dp.payments
        .filter((p) => p.occurredOn >= cycleWindowStart)
        .reduce((s, p) => s + abs(p.amountCents), 0);

      const planned = plannedExtraByDebt.get(dp.debt.id);
      // A plan extra that already posted this week (a payment
      // correctedDueDateByDebtId classed as extra, not minimum — see
      // splitPlanExtraPayments) is this week's planned extra in full. The live
      // plan nets a paid extra out of its own allocation, so without this the
      // row fell back to "surplus over the minimum" and showed $100.00 (or
      // less) of a real $108.33 extra (real report, 2026-10-03).
      const extraTimes = correctedByDebtId.get(dp.debtId)?.extraPaidTimes;
      const planExtraPaidThisWeekCents =
        payoffPlanOn && dp.debt.includeInPayoffPlan && extraTimes
          ? paymentsThisWeek
              .filter((p) => extraTimes.has(p.occurredOn.getTime()))
              .reduce((sum, p) => sum + abs(p.amountCents), 0)
          : 0;
      const plannedExtraCents = Math.max(planned?.amountCents ?? 0, planExtraPaidThisWeekCents);
      // Genuinely plan-driven money — the extra-per-paycheck pool or a
      // rolled-in freed minimum, only while the plan is actually running —
      // not just "any payment beyond this cycle's minimum." `planned`
      // (this week's own live/frozen plan allocation) already reads empty
      // for an out-of-plan debt on the live/current-week path
      // (plannedExtraByDebtThisWeek only ever allocates to in-plan debts),
      // and for a past week's frozen snapshot it's non-empty only when the
      // debt genuinely was in-plan that week — so it doubles as the
      // historical half of `includeInPayoffPlan`. Gates both the "$X Extra"
      // sub-line below and the "Paid Off!"/"For Payoff!" badge (real report,
      // 2026-09-17: Sam's Club Card, excluded from the plan 2026-09-16,
      // closed itself out via an unrelated purchase-driven restore payment —
      // its whole $175.78 badged "Extra" purely because it exceeded the
      // (zero) tracked minimum, the same shape the payoff badge itself was
      // already fixed against the day before).
      const planDriven = payoffPlanOn && (dp.debt.includeInPayoffPlan || !!planned);

      const corrected = correctedByDebtId.get(dp.debtId);
      const installmentDone =
        isInstallment && dp.debt.installmentsRemaining !== null && dp.debt.installmentsRemaining <= 0;
      // dueDateInWeek (declared above, next to cycleStart): the tracker's own
      // next-unpaid occurrence lands in this Sun–Sat week. matchDebtPayments /
      // matchInstallmentPayments both keep nextDueDate pointed at the next
      // occurrence still owed, so when it sits inside the week we trust it
      // directly — the same way getBillsThisWeek trusts a RecurringBill's
      // nextDueDate — instead of asking a month-scoped "cyclePaid" question
      // that goes stale the moment the due date crosses into next calendar
      // month.
      // Is this week's obligation covered?
      //  - INSTALLMENT: week-aware, not calendar-month — a BNPL plan's next
      //    unpaid installment can legitimately fall in *next* calendar month
      //    while still landing in this straddling Sun–Sat week (real report,
      //    2026-08-30: Klarna–Puma due Sep 3, this week, but both August
      //    installments paid, so a month-scoped cyclePaid wrongly hid it).
      //    matchInstallmentPayments keeps nextDueDate pointed at the next
      //    unpaid occurrence, so "covered" = it's rolled past this week, a
      //    payment already landed this week, or the plan's done.
      //  - REVOLVING with its due date in this week: same reasoning — the
      //    occurrence is genuinely upcoming, so it's covered only once a real
      //    payment lands this week (real report, 2026-08-30: a Home Loan due
      //    Sep 1 with August's payment made Aug 3 — a phantom Aug 1 slot got
      //    paired with that payment, cyclePaid read true, and the whole row
      //    was suppressed; a $0 amountDueCents left stale by a roll-forward
      //    hid an Voyager loan due Sep 5 the same way).
      //  - REVOLVING with its due date in a *future* week: nothing's owed
      //    yet, full stop — same as INSTALLMENT's own dp.nextDueDate >= end
      //    check above. Real report, 2026-09-06: Amazon Card next due Sep
      //    12, evaluated for the Aug 30–Sep 5 week — dueDateInWeek is false
      //    (same as a genuinely overdue debt would be), and without this
      //    check it fell into the drifted/past-due branch below and picked
      //    up dp.amountDueCents (a rolling in-cycle-progress figure, not an
      //    overdue balance) as if it were owed *this* week, tacking a phantom
      //    $25.36 "minimum" onto a row that should have shown only its
      //    planned extra.
      //  - REVOLVING with a drifted/past due date: slot-based cyclePaid (see
      //    correctedByDebtId), a genuine amountDueCents<=0, or — when only
      //    this cycle's own minimum could still be outstanding — this cycle's
      //    real payments vouching for it (catches a payment linked but never
      //    decremented against amountDueCents — real report 2026-08-28: a
      //    paid PayPal Credit still showing "partial").
      // owedThisWeekCents is declared above, next to cycleStart.
      //  - REVOLVING with its due date in this week but paid *after* the
      //    week closed, inside the rollover grace window (nextDueDate hasn't
      //    rolled yet): covered — the later week's card shows the payment
      //    itself (see occurrenceSettledAfterWeek, real report 2026-09-29).
      const settledAfterWeek =
        !isInstallment &&
        dueDateInWeek &&
        tracksMinimum &&
        occurrenceSettledAfterWeek({
          nextDueDate: dp.nextDueDate,
          weekEnd: end,
          owedCents: owedThisWeekCents - receivedCents,
          payments: dp.payments,
        });
      const minimumMet = isInstallment
        ? installmentDone || receivedCents > 0 || dp.nextDueDate >= end
        : dueDateInWeek
          ? !tracksMinimum || receivedCents >= owedThisWeekCents || settledAfterWeek
          : dp.nextDueDate >= end
            ? true
            : (corrected?.cyclePaid ?? false) ||
              dp.amountDueCents <= 0 ||
              (dp.amountDueCents <= minimumCents && receivedThisCycleCents >= minimumCents);

      // "Still expected this week" — what the household is still on the hook
      // for. Feeds the dashboard's "due this week" total.
      const stillOwedMinimumCents = minimumMet
        ? 0
        : isInstallment
          ? minimumCents
          : dueDateInWeek
            ? Math.max(0, owedThisWeekCents - receivedCents)
            : Math.max(0, dp.amountDueCents);
      // Full obligation still on the books this week: the rolling minimum
      // still due plus the *whole* payoff-plan allocation. A partial payment
      // that's already landed does NOT net down the plan's figure here — the
      // household decision (2026-09-02, Sam's Club Card) is that the
      // SimpleFIN-synced debt balance / plan target stays visible as-is and
      // an in-flight bank payment (checking debited, the card balance not yet
      // caught up) shows as its own "$X Paid" line, rather than the row
      // quietly re-basing to the remainder.
      const expectedCents = stillOwedMinimumCents + plannedExtraCents;

      // The bare minimum obligation for this week's occurrence, *before* any
      // payment — the honest denominator for the card's "$X / $Y" partial
      // headline. `expectedCents` isn't it: it folds in the full plan extra,
      // and once a payment lands it stops being `paidCents + expectedCents`'s
      // missing half (that sum then double-counts anything paid past the
      // minimum — a $101 payment on a no-minimum $140.80 payoff target read
      // as "$101 / $241.80"). 0 when nothing's due this week.
      const minimumDueCents = isInstallment
        ? installmentDone || dp.nextDueDate >= end
          ? 0
          : minimumCents
        : dueDateInWeek
          ? tracksMinimum && !settledAfterWeek
            ? owedThisWeekCents
            : 0
          : minimumMet
            ? 0
            : Math.max(dp.amountDueCents, 0);

      // Surplus toward principal: this cycle's total over the minimum + the
      // planned payoff extra, capped at what landed *this week* and only
      // once the minimum's covered. Subtracting the whole-cycle minimum
      // (not a per-week one) is what makes a payoff payment land as 100%
      // extra when the minimum was already paid earlier in the cycle (real
      // report 2026-08-28: a Trailer Loan whose $92 posted weeks before the
      // payoff — the $92 must not come off the extra again). For an
      // INSTALLMENT the "minimum" is one installment — a BIWEEKLY BNPL plan
      // routinely bills twice in a calendar month, so subtract one per
      // expected occurrence this month or every clean two-installment month
      // reads a whole bogus installment of "extra to principal". A small
      // overpayment (a rounding cent on a fixed BNPL installment) isn't
      // worth flagging — floor at the same tolerance band the matcher uses.
      const cycleMinimumCents = isInstallment
        ? minimumCents *
          Math.max(
            1,
            occurrencesInPeriod(
              dp.nextDueDate,
              dp.cadence,
              dp.debt.purchaseDate && dp.debt.purchaseDate > monthStart ? dp.debt.purchaseDate : monthStart,
              monthEnd,
            ).length,
          )
        : minimumCents;
      const extraFloorCents = dp.toleranceCents ?? amountToleranceCents(minimumCents);
      // Extracted to upcoming-bills-shared.ts (extraTowardPrincipalCents) —
      // see that function's own comment for what changed and why (household
      // report, 2026-09-21: Sam's Club Card showed "$316.58 Extra" — a prior
      // week's own already-reportable payment leaking into this week's badge).
      const extraCents = extraTowardPrincipalCents({
        tracksMinimum,
        minimumMet,
        receivedThisCycleCents,
        rawReceivedCents,
        cycleMinimumCents,
        plannedExtraCents,
        extraFloorCents,
        planDriven,
      });

      // "Not behind" — the rolling minimum is covered — AND any payoff-plan
      // extra for the week has landed too (it's a real expected payment, not
      // aspirational, per the 2026-08-28 rework). Drives the check icon and
      // the card's dismissible "all paid" state.
      const paid = minimumMet && (plannedExtraCents === 0 || receivedCents >= plannedExtraCents);
      // Only a bare minimum line is skippable — a skip forfeits the minimum,
      // never a payoff-plan extra riding on the same row.
      const minimumSkipped =
        !paid &&
        dueDateInWeek &&
        plannedExtraCents === 0 &&
        receivedCents === 0 &&
        skippedMinimumKeys.has(`${dp.debtId}:${dp.nextDueDate.toISOString().slice(0, 10)}`);

      const paysOff = dp.debt.balanceCents <= 0 && (receivedCents > 0 || paidOffThisWeek);
      // The star icon (row.paysOff below) is a plain factual "this closed
      // the balance" signal and stays for any debt. The celebratory
      // "Paid Off!" / "+$X For Payoff!" sub-line is reserved for genuinely
      // plan-driven money (planDriven, above) — same 2026-09-16 correction
      // as the Payment Calendar's isExtraPaid (see WORKING_ON.md): a BNPL's
      // perfectly ordinary final installment, or a no-minimum card's plain
      // purchase-driven payoff, isn't a payoff-plan milestone just because
      // the plan happens to be running on other debts (real report,
      // 2026-09-16: Affirm–Dick's, never in the plan, badged "Paid Off!"
      // for its last installment same as a real plan target closing out).
      // The plan projects this week's own extra to close the balance, real
      // money or not yet — drives the "For Payoff!" badge ahead of the real
      // thing (see PlannedExtraThisWeek.paysOff's own doc comment; this is
      // the has-its-own-tracker branch that signal never reached before).
      // Only for the *current* week, though — planned?.paysOff comes from a
      // PayoffExtraSnapshot frozen back when that week was still live, and
      // "ahead of confirmation" only makes sense looking forward. A past
      // week (isCurrentWeek false) already has a knowable real outcome, so
      // it trusts paysOff alone — real report, 2026-09-11: Sam's Club's
      // payment posted a few days late (into the following week), and Last
      // Week's Bills kept showing its stale "will pay off" snapshot as a
      // "Paid Off!" badge sitting right next to the still-open (correctly
      // unconfirmed-for-that-week) bullet — the badge and the icon told two
      // different stories for a week that was already over.
      const plannedPayoff = planDriven && (isCurrentWeek ? paysOff || Boolean(planned?.paysOff) : paysOff);

      const row: UpcomingBill = {
        id: dp.id,
        // Same override convention as /debts (see debts/page.tsx) — a
        // household-set friendly name on the linked Account wins over the
        // Debt's own name.
        name: dp.debt.account?.displayName ?? dp.debt.name,
        kind: "debt" as const,
        expectedCents,
        paidCents: receivedCents,
        extraCents,
        poolBreakdown: planned?.poolBreakdown,
        plannedExtraCents,
        minimumDueCents,
        reimbursedCents: 0,
        // Same rolled-forward-on-paid pitfall as getBillsThisWeek —
        // nextDueDate already points at *next* cycle once this one's
        // confirmed paid, and matchDebtPayments now blind-rolls it even for
        // an unpaid cycle. Anchor to the real payment that landed this week,
        // then this week's planned-extra paycheck date, then the tracker's
        // own nextDueDate when it genuinely lands in this Sun–Sat week (the
        // straddling-month-boundary case — a BNPL installment due Sep 3 must
        // read "Sep 3", not a month-scoped slot projection's later date),
        // then the corrected in-month slot date for a still-unpaid minimum
        // whose nextDueDate has drifted, before the raw nextDueDate.
        // latestPayment itself already covers a balance-sync-confirmed
        // payoff with no linked transaction yet (see its own fallback to
        // paidOffDate above) — otherwise this row fell all the way through
        // to the tracker's raw (and often months-stale once
        // ignoreMinimumPayment stops rolling it meaningfully) nextDueDate
        // instead of the date the payoff actually happened (real report,
        // 2026-09-16: Sam's Club Card read "Oct 4" the one week it should
        // have read "Sep 16").
        dueDate:
          latestPayment?.occurredOn ??
          planned?.dueDate ??
          (dueDateInWeek ? dp.nextDueDate : undefined) ??
          (!minimumMet ? corrected?.date : undefined) ??
          dp.nextDueDate,
        paid,
        paysOff,
        plannedPayoff,
        inPayoffPlan: payoffPlanOn && dp.debt.includeInPayoffPlan && dp.debt.balanceCents > 0,
        // Same dueDate fallback chain, just asking "is that date real": a
        // real payment's own date (latestPayment, including its own
        // paidOffDate fallback) and the payoff plan's own paycheck date are
        // never guesses — only falling through to the tracker's raw
        // nextDueDate/corrected slot date inherits its lock state (see
        // debt-row.tsx's identical use of dueDateLocked, and
        // matchInstallmentPayments' own comment on why an INSTALLMENT plan's
        // rolling projection is never confirmed until its real charge posts).
        dueDateConfirmed: latestPayment ? true : planned ? true : dp.dueDateLocked,
        // Set below on the "-payoff" split row specifically, once it's
        // known whether the debt's own balance already confirms this
        // amount without a matching transaction — this base row (the
        // merged/unsplit case) never has that ambiguity: minimumMet/paid
        // above already reflect a real receipt, or there's genuinely
        // nothing left owed.
        pendingBalanceConfirmation: false,
        // A skipped covered minimum (minimumSkipped above). A payoff-plan
        // extra's skip decision (PayoffExtraSkip) shows directly on /debts,
        // not on this card.
        skipped: minimumSkipped,
      };
      return {
        row,
        debtId: dp.debt.id,
        balanceCents: dp.debt.balanceCents,
        minimumMet,
        paidThisWeek: receivedCents > 0 || paidOffThisWeek,
        // The plan's own paycheck date for this week's payoff allocation —
        // kept separately because `row.dueDate` collapses to the real
        // payment's date once one has landed (see the dueDate chain above).
        plannedDueDate: planned?.dueDate,
        // Used below to suppress the "-payoff" split row when the payoff
        // confirmed in a later week (paidOffDate >= end) — that week's card
        // already shows the real payment; don't also show it here as pending.
        paidOffDate: dp.debt.paidOffDate,
      };
    });

  const rows: UpcomingBill[] = [];
  for (const c of candidates) {
    // Fully paid off and quiet this week — an earlier payoff (the hidden
    // Afterpay pair drops at the query; this catches a non-hidden plan that
    // closed out last month). A this-week payoff still shows, with the star
    // — paidThisWeek now also covers "the balance sync confirmed the payoff
    // this week," not just "a linked payment landed this week" (see
    // paidOffThisWeek above).
    if (c.balanceCents <= 0 && !c.paidThisWeek && c.row.plannedExtraCents === 0) continue;
    // A payoff whose *balance-sync confirmation* merely landed this week —
    // paidOffThisWeek above, with no payment of its own posting this week
    // and nothing left owed or planned — is already fully told elsewhere
    // *for a past week*: whichever earlier week the real payment/planned-
    // extra actually happened already carries the honest amount, and the
    // dashboard's own "Paid Off This Week" banner (getDebtsPaidOffThisWeek)
    // already gave the celebratory notice back then. Without this, that
    // debt shows a second time here as a stale-dated $0.00 ghost row —
    // nothing to attribute the amount to, since neither a real payment nor
    // a planned extra landed in this specific week (real report, 2026-09-07:
    // Sam's Club Card — Sep 04, $0.00 — its real $140.80 payoff had already
    // posted, and shown with its real amount, in the prior week's own card).
    //
    // Only for a *past* week, though — for the current week this is often
    // the ONLY place the payoff has been told at all: the real closing
    // transaction hasn't synced/matched to a tracker yet (SimpleFIN lag),
    // so nothing has "already shown it elsewhere," and hiding it here left
    // This Week's Bills silently missing a debt the Payment Calendar (its
    // own paidOffDate fallback) and the "Paid Off This Week" banner both
    // already knew about (real report, 2026-09-16: Sam's Club Card, again).
    if (!isCurrentWeek && c.paidThisWeek && c.row.paidCents === 0 && c.row.expectedCents === 0) continue;
    // Show when something landed this week, the week's obligation isn't
    // covered, or the payoff plan is throwing extra at it this week.
    if (!(c.paidThisWeek || !c.minimumMet || c.row.plannedExtraCents > 0)) continue;
    trackedDebtIds.add(c.debtId);

    // A no-minimum payoff-plan debt with a real payment already settled this
    // week AND a plan payoff still pending gets two rows (household decision
    // 2026-09-02, Sam's Club Card): a "$X · <paid date> ✓" row for the
    // settled bank payment, and the untouched "$Y · <plan date>" payoff row.
    // The settled payment does NOT net down the payoff figure — the
    // SimpleFIN-synced balance is the source of truth for what's still owed,
    // and it self-corrects once the payment posts on the card side. Only
    // splits when there's no minimum obligation competing for the same row
    // (a tracked minimum keeps the merged min+extra row, per 2026-08-28).
    const splitSettledPayment =
      c.row.minimumDueCents === 0 && c.paidThisWeek && c.row.plannedExtraCents > 0 && !c.row.paid;
    if (splitSettledPayment) {
      rows.push({
        ...c.row,
        id: `${c.row.id}-paid`,
        expectedCents: c.row.paidCents,
        extraCents: 0,
        plannedExtraCents: 0,
        minimumDueCents: 0,
        paid: true,
        // This row is just the real, already-settled minimum payment — the
        // plan's own payoff projection belongs solely on the sibling
        // "-payoff" row below (which explicitly keeps it). Without this it
        // inherited plannedPayoff from c.row (true whenever the plan expects
        // this debt to close this week) and wrongly badged an ordinary
        // settled payment as "Paid Off!" (real case, 2026-09-06: Sam's Club
        // Card's routine $101 payment).
        plannedPayoff: false,
        // Same leak, one field over: paysOff drives the star icon itself
        // (upcoming-bills-card.tsx), independent of plannedPayoff's "Paid
        // Off!" text badge above — and c.row.paysOff is now permanently true
        // for a debt that's since paid off in full (balanceCents <= 0), so
        // every past week's routine settled-payment row for it inherited a
        // star too, not just the one that actually closed it out (real
        // report, 2026-09-07: Sam's Club Card's Sep 1 $101 payment starred
        // in Last Week's Bills — the real payoff was the separate Sep 3
        // extra, the sibling "-payoff" row below).
        paysOff: false,
        pendingBalanceConfirmation: false,
      });
      // Deliberately NOT inferred from the debt's live balance alone
      // (household decision, 2026-09-07) — a bare $0 balance can lag or
      // outrun the real transaction by days on either side, and this row's
      // own plannedExtraCents is itself just the plan's projected figure,
      // not a confirmed amount. Wait for an actual payment — bank-side or
      // the card's own account feed, both already covered by c.row's
      // receivedCents/untrackedPaymentByDebtId — before crediting this line;
      // once one lands, splitSettledPayment's own !c.row.paid gate stops
      // splitting at all and the merged row picks it up normally. Until
      // then this keeps reading "still due," honestly, even for a payoff
      // that may never post a traceable transaction on either account.
      // The payoff was confirmed in a later week (paidOffDate >= end), so
      // its real payment already shows correctly on that week's card — don't
      // also show a stale "Balance Updated — Payment Details Pending" row on
      // THIS week's retrospective card for it. Real incident 2026-09-09:
      // Sam's Club $140.80 payoff posted Sep 08 (this week, 9/6-9/12) but
      // the split "-payoff" row for last week (8/30-9/5) kept showing as
      // pending because paidOffDate (Sep 08) was outside the 8/30-9/5 window.
      if (c.balanceCents <= 0 && c.paidOffDate != null && c.paidOffDate >= end) continue;
      rows.push({
        ...c.row,
        id: `${c.row.id}-payoff`,
        expectedCents: c.row.plannedExtraCents,
        paidCents: 0,
        extraCents: 0,
        paid: false,
        // Not c.row.paysOff — that flag can already be true purely from the
        // sibling settled payment (receivedCents > 0) once the debt is at
        // $0, which would star this untouched, still-projected figure for
        // an unrelated reason.
        paysOff: false,
        // The debt's own balance already reads $0 with no transaction to
        // point at for this remaining figure — the exact gap described
        // above. Surfaces a "balance updated — payment details pending"
        // note instead of leaving "still due" sitting unexplained next to
        // the dashboard's own "Paid Off" badge.
        pendingBalanceConfirmation: c.balanceCents <= 0,
        dueDate: c.plannedDueDate ?? c.row.dueDate,
      });
      continue;
    }
    rows.push(c.row);
  }

  // Payoff-plan extra for a debt with no minimum-payment tracker of its own
  // — still a real expected payment this week, so it gets its own row. Plain
  // debt name (not "Extra Toward …" — household decision 2026-08-30, so the
  // tracked and untracked extra rows read the same); the card's "Includes $X
  // Planned Extra" sub-line carries the meaning.
  const untrackedExtraRows: UpcomingBill[] = [...plannedExtraByDebt.entries()]
    .filter(([debtId]) => !trackedDebtIds.has(debtId))
    .map(([debtId, planned]) => ({
      id: `payoff-extra-${debtId}`,
      name: planned.debtName,
      kind: "debt" as const,
      expectedCents: planned.amountCents,
      paidCents: planned.confirmed ? planned.amountCents : 0,
      extraCents: 0,
      plannedExtraCents: planned.amountCents,
      poolBreakdown: planned.poolBreakdown,
      // No minimum-payment tracker of its own — this row is pure plan extra.
      minimumDueCents: 0,
      reimbursedCents: 0,
      dueDate: planned.dueDate,
      paid: planned.confirmed,
      paysOff: planned.confirmed && planned.paysOff,
      // Same isCurrentWeek gate as the tracked-debt row above, same reason:
      // a past week's "will pay off" snapshot shouldn't keep badging
      // "Paid Off!" once that week is over and the real outcome (confirmed
      // or not) is already knowable.
      plannedPayoff: isCurrentWeek ? planned.paysOff : planned.confirmed && planned.paysOff,
      // It's getting a payoff-plan allocation this week — by definition in the plan.
      inPayoffPlan: true,
      // dueDate here is the plan's own paycheck date, not a BNPL/lender
      // schedule guess — never the kind of uncertainty this flag is about.
      dueDateConfirmed: true,
      pendingBalanceConfirmation: false,
      skipped: false,
    }));

  return [...rows, ...untrackedExtraRows];
}

// A household-set friendly nickname on the linked Account (/settings/simplefin)
// wins over the raw one-time-copied Debt.name — same override
// debts/page.tsx applies to its own `debts` array (2026-08-15 account
// settings consolidation) and getDebtPaymentsThisWeek already applies per-row
// above. Every payoff-calendar / review / suggestion / notification surface
// below reads a debt's name through this instead of `.name` directly, so a
// renamed account shows up everywhere a debt's name is displayed — not just
// on /debts and the dashboard's own "This Week's Bills" tracked rows (real
// household report, 2026-09-01: the Payoff Plan calendar's day popovers were
// still showing the raw Debt.name).
export function debtDisplayName(d: { name: string; account?: { displayName: string | null } | null }): string {
  return d.account?.displayName ?? d.name;
}

// Confirming an EMAIL-sourced DebtAmountReview (see confirmDebtAmountChanged,
// debts/actions.ts) should reflect the notice's new amount in the live
// rolling DebtPayment.amountDueCents too — but only when the current cycle
// is still untouched (nothing paid/added against it since the notice
// landed). Otherwise a partially-paid cycle's real remaining balance would
// get clobbered by a number that describes what's newly due, not what's
// still owed on the old one. Compares against expectedAmountDueCents (a
// snapshot of amountDueCents itself, taken when the review was created —
// see matchBillNoticeAmounts, bill-notice-sync.ts), NOT expectedAmountCents
// (the flat per-cycle minimum) — those only coincide when the debt has zero
// arrears, so a behind debt's amountDueCents could never refresh on confirm
// even on a genuinely untouched cycle (real finding, 2026-09-22 code
// review). expectedAmountDueCents is null only for a pre-migration row;
// treated as "don't refresh" rather than guessing.
export function shouldRefreshAmountDueOnEmailConfirm(
  currentAmountDueCents: number,
  expectedAmountDueCents: number | null,
): boolean {
  return expectedAmountDueCents !== null && currentAmountDueCents === expectedAmountDueCents;
}

export type PendingDebtAmountReview = {
  id: string;
  debtName: string;
  expectedAmountCents: number;
  observedAmountCents: number;
  source: "BANK_SYNC" | "EMAIL";
  dueDate: Date | null;
};

// Dashboard card data (see debt-amount-review-card.tsx) — every pending
// "did your minimum change?" question across the household, oldest first.
export async function getPendingDebtAmountReviews(householdId: string): Promise<PendingDebtAmountReview[]> {
  const reviews = await db.debtAmountReview.findMany({
    where: { householdId },
    orderBy: { createdAt: "asc" },
    include: {
      debtPayment: {
        include: { debt: { select: { name: true, account: { select: { displayName: true } } } } },
      },
    },
  });
  return reviews.map((r) => ({
    id: r.id,
    debtName: debtDisplayName(r.debtPayment.debt),
    expectedAmountCents: r.expectedAmountCents,
    observedAmountCents: r.observedAmountCents,
    source: r.source,
    dueDate: r.dueDate,
  }));
}

export type PendingDebtBalanceReview = {
  id: string;
  debtName: string;
};

// Dashboard card data (see debt-balance-review-card.tsx) — every manual
// REVOLVING debt whose auto-derived balance (matchDebtPayments) just hit
// $0, oldest first, still awaiting a "yes, paid off" / "no" answer.
export async function getPendingDebtBalanceReviews(householdId: string): Promise<PendingDebtBalanceReview[]> {
  const reviews = await db.debtBalanceReview.findMany({
    where: { householdId },
    orderBy: { createdAt: "asc" },
    include: { debt: { select: { name: true, account: { select: { displayName: true } } } } },
  });
  return reviews.map((r) => ({ id: r.id, debtName: debtDisplayName(r.debt) }));
}

// The debt-payment counterpart to detectMerchantBillSuggestions — moved
// here from bill-detect.ts (was detectDebtPaymentBillSuggestions) as part
// of splitting debt payments into their own concept. A checking-side
// payment toward a credit card or loan is classified isTransfer:true the
// moment it syncs (correctly excluded from bucket spend — see
// simplefin-sync.ts) — which used to also silently exclude it from ever
// being suggested for tracking, even though a household very much wants to
// see "Capital One — $145/mo" alongside their other debts. Grouped by
// debtId, not merchant text: the same merchant string can mean two
// different things (a household's card issuer can share a display name
// with a retailer they also shop at), so text grouping would silently
// merge two unrelated transaction populations. REVOLVING only — an
// INSTALLMENT (BNPL) debt needs a purchase date/cadence/payment-count set up
// front (matchInstallmentPayments' matching floor), not inferred from
// after-the-fact transaction history the way this function works; BNPL
// suggestions live on /debts instead, via detectUnlinkedBnpl below.
export async function detectDebtPaymentSuggestions(householdId: string): Promise<BillSuggestion[]> {
  const since = new Date(Date.now() - 400 * DAY_MS);
  const [dismissedKeys, allDebts, existingDebtPayments, bnplKeywords] = await Promise.all([
    getDismissedBillKeys(householdId),
    db.debt.findMany({
      where: { householdId, debtType: "REVOLVING" },
      select: { id: true, name: true, bnplKeyword: true, account: { select: { accountType: true, displayName: true } } },
    }),
    db.debtPayment.findMany({ where: { householdId }, select: { debtId: true } }),
    allBnplKeywords(householdId),
  ]);
  // debtType alone isn't reliable here — a household can (and does, in
  // practice) have a BNPL plan sitting as plain REVOLVING with no
  // installment fields ever set, e.g. one added by hand before this
  // distinction existed — so the same name-keyword check that already
  // excludes BNPL from the merchant-based path is applied here too.
  // resolveBnplKeyword, not a bare re-run of the `.some` check — every
  // other BNPL-identity call site in the app was migrated to resolve
  // through the pinned Debt.bnplKeyword when one exists (real finding,
  // 2026-09-12 code review: this was the one site still re-deriving from
  // the live, renamable name every time); backfillBnplKeywords only ever
  // pins it for a debtType:"INSTALLMENT" plan, so this reads it purely as a
  // best-effort upgrade — a REVOLVING debt with no pinned keyword yet falls
  // back to exactly the same live-name check as before (see bnplKeyword's
  // own schema comment on that fallback being the deliberate default).
  const debts = allDebts.filter((d) => !resolveBnplKeyword(d, bnplKeywords));
  if (debts.length === 0) return [];

  const trackedDebtIds = new Set(existingDebtPayments.map((b) => b.debtId));
  // The suggestion card's label (SuggestionListWarning renders item.merchant)
  // — friendly name, not the raw Debt.name.
  const debtNameById = new Map(debts.map((d) => [d.id, debtDisplayName(d)] as const));
  const isCreditCardById = new Map(debts.map((d) => [d.id, d.account?.accountType === "CREDIT_CARD"] as const));
  const candidateDebtIds = debts.map((d) => d.id).filter((id) => !trackedDebtIds.has(id));
  if (candidateDebtIds.length === 0) return [];

  const txns = await db.transaction.findMany({
    where: {
      householdId,
      amountCents: { gt: 0 },
      isTransfer: true,
      debtId: { in: candidateDebtIds },
      occurredOn: { gte: since },
    },
    orderBy: { occurredOn: "asc" },
    select: { id: true, debtId: true, amountCents: true, occurredOn: true },
  });

  const groups = new Map<string, typeof txns>();
  for (const t of txns) {
    if (!t.debtId) continue;
    const key = `debt:${t.debtId}`;
    if (dismissedKeys.has(key)) continue;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const suggestions: BillSuggestion[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;

    const gaps = group.slice(1).map((t, i) => (t.occurredOn.getTime() - group[i].occurredOn.getTime()) / DAY_MS);
    const classified = classifyCadence(gaps);
    if (!classified) continue;
    if (group.length < MIN_OCCURRENCES[classified.cadence]) continue;

    const last = group[group.length - 1];
    const debtId = last.debtId!;
    const amountCents = Math.round(group.reduce((s, t) => s + t.amountCents, 0) / group.length);

    suggestions.push({
      key,
      merchant: debtNameById.get(debtId) ?? "Card payment",
      amountCents,
      cadence: classified.cadence,
      nextDueDate: nextBillDueDate(classified.cadence, last.occurredOn, group.map((t) => t.occurredOn)),
      lastSeenDate: last.occurredOn,
      occurrences: group.length,
      transactionIds: group.map((t) => t.id),
      aiSuggestedBucketId: null,
      debtId,
      isCreditCard: isCreditCardById.get(debtId) ?? false,
    });
  }

  return suggestions;
}

export type PlannedExtraThisWeek = {
  debtName: string;
  // Total payoff-plan extra allocated to this debt across every paycheck
  // landing this calendar week (a week can hold two paychecks).
  amountCents: number;
  // Earliest paycheck date the plan puts extra on this week — the row's
  // due date when there's no real minimum-payment tracker to anchor to.
  dueDate: Date;
  // Every (debt, paycheck) allocation this week has a PayoffExtraConfirmation
  // — the "confirmed this cycle" checkbox from /debts.
  confirmed: boolean;
  // The simulation projects one of this week's extra allocations to take the
  // debt's balance to $0 — drives the card's "pays off" star / "For Payoff!"
  // badge on a debt with no minimum-payment tracker of its own.
  paysOff: boolean;
  // Every source this week's allocations drew from, across every paycheck —
  // when a week holds two paychecks each with their own pool, their parts are
  // just concatenated rather than merged by name, so the hover breakdown
  // lists one line per (paycheck, source) pair instead of collapsing them.
  poolBreakdown?: PoolBreakdown;
};

type PlannedExtraAllocation = {
  debtId: string;
  name: string;
  date: Date;
  amountCents: number;
  isPayoff: boolean;
  poolBreakdown?: PoolBreakdown;
};

// Both "planned extra by debt" readers below want the same ~2-month horizon;
// the dashboard renders both in one pass, so `cache()` collapses their
// identical calls to a single simulation per request.
const PLANNED_EXTRA_LOOKAHEAD_MONTHS = 2;

// Every payoff-plan "extra" allocation (per debt, per paycheck date) across
// the next `monthsCount` calendar months — the shared source for the two
// "planned extra by debt" readers below. Runs the exact same
// projectCyclePlan simulation getPaymentCalendarThisCycle /
// getPaymentCalendarIcsEvents use (real corrected due dates via
// correctedDueDateByDebtId, real slot-based "minimum already paid this
// cycle" status), so the dashboard's "This Week's Bills" numbers can never
// disagree with the Payoff Plan calendar card sitting right next to it
// (they did before 2026-08-30: this path still ran the due-date-unaware
// projectPaymentCalendar, so a debt whose minimum was really paid but whose
// DebtPayment.nextDueDate had blind-rolled forward projected a phantom
// minimum + interest tick, understating what its early extra payment would
// actually pay down — real report: Capital One Quicksilver reading $15.33).
// Returns null when there's nothing to project (plan off, no income
// schedule, no active plan-included debts).
const projectHouseholdExtraAllocations = cache(async function projectHouseholdExtraAllocations(
  householdId: string,
  monthsCount: number,
): Promise<{ allocations: PlannedExtraAllocation[]; postedExtraNetted: Map<string, number> } | null> {
  const household = await db.household.findUniqueOrThrow({
    where: { id: householdId },
    select: {
      payoffPlanEnabled: true,
      payoffOrder: true,
      payoffExtraCents: true,
      payoffRollFreedMinimums: true,
      payoffRollFreedMinimumsSplit: true,
    },
  });
  if (!household.payoffPlanEnabled) return null;

  const income = await getPrimaryIncomeSchedule(householdId);
  if (!income) return null;

  const allDebts = await db.debt.findMany({
    where: { householdId },
    orderBy: { sortOrder: "asc" },
    include: { account: { select: { displayName: true } } },
  });
  const activeDebts = allDebts.filter((d) => d.balanceCents > 0 && d.includeInPayoffPlan);
  if (activeDebts.length === 0) return null;
  const inPlanIds = new Set(activeDebts.map((d) => d.id));
  const nameById = new Map(allDebts.map((d) => [d.id, debtDisplayName(d)]));

  const debtPayments = await db.debtPayment.findMany({
    where: { householdId, debtId: { in: allDebts.map((d) => d.id) }, active: true },
    select: {
      debtId: true,
      cadence: true,
      nextDueDate: true,
      lastPaidDate: true,
      createdAt: true,
      amountCents: true,
      payments: { select: { amountCents: true, occurredOn: true } },
    },
  });

  const { start: monthStart, end: monthEnd } = utcPeriodBounds(currentPeriodKey());
  const debtMetaById = new Map(
    allDebts.map((d) => [
      d.id,
      {
        debtType: d.debtType,
        purchaseDate: d.purchaseDate,
        installmentsRemaining: d.installmentsRemaining,
        balanceCents: d.balanceCents,
        paidOffDate: d.paidOffDate,
      },
    ]),
  );
  const dueDateByDebtId = correctedDueDateByDebtId(
    debtPayments,
    monthStart,
    monthEnd,
    debtMetaById,
    new Set(),
    await planExtraTargetsByDebt(householdId, monthStart, monthEnd),
  );

  // Only the debts whose current cycle is genuinely paid per the real ledger
  // — same primitive getPaymentCalendarThisCycle keys its "due" events off
  // (correctedDueDateByDebtId's slot-based cyclePaid), not
  // DebtPayment.amountDueCents, which routinely sits stale-high.
  const minimumSatisfiedThisCycleIds = new Set<string>();
  for (const p of debtPayments) {
    if (dueDateByDebtId.get(p.debtId)?.cyclePaid) minimumSatisfiedThisCycleIds.add(p.debtId);
  }

  // Every still-owed debt, in-plan or not (excluded debts still get their own
  // minimum schedule simulated so the attack-order balance trajectory is
  // right — extraEligibleIds keeps cascaded extra off them). Mirrors
  // getPaymentCalendarThisCycle's debtInputs exactly.
  const debtInputs: DebtInput[] = allDebts
    .filter((d) => d.balanceCents > 0)
    .map((d) => ({
      id: d.id,
      name: debtDisplayName(d),
      balanceCents: d.balanceCents,
      aprBasisPoints: d.aprBasisPoints,
      minPaymentCents: d.minPaymentCents,
      debtType: d.debtType,
      paymentCadence: dueDateByDebtId.get(d.id)?.cadence,
    }));

  const alreadyFreedMinimums = await getAlreadyFreedMinimums(householdId, household.payoffRollFreedMinimums);
  const extraPaidThisCycleByDebtId = new Map(
    [...dueDateByDebtId.entries()].map(([id, v]) => [id, v.extraPaidCents]),
  );
  const skippedExtraPairs = await getPayoffExtraSkips(householdId);

  const postedExtraNetted = new Map<string, number>();
  const months = projectCyclePlan(debtInputs, {
    order: household.payoffOrder as PayoffOrder,
    rollFreedMinimums: household.payoffRollFreedMinimums,
    rollFreedMinimumsSplit: household.payoffRollFreedMinimumsSplit,
    extraPerPaycheckCents: household.payoffExtraCents,
    income,
    monthsCount,
    minimumSatisfiedThisCycleIds,
    dueDateByDebtId,
    alreadyFreedMinimums,
    extraEligibleIds: inPlanIds,
    extraPaidThisCycleByDebtId,
    skippedExtraPairs,
    postedExtraNettedOut: postedExtraNetted,
  });

  const out: PlannedExtraAllocation[] = [];
  for (const month of months) {
    for (const entry of month.debts) {
      for (const line of entry.lines) {
        // A skipped line is an explicit "not paying this one" — drop it from
        // "This Week's Bills" / bucket totals entirely. A pending (not yet
        // posted, not skipped) line is kept: it's the genuine outstanding
        // to-do those surfaces exist to show.
        if (line.kind !== "extra" || line.skipped) continue;
        out.push({
          debtId: entry.debtId,
          name: nameById.get(entry.debtId) ?? "Debt",
          date: line.date,
          amountCents: line.amountCents,
          isPayoff: line.isPayoff,
          poolBreakdown: line.poolBreakdown,
        });
      }
    }
  }
  return { allocations: out, postedExtraNetted };
});

// Plain per-debt total of payoff-plan extra allocated within [start, end) —
// the ceiling piece for "how much of a bucket-assigned debt payment counts
// as budgeted spend" (see spendByBucketInRange, src/lib/buckets.ts). Cents
// only, no confirmation / name / date detail (that's plannedExtraByDebtThisWeek's
// job for the dashboard card).
export async function plannedExtraCentsByDebtInRange(
  householdId: string,
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const byDebtId = new Map<string, number>();
  const allocations = (await projectHouseholdExtraAllocations(householdId, PLANNED_EXTRA_LOOKAHEAD_MONTHS))?.allocations;
  if (!allocations) return byDebtId;
  for (const alloc of allocations) {
    if (alloc.date < start || alloc.date >= end) continue;
    byDebtId.set(alloc.debtId, (byDebtId.get(alloc.debtId) ?? 0) + alloc.amountCents);
  }
  return byDebtId;
}

// Bare read of Household.payoffPlanEnabled — the /debts "count planned extra
// as real spend" toggle. Bucket totals use it to decide whether a
// bucket-assigned debt payment past its minimum is intentional planned
// paydown (plan on → all of it counts) or an ad-hoc lump the bucket cap
// wasn't sized for (plan off → surfaced on its own in the spend breakdown).
// See budgetedDebtPaymentCents, src/lib/debt-payment-budget.ts. cache()d so
// getBucketsWithProgress and the bucket page share one query.
export const isPayoffPlanEnabled = cache(async function isPayoffPlanEnabled(
  householdId: string,
): Promise<boolean> {
  const household = await db.household.findUnique({
    where: { id: householdId },
    select: { payoffPlanEnabled: true },
  });
  return household?.payoffPlanEnabled ?? false;
});

export type PlannedExtraLine = { date: string; amountCents: number; isPayoff: boolean; poolBreakdown?: PoolBreakdown };

// Per-debt payoff-plan extra allocations landing in [start, end), kept as
// individual dated lines (ISO date strings) rather than summed — the
// projected green "extra toward principal" rows a debt payment card shows in
// a bucket's / the Recurring page's "This Month" ledger, mirroring the same
// lines DebtRow already renders on /debts (expectedExtras). Same
// projectCyclePlan simulation as plannedExtraCentsByDebtInRange, which stays
// the reader for the pure budget-ceiling cents total.
export async function plannedExtraByDebtInPeriod(
  householdId: string,
  start: Date,
  end: Date,
): Promise<Map<string, PlannedExtraLine[]>> {
  const byDebtId = new Map<string, PlannedExtraLine[]>();
  const allocations = (await projectHouseholdExtraAllocations(householdId, PLANNED_EXTRA_LOOKAHEAD_MONTHS))?.allocations;
  if (!allocations) return byDebtId;
  for (const alloc of allocations) {
    if (alloc.date < start || alloc.date >= end || alloc.amountCents <= 0) continue;
    const arr = byDebtId.get(alloc.debtId) ?? [];
    arr.push({
      date: alloc.date.toISOString().slice(0, 10),
      amountCents: alloc.amountCents,
      isPayoff: alloc.isPayoff,
      poolBreakdown: alloc.poolBreakdown,
    });
    byDebtId.set(alloc.debtId, arr);
  }
  for (const arr of byDebtId.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return byDebtId;
}

// Per debt, how much of this cycle's real posted extra the plan simulation
// already netted against its past-payday line — pass to confirmProjectedExtras
// (debt-payoff.ts) alongside plannedExtraByDebtInPeriod's lines so the same
// money can't also confirm a future projected line.
export async function postedExtraNettedByDebt(householdId: string): Promise<Map<string, number>> {
  return (await projectHouseholdExtraAllocations(householdId, PLANNED_EXTRA_LOOKAHEAD_MONTHS))?.postedExtraNetted ?? new Map();
}

// Shared DB reader behind both superseded-target readers below — one query
// for the whole household (not one per debt inside a render loop), grouped
// and ISO-stringified so either caller can hand the same rows to either pure
// filter in debt-payoff.ts. Scoped by `dueDate` — the date the planned money
// was expected to move — matching how each caller scopes the real-payment
// total it reconciles against.
async function getSupersededSnapshotRowsByDebtId(
  householdId: string,
  start: Date,
  end: Date,
): Promise<Map<string, PayoffExtraSnapshotLine[]>> {
  const rows = await db.payoffExtraSnapshot.findMany({
    where: { householdId, isPayoff: true, dueDate: { gte: start, lt: end } },
    select: { debtId: true, weekStart: true, dueDate: true, amountCents: true, isPayoff: true },
  });
  const byDebtId = new Map<string, PayoffExtraSnapshotLine[]>();
  for (const r of rows) {
    const arr = byDebtId.get(r.debtId) ?? [];
    arr.push({
      weekStart: r.weekStart.toISOString().slice(0, 10),
      dueDate: r.dueDate.toISOString().slice(0, 10),
      amountCents: r.amountCents,
      isPayoff: r.isPayoff,
    });
    byDebtId.set(r.debtId, arr);
  }
  return byDebtId;
}

// Per-debt superseded payoff-extra cents for [start, end) — the money that
// already retired a payoff target the live plan has since dropped, which must
// not be double-credited toward a fresh one. See supersededPayoffExtraCents
// (debt-payoff.ts) for the full reasoning; this is just its DB reader.
//
// Returns a Map the same shape/scope as plannedExtraByDebtInPeriod above so
// both server readers can await them together and index by debtId.
export async function supersededPayoffExtraByDebtInPeriod(
  householdId: string,
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const byDebtId = await getSupersededSnapshotRowsByDebtId(householdId, start, end);
  const currentWeekStart = currentWeekBounds().start.toISOString().slice(0, 10);
  const out = new Map<string, number>();
  for (const [debtId, snapshots] of byDebtId) {
    const cents = supersededPayoffExtraCents(snapshots, currentWeekStart);
    if (cents > 0) out.set(debtId, cents);
  }
  return out;
}

// Per-debt list of still-open dropped-target amounts (not summed) for
// [start, end) — see supersededPayoffTargetAmounts (debt-payoff.ts) for why
// the Payment Calendar's isExtraPaid badge needs each target's own amount
// instead of one aggregate pool.
export async function supersededPayoffTargetAmountsByDebtInPeriod(
  householdId: string,
  start: Date,
  end: Date,
): Promise<Map<string, number[]>> {
  const byDebtId = await getSupersededSnapshotRowsByDebtId(householdId, start, end);
  const currentWeekStart = currentWeekBounds().start.toISOString().slice(0, 10);
  const out = new Map<string, number[]>();
  for (const [debtId, snapshots] of byDebtId) {
    const amounts = supersededPayoffTargetAmounts(snapshots, currentWeekStart);
    if (amounts.length > 0) out.set(debtId, amounts);
  }
  return out;
}

// Per-debt payoff-plan extra for this calendar week (src/lib/debt-payoff.ts's
// projectCyclePlan, via projectHouseholdExtraAllocations) — only when
// Household.payoffPlanEnabled (off by default). Folded into each debt's row
// by getDebtPaymentsThisWeek below so the dashboard's "This week's bills"
// card shows one line per debt (minimum + planned extra together) rather
// than two competing rows.
export async function plannedExtraByDebtThisWeek(
  householdId: string,
): Promise<Map<string, PlannedExtraThisWeek>> {
  const empty = new Map<string, PlannedExtraThisWeek>();

  const allocations = (await projectHouseholdExtraAllocations(householdId, PLANNED_EXTRA_LOOKAHEAD_MONTHS))?.allocations;
  if (!allocations) return empty;

  const { start, end } = currentWeekBounds();
  const thisWeek = allocations.filter((a) => a.date >= start && a.date < end && a.amountCents > 0);
  if (thisWeek.length === 0) return empty;

  const confirmations = await db.payoffExtraConfirmation.findMany({
    where: {
      householdId,
      paycheckDate: { gte: start, lt: end },
      debtId: { in: thisWeek.map((a) => a.debtId) },
    },
    select: { debtId: true, paycheckDate: true },
  });
  const confirmedKeys = new Set(
    confirmations.map((c) => `${c.debtId}:${c.paycheckDate.toISOString().slice(0, 10)}`),
  );

  const byDebtId = new Map<string, PlannedExtraThisWeek>();
  for (const alloc of thisWeek) {
    const dateKey = alloc.date.toISOString().slice(0, 10);
    const existing = byDebtId.get(alloc.debtId);
    const allocConfirmed = confirmedKeys.has(`${alloc.debtId}:${dateKey}`);
    if (existing) {
      existing.amountCents += alloc.amountCents;
      existing.confirmed = existing.confirmed && allocConfirmed;
      existing.paysOff = existing.paysOff || alloc.isPayoff;
      if (alloc.date < existing.dueDate) existing.dueDate = alloc.date;
      if (alloc.poolBreakdown) {
        existing.poolBreakdown = { parts: [...(existing.poolBreakdown?.parts ?? []), ...alloc.poolBreakdown.parts] };
      }
    } else {
      byDebtId.set(alloc.debtId, {
        debtName: alloc.name,
        amountCents: alloc.amountCents,
        dueDate: alloc.date,
        confirmed: allocConfirmed,
        poolBreakdown: alloc.poolBreakdown,
        paysOff: alloc.isPayoff,
      });
    }
  }
  return byDebtId;
}

// Persists this week's live plan (plannedExtraByDebtThisWeek) into
// PayoffExtraSnapshot so a later "Last Week's Bills"-style read has a real
// record of what was actually planned *as of that week*, instead of asking
// the live plan (which only ever knows today's current balances/priority
// order — real household correction, 2026-09-06: re-asking it for a past
// week showed today's priority order, Amazon/Venture, when the household's
// own real answer for that week was Sam's Club, then Quicksilver, then
// Amazon). Upserted every sync (see syncHousehold, simplefin-sync.ts) —
// only ever touches *this* week's row (keyed by debtId+weekStart, one row
// per debt per week), so once a new week starts this week's rows are never
// written again and stand as the permanent historical record. A debt that
// drops out of the live plan entirely this week (paid off, un-planned, or
// genuinely skipped) just stops getting a fresh upsert — its last-known row
// simply stays as whatever it was, which is correct: the plan really did
// last say that, right up until it didn't apply anymore.
export async function snapshotPlannedExtraForCurrentWeek(householdId: string): Promise<void> {
  const plannedExtraByDebt = await plannedExtraByDebtThisWeek(householdId);
  if (plannedExtraByDebt.size === 0) return;
  const { start: weekStart } = currentWeekBounds();
  await db.$transaction(
    [...plannedExtraByDebt.entries()].map(([debtId, planned]) =>
      db.payoffExtraSnapshot.upsert({
        where: { debtId_weekStart: { debtId, weekStart } },
        create: {
          householdId,
          debtId,
          weekStart,
          dueDate: planned.dueDate,
          amountCents: planned.amountCents,
          isPayoff: planned.paysOff,
        },
        update: {
          dueDate: planned.dueDate,
          amountCents: planned.amountCents,
          isPayoff: planned.paysOff,
        },
      }),
    ),
  );
}

// The historical counterpart to plannedExtraByDebtThisWeek, for any week
// that isn't the real current one — reads PayoffExtraSnapshot instead of
// re-simulating the live plan (see snapshotPlannedExtraForCurrentWeek's own
// comment for why the live plan can't answer this honestly for a past
// week). Returns nothing for a week that predates this feature shipping
// (2026-09-06) — there was nothing to snapshot yet, and reconstructing one
// after the fact from today's plan is exactly the wrong answer this whole
// table exists to avoid.
async function plannedExtraSnapshotForWeek(
  householdId: string,
  weekStart: Date,
): Promise<Map<string, PlannedExtraThisWeek>> {
  const empty = new Map<string, PlannedExtraThisWeek>();

  const rows = await db.payoffExtraSnapshot.findMany({
    where: { householdId, weekStart },
    select: { debtId: true, dueDate: true, amountCents: true, isPayoff: true, debt: { select: { name: true, account: { select: { displayName: true } } } } },
  });
  if (rows.length === 0) return empty;

  // The snapshot is only ever written while the live plan still lists the
  // extra, so a skip made *afterward* (Amazon Card's Sep 17 $100, skipped Sep
  // 19 — 2026-09-20 report) left the frozen row standing and "Last Week's
  // Bills" kept it open. A household-skipped (debt, payday) is "not paying
  // this one" — drop it here, same as the live path drops skipped lines.
  const liveRows = withoutSkippedExtras(rows, await getPayoffExtraSkips(householdId));
  if (liveRows.length === 0) return empty;

  const confirmations = await db.payoffExtraConfirmation.findMany({
    where: { householdId, debtId: { in: liveRows.map((r) => r.debtId) }, paycheckDate: { in: liveRows.map((r) => r.dueDate) } },
    select: { debtId: true, paycheckDate: true },
  });
  const confirmedKeys = new Set(
    confirmations.map((c) => `${c.debtId}:${c.paycheckDate.toISOString().slice(0, 10)}`),
  );

  const byDebtId = new Map<string, PlannedExtraThisWeek>();
  for (const row of liveRows) {
    const dateKey = row.dueDate.toISOString().slice(0, 10);
    byDebtId.set(row.debtId, {
      debtName: debtDisplayName(row.debt),
      amountCents: row.amountCents,
      dueDate: row.dueDate,
      confirmed: confirmedKeys.has(`${row.debtId}:${dateKey}`),
      paysOff: row.isPayoff,
    });
  }
  return byDebtId;
}

// A debt already paid off (balanceCents <= 0) still keeps its
// minPaymentCents on record — with "roll freed minimums" on, that's freed
// cash flow that should route to whatever's still owed. Just the DB fetch;
// the actual filter/sort/freedMonthKey math is computeAlreadyFreedMinimums
// (debt-payoff.ts), shared with payoff-planner.tsx's own client-side live
// preview so the two can't drift apart again (real household report,
// 2026-09-09: they had — the client copy was missing freedMonthKey
// entirely, rolling a same-month payoff's minimum in a cycle early).
async function getAlreadyFreedMinimums(
  householdId: string,
  rollFreedMinimums: boolean,
): Promise<FreedMinimumSource[]> {
  if (!rollFreedMinimums) return [];
  const debts = await db.debt.findMany({
    where: {
      householdId,
      balanceCents: { lte: 0 },
      includeInPayoffPlan: true,
      OR: [{ minPaymentCents: { gt: 0 } }, { freedMinimumCents: { gt: 0 } }],
    },
    select: {
      id: true,
      name: true,
      minPaymentCents: true,
      freedMinimumCents: true,
      paidOffDate: true,
      account: { select: { displayName: true } },
    },
  });
  if (debts.length === 0) return [];
  const payments = await db.debtPayment.findMany({
    where: { householdId, debtId: { in: debts.map((d) => d.id) }, active: true },
    select: { debtId: true, cadence: true },
  });
  const cadenceByDebtId = new Map(payments.map((p) => [p.debtId, p.cadence]));
  return computeAlreadyFreedMinimums(
    debts.map((d) => ({
      id: d.id,
      name: debtDisplayName(d),
      balanceCents: 0,
      minPaymentCents: d.minPaymentCents,
      freedMinimumCents: d.freedMinimumCents,
      includeInPayoffPlan: true,
      paidOffDate: d.paidOffDate,
      paymentCadence: cadenceByDebtId.get(d.id),
    })),
  );
}

// Every household-skipped (debt, payday) pair — see PayoffExtraSkip and
// src/app/debts/actions.ts's skipPayoffExtra/unskipPayoffExtra. The date
// filter is only a row-count guard, not the source of correctness — a skip
// only ever suppresses a line projectCyclePlan actually emits (the current
// cycle's own pending payday), so a stale row past its cycle is simply never
// matched and ages out on its own; querying from the *start of the previous*
// calendar month rather than "today" avoids un-skipping a payday the moment
// the calendar day rolls over while that skip is still the current cycle's
// own. Exported plain-row shape (debts/page.tsx passes this straight through
// to the client "use client" PayoffPlanner as a prop); getPayoffExtraSkips
// below reshapes it into the Set projectCyclePlan's skippedExtraPairs opt
// expects.
export async function getPayoffExtraSkipRows(
  householdId: string,
): Promise<{ debtId: string; paycheckDate: string; amountCents: number | null; isPayoff: boolean | null }[]> {
  const now = todayAsUTCDate();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const skips = await db.payoffExtraSkip.findMany({
    where: { householdId, paycheckDate: { gte: since } },
    select: { debtId: true, paycheckDate: true, amountCents: true, isPayoff: true },
  });
  return skips.map((s) => ({
    debtId: s.debtId,
    paycheckDate: s.paycheckDate.toISOString().slice(0, 10),
    amountCents: s.amountCents,
    isPayoff: s.isPayoff,
  }));
}

// Pure — drops every (debtId, dueDate) the household skipped from a set of
// frozen PayoffExtraSnapshot rows. `skippedPairs` is getPayoffExtraSkips'
// "debtId:YYYY-MM-DD" shape.
export function withoutSkippedExtras<T extends { debtId: string; dueDate: Date }>(
  rows: T[],
  skippedPairs: ReadonlySet<string>,
): T[] {
  return rows.filter((r) => !skippedPairs.has(`${r.debtId}:${r.dueDate.toISOString().slice(0, 10)}`));
}

// "debtId:YYYY-MM-DD" of every covered minimum skipped this month
// (DebtMinimumSkip) — same key shape as getPayoffExtraSkips.
export async function getSkippedMinimumKeys(householdId: string, monthStart: Date, monthEnd: Date): Promise<Set<string>> {
  const rows = await db.debtMinimumSkip.findMany({
    where: { householdId, dueDate: { gte: monthStart, lt: monthEnd } },
    select: { debtId: true, dueDate: true },
  });
  return new Set(rows.map((r) => `${r.debtId}:${r.dueDate.toISOString().slice(0, 10)}`));
}

async function getPayoffExtraSkips(householdId: string): Promise<Set<string>> {
  const rows = await getPayoffExtraSkipRows(householdId);
  return new Set(rows.map((r) => `${r.debtId}:${r.paycheckDate}`));
}

// Corrects each debt's dueDateByDebtId entry the same way payoff-planner.tsx
// (via page.tsx's cycleMinimum) does, instead of trusting DebtPayment.
// nextDueDate directly — needed in both directions:
//   - A debt with an unresolved backlog can have nextDueDate already rolled
//     past a still-outstanding slot (real case, 2026-08-26: Capital One
//     Quicksilver's own unpaid August minimum was silently skipped from the
//     ICS feed's simulation entirely, jumping straight to September and
//     understating how much it still needs before extra cascades onto other
//     debts). Prefer the latest occurrence actually landing in the current
//     calendar month when one is still unpaid there.
//   - A debt that's already caught up this cycle needs the *opposite*
//     correction — its period-slot occurrence is a past, already-settled
//     date, and feeding that into projectCyclePlan double-counts a minimum
//     deduction and an interest tick against a balance that already
//     reflects them (see debt-row.tsx's CycleMinimum.nextDueDate comment).
// Mirrors buildCycleSlots' inputs exactly (same nextDueDate/cadence/real-
// payments-this-period) so the calendar feed and dashboard mini calendar
// agree with the in-app Payoff Calendar's own hover data instead of each
// silently drifting from it in its own direction.
type CorrectedDue = {
  date: Date;
  cadence: BillCadence;
  cyclePaid: boolean;
  // Unskipped "covered minimum" slot dates this month — see resolveMinimumLedger.
  coveredSlotDates: Date[];
  extraPaidCents: number;
  extraPaidTimes: Set<number>;
};

// Each debt's planned payoff-plan extras with a payday in [start, end) — the
// frozen weekly PayoffExtraSnapshot rows (one per debt per week), which is
// what splitPlanExtraPayments (cycle-slots.ts) matches real payments against
// so a paid plan extra isn't mistaken for the minimum.
export async function planExtraTargetsByDebt(
  householdId: string,
  start: Date,
  end: Date,
): Promise<Map<string, { date: Date; amountCents: number }[]>> {
  const rows = await db.payoffExtraSnapshot.findMany({
    where: { householdId, dueDate: { gte: start, lt: end }, amountCents: { gt: 0 } },
    select: { debtId: true, dueDate: true, amountCents: true },
  });
  const byDebt = new Map<string, { date: Date; amountCents: number }[]>();
  for (const r of rows) {
    const list = byDebt.get(r.debtId) ?? [];
    list.push({ date: r.dueDate, amountCents: r.amountCents });
    byDebt.set(r.debtId, list);
  }
  return byDebt;
}

function correctedDueDateByDebtId(
  payments: {
    debtId: string;
    nextDueDate: Date;
    cadence: BillCadence;
    createdAt: Date;
    lastPaidDate?: Date | null;
    // The tracker's own per-occurrence minimum — 0 for a no-minimum debt
    // (ignoreMinimumPayment). Needed to size a single slot's own overage
    // below; a no-minimum debt never reports one (see extraPaidCents).
    amountCents: number;
    // The tracker's rolling amount owed — optional; only gates the "covered
    // minimum" state (ledgerMinimumCents), where arrears disable it.
    amountDueCents?: number;
    payments: { amountCents: number; occurredOn: Date }[];
  }[],
  monthStart: Date,
  monthEnd: Date,
  // Per-debt type/purchase-date, for the same INSTALLMENT phantom-slot clamp
  // /debts and the Bucket/`/bills` ledgers apply (see debts/page.tsx's
  // slotsPeriodStart comment) — without it a mid-month BNPL purchase
  // projects a phantom pre-purchase slot that never gets a payment, so
  // `cyclePaid` reads false and this feed shows a due date for a cycle
  // that's already settled. Optional so a caller with no INSTALLMENT debts
  // in scope can skip building the map.
  debtMetaById?: Map<
    string,
    {
      debtType: string;
      purchaseDate: Date | null;
      installmentsRemaining?: number | null;
      balanceCents?: number;
      paidOffDate?: Date | null;
    }
  >,
  // "debtId:YYYY-MM-DD" of every covered minimum the household skipped
  // (DebtMinimumSkip) — only the calendars/ICS pass it; see coveredSlotDates.
  skippedMinimumKeys: ReadonlySet<string> = new Set(),
  // planExtraTargetsByDebt — a payment matching one of these is a paid plan
  // extra, kept out of the minimum slots (splitPlanExtraPayments).
  planExtrasByDebtId: ReadonlyMap<string, { date: Date; amountCents: number }[]> = new Map(),
): Map<string, CorrectedDue> {
  const dueDateByDebtId = new Map<string, CorrectedDue>();
  for (const p of payments) {
    const allPaymentsAbs = p.payments.map((t, i) => ({
      id: String(i),
      amountCents: Math.abs(t.amountCents),
      occurredOn: t.occurredOn,
    }));
    const { planExtraPayments, rest: paymentsAbs } = splitPlanExtraPayments(
      allPaymentsAbs,
      planExtrasByDebtId.get(p.debtId) ?? [],
    );
    const meta = debtMetaById?.get(p.debtId);
    // See slotBounds: INSTALLMENT keeps a hard purchase-date floor; a
    // REVOLVING tracker's occurrences are all real, only an *unpaid*
    // pre-createdAt one is hidden — a real pre-createdAt payment still
    // counts toward cyclePaid instead of being dropped.
    const { slots, extraPayments } = buildCycleSlots(
      p.nextDueDate,
      p.cadence,
      monthStart,
      monthEnd,
      paymentsAbs,
      slotBounds(monthStart, {
        debtType: meta?.debtType,
        purchaseDate: meta?.purchaseDate,
        trackerCreatedAt: p.createdAt,
        cadence: p.cadence,
        nextDueDate: p.nextDueDate,
        lastPaidDate: p.lastPaidDate,
        installmentsRemaining: meta?.installmentsRemaining,
      }),
    );
    // Same slot-based cycle status /debts derives for CycleMinimum
    // (debts/page.tsx) — every expected occurrence this calendar month
    // paired positionally against real linked payments. Vacuously true when
    // nothing's expected this month (empty .every() — e.g. an ANNUAL debt
    // due in a different month), same as page.tsx.
    const cyclePaid = slots.every((s) => s.payment !== null);
    // The *first* still-unpaid occurrence this month, not the last — that's
    // the "next unpaid occurrence" contract projectCyclePlan / the dashboard
    // card's dueDate expect. For MONTHLY there's only ever one slot so this
    // is unchanged (still catches an unpaid minimum nextDueDate blind-rolled
    // past), but for a BIWEEKLY/WEEKLY BNPL plan that bills twice a month
    // `slots[last]` was up to a full cadence period later than the real next
    // due date — a Sep-3 Klarna installment showing as "Sep 17" on This
    // Week's Bills, and projectCyclePlan skipping the Sep-3 minimum entirely
    // (real report, 2026-09-01: Klarna–Puma / Affirm–Dick's).
    const firstUnpaid = slots.find((s) => s.payment === null);
    const periodDate =
      firstUnpaid?.date ?? (slots.length > 0 ? slots[slots.length - 1].date : p.nextDueDate);
    // Real payments this cycle beyond the expected minimum slot(s) — what
    // projectCyclePlan's past-payday branch nets its display "pending extra"
    // line against, so a real synced extra payment isn't double-counted on
    // top of the to-do line it should instead be covering/replacing. See
    // extraPaymentsBeyondSlots' own comment (cycle-slots.ts) for why this
    // can't just be buildCycleSlots' own extraPayments once a debt has paid
    // off this month — shared with debts/page.tsx's identical need so the
    // two can't quietly drift apart the way they already have once.
    const planExtraThisMonth = planExtraPayments.filter((t) => t.occurredOn >= monthStart && t.occurredOn < monthEnd);
    const extraTxns = [
      ...planExtraThisMonth,
      ...extraPaymentsBeyondSlots(extraPayments, paymentsAbs, monthStart, monthEnd, {
        paidOffDate: meta?.paidOffDate,
        tracksMinimum: p.amountCents > 0,
      }),
    ];
    const extraPaidCents = extraTxns.reduce((s, t) => s + t.amountCents, 0);
    // Shared with payoff-planner.tsx's own dueDateByDebtId — see
    // correctedNextDueDate's own comment (debt-payoff.ts) for the full
    // incident writeup (Amazon Card, 2026-09-11) this exists to fix, and
    // why it's a shared helper rather than hand-copied per call site.
    const correctedNextDue = correctedNextDueDate(cyclePaid, p.nextDueDate, periodDate, p.cadence);
    // Minimums an earlier, bigger payment already covered — still shown on
    // the calendars unless skipped (resolveMinimumLedger, 2026-09-20).
    const coveredSlotDates = coveredMinimumDates({
      slots,
      extraPayments,
      minimumCents: ledgerMinimumCents({
        paidOff: meta?.balanceCents !== undefined && meta.balanceCents <= 0,
        nextDueThisMonth: p.nextDueDate >= monthStart && p.nextDueDate < monthEnd,
        amountDueCents: p.amountDueCents ?? 0,
        minimumCents: p.amountCents,
      }),
      skippedDates: new Set(
        [...skippedMinimumKeys].flatMap((k) => (k.startsWith(`${p.debtId}:`) ? [k.slice(p.debtId.length + 1)] : [])),
      ),
    });
    dueDateByDebtId.set(p.debtId, {
      date: correctedNextDue,
      cadence: p.cadence,
      cyclePaid,
      coveredSlotDates,
      extraPaidCents,
      // occurredOn timestamps of the real payments this cycle that went
      // beyond the expected minimum slot(s) — lets the payment calendar badge
      // the day an extra payoff-plan payment actually posted, not only the
      // day the plan projected it for (household request, 2026-09-08).
      extraPaidTimes: new Set(extraTxns.map((t) => t.occurredOn.getTime())),
    });
  }
  return dueDateByDebtId;
}

// Read-only "this cycle" payment calendar for the dashboard (see the
// "Payment Calendar" card) — same paid/due/expected day-grid /debts shows in
// its own calendar view, but computed fully server-side from the household's
// *saved* plan settings rather than live-edited draft state (the dashboard
// has no strategy form to preview changes against). Reuses the same
// projectCyclePlan simulation and alreadyFreedMinimums seeding as
// plannedExtraByDebtThisWeek above, so the numbers here never disagree with
// what actually feeds "this week's bills" once Household.payoffPlanEnabled is on.
//
// Always renders as long as there's *something* on the grid (a paid or due
// payment this cycle): the plain minimums-only calendar is useful on its
// own. The projected "extra payment" ("expected") lines are the only part
// gated on the payoff plan actually running — plan enabled, an income
// schedule to place paychecks against, and at least one in-plan debt. With
// no debt activity at all this cycle it still returns null so the dashboard
// can skip the card.
// One combined "everything due this month" grid (household request,
// 2026-09-10) — recurring bills + subscriptions + every debt minimum, plus
// the payoff plan's projected extra payments and payoff-star days *only when
// the plan is actually running* (see `minimumOnly` / the payoffPlanEnabled
// gate on the extra-paid marker below).
export async function getPaymentCalendarThisCycle(
  householdId: string,
): Promise<{ monthDate: Date; eventsByDay: Map<number, CalendarDayEvent[]> } | null> {
  const household = await db.household.findUniqueOrThrow({
    where: { id: householdId },
    select: {
      payoffPlanEnabled: true,
      payoffOrder: true,
      payoffExtraCents: true,
      payoffRollFreedMinimums: true,
      payoffRollFreedMinimumsSplit: true,
    },
  });

  const income = await getPrimaryIncomeSchedule(householdId);

  const allDebts = await db.debt.findMany({
    where: { householdId },
    orderBy: { sortOrder: "asc" },
    include: { account: { select: { displayName: true } } },
  });
  const activeDebts = allDebts.filter((d) => d.balanceCents > 0 && d.includeInPayoffPlan);
  const inPlanIds = new Set(activeDebts.map((d) => d.id));

  // Extra payoff-plan lines only show when the plan is genuinely running.
  // Otherwise this is a plain minimums-only payment calendar.
  const planActive = household.payoffPlanEnabled && !!income && activeDebts.length > 0;

  const debtPayments = await db.debtPayment.findMany({
    where: { householdId, debtId: { in: allDebts.map((d) => d.id) }, active: true },
    select: {
      debtId: true,
      amountCents: true,
      amountDueCents: true,
      cadence: true,
      nextDueDate: true,
      lastPaidDate: true,
      createdAt: true,
      payments: { select: { amountCents: true, occurredOn: true } },
    },
  });
  const paymentByDebtId = new Map(debtPayments.map((p) => [p.debtId, p]));

  const { start: monthStart, end: monthEnd } = utcPeriodBounds(currentPeriodKey());
  const debtMetaById = new Map(
    allDebts.map((d) => [
      d.id,
      {
        debtType: d.debtType,
        purchaseDate: d.purchaseDate,
        installmentsRemaining: d.installmentsRemaining,
        balanceCents: d.balanceCents,
        paidOffDate: d.paidOffDate,
      },
    ]),
  );
  const dueDateByDebtId = correctedDueDateByDebtId(
    debtPayments,
    monthStart,
    monthEnd,
    debtMetaById,
    await getSkippedMinimumKeys(householdId, monthStart, monthEnd),
    await planExtraTargetsByDebt(householdId, monthStart, monthEnd),
  );

  // Slot-based cycle status (correctedDueDateByDebtId's own buildCycleSlots
  // pass) rather than paidThisCycle(DebtPayment.amountDueCents) — that
  // running total is a REVOLVING-only concept (matchInstallmentPayments
  // never maintains it) and can also sit stale-high on a REVOLVING debt
  // whose cycle-satisfying payment got linked by a tracker-creation action
  // that never credited it against amountDueCents. This is the exact
  // primitive /debts' own Payoff Calendar uses (debts/page.tsx's
  // CycleMinimum.paidThisCycle), so the two calendars now agree.
  const minimumSatisfiedThisCycleIds = new Set<string>();
  for (const p of debtPayments) {
    if (dueDateByDebtId.get(p.debtId)?.cyclePaid) minimumSatisfiedThisCycleIds.add(p.debtId);
  }

  // The extra-payment projection — skipped entirely when the payoff plan
  // isn't running (see planActive above), leaving a minimums-only calendar.
  let thisCycle: CyclePlanMonth | undefined;
  if (planActive) {
    // Every still-owed debt, in-plan or not — mirrors payoff-planner.tsx's
    // projectionDebtInputs (household request, 2026-08-21: the dashboard's own
    // mini calendar should show an excluded debt's own normal payment
    // schedule too, same as the /debts page's Payoff Calendar now does, just
    // without any extra cascading onto it — see extraEligibleIds below).
    // paymentCadence comes from the same tracker as dueDateByDebtId above —
    // without it, a freed-up WEEKLY/BIWEEKLY debt's rolled minimum defaults to
    // a MONTHLY assumption inside projectCyclePlan (see getAlreadyFreedMinimums).
    const debtInputs: DebtInput[] = allDebts
      .filter((d) => d.balanceCents > 0)
      .map((d) => ({
        id: d.id,
        name: debtDisplayName(d),
        balanceCents: d.balanceCents,
        aprBasisPoints: d.aprBasisPoints,
        minPaymentCents: d.minPaymentCents,
        debtType: d.debtType,
        paymentCadence: dueDateByDebtId.get(d.id)?.cadence,
      }));

    const alreadyFreedMinimums = await getAlreadyFreedMinimums(householdId, household.payoffRollFreedMinimums);
    const extraPaidThisCycleByDebtId = new Map(
      [...dueDateByDebtId.entries()].map(([id, v]) => [id, v.extraPaidCents]),
    );
    const skippedExtraPairs = await getPayoffExtraSkips(householdId);

    const cyclePlan = projectCyclePlan(debtInputs, {
      order: household.payoffOrder as PayoffOrder,
      rollFreedMinimums: household.payoffRollFreedMinimums,
      rollFreedMinimumsSplit: household.payoffRollFreedMinimumsSplit,
      extraPerPaycheckCents: household.payoffExtraCents,
      income: income!,
      monthsCount: 1,
      minimumSatisfiedThisCycleIds,
      dueDateByDebtId,
      alreadyFreedMinimums,
      extraEligibleIds: inPlanIds,
      extraPaidThisCycleByDebtId,
      skippedExtraPairs,
    });
    thisCycle = cyclePlan[0];
  }

  const minimumOnly =
    !planActive || !thisCycle || (household.payoffExtraCents === 0 && !household.payoffRollFreedMinimums);
  const eventsByDay = new Map<number, CalendarDayEvent[]>();
  const add = (
    date: Date,
    debtName: string,
    amountCents: number | undefined,
    status: CalendarDayEvent["status"],
    inPlan: boolean,
    isPayoff?: boolean,
    poolBreakdown?: PoolBreakdown,
    pendingConfirmation?: boolean,
    isExtraPayment?: boolean,
  ) => {
    const day = date.getUTCDate();
    const list = eventsByDay.get(day) ?? [];
    list.push({ kind: "debt", debtName, amountCents, status, inPlan, isPayoff, poolBreakdown, pendingConfirmation, isExtraPayment });
    eventsByDay.set(day, list);
  };
  // Recurring bills + subscriptions land on the same grid as the debt
  // payments. A "bill" event carries only name/amount/status.
  const addBill = (date: Date, name: string, amountCents: number | undefined, status: CalendarDayEvent["status"]) => {
    const day = date.getUTCDate();
    const list = eventsByDay.get(day) ?? [];
    list.push({ kind: "bill", debtName: name, amountCents, status, inPlan: false });
    eventsByDay.set(day, list);
  };

  // Not just activeDebts — a debt paid off earlier this cycle now has
  // balanceCents === 0 and drops out of activeDebts (it's done, no more
  // projecting), but its final real "paid" payment still needs to render
  // on the calendar with its star, so this walks every debt (not just
  // in-plan ones — household request, 2026-08-21) and relies on the
  // cycle-window check below to keep long-past payoffs from resurfacing.
  // "This cycle" is the real current calendar month (household correction,
  // 2026-08-25 — see debt-row.tsx's CycleMinimum comment) — this grid only
  // ever renders one real UTC month's worth of day cells anyway (monthDate:
  // now below), so filtering by that same month's own bounds instead of a
  // cadence-length window is both simpler and correct: a payment that closed
  // out the *previous* cadence period but landed in this calendar month
  // (e.g. a biweekly debt's 2nd-of-the-month payment) now gets its star.
  // monthStart/monthEnd computed above, alongside dueDateByDebtId's own use
  // of the same current-UTC-month bounds. Every check here anchors to
  // monthStart (utcPeriodBounds of the household's *local* current period),
  // never a bare `new Date()` — read via getUTC*, a raw instant is a month
  // ahead after ~6pm on a month's last day here (TZ=America/Denver), which
  // rendered next month's empty grid and dropped this month's payments
  // (2026-08-31).

  // Per-debt "was this real money ever actually plan-driven" targets — the
  // 2026-09-14 decision (badge any amount past the cycle's own minimum,
  // plan membership be damned) over-corrected: it also badged a BNPL's
  // perfectly ordinary final installment (Affirm–Dick's) and a no-minimum
  // card's plain purchase-driven payoff (Sam's Club, restored then repaid
  // with no plan involvement at all) just because both happened to close
  // the balance out this cycle (real report, 2026-09-16). "Extra" is back to
  // meaning genuine payoff-plan money: a currently in-plan debt still trusts
  // extraPaidTimes outright, but an out-of-plan debt only earns the badge
  // when a real payment's own amount matches one of the debt's *historical*
  // PayoffExtraSnapshot(isPayoff) targets this month — an aggregate shared
  // budget doesn't check *which* payment it credits, only that some money is
  // still owed somewhere, and happily credited an unrelated earlier payment
  // just because it posted first (real report, 2026-09-17: Sam's Club Card's
  // Sep 1 $101.00 — no target of its own — got badged "Extra Payment" purely
  // because it predated the Sep 8 $140.80 payment that actually matched the
  // dropped Sep 3 target). See supersededPayoffTargetAmounts (debt-payoff.ts).
  const supersededTargetsByDebtId = new Map(
    await supersededPayoffTargetAmountsByDebtInPeriod(householdId, monthStart, monthEnd),
  );
  // A payment matching within this many cents of a dropped target's own
  // amount counts as the payment that retired it — tight on purpose (unlike
  // amountToleranceCents' 30%-of-amount band for routine bill drift): a
  // $140.80 target and a $101.00 payment are 30%-tolerance-compatible but
  // obviously not the same event, which is exactly the false match this
  // whole rework exists to stop making.
  const TARGET_MATCH_TOLERANCE_CENTS = 200;

  const payoffShownForDebtId = new Set<string>();
  for (const d of allDebts) {
    const p = paymentByDebtId.get(d.id);
    if (p) {
      const paidInCycle = p.payments
        .filter((payment) => payment.occurredOn >= monthStart && payment.occurredOn < monthEnd)
        .sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
      // The payment that actually zeroed the balance gets the same star an
      // "expected" projected payoff line gets — see pickPayoffPaymentTime
      // (debt-payoff.ts) for why this can't just be "the latest payment
      // this cycle."
      const payoffPaymentTime = pickPayoffPaymentTime(paidInCycle, d.balanceCents, d.paidOffDate);
      // "due" keyed off the same slot-based status and corrected date as
      // /debts' CycleMinimum (see minimumSatisfiedThisCycleIds above and
      // correctedDueDateByDebtId) — not raw nextDueDate / amountDueCents.
      const corrected = dueDateByDebtId.get(d.id);
      for (const payment of paidInCycle) {
        const isPayoff = payment.occurredOn.getTime() === payoffPaymentTime;
        if (isPayoff) payoffShownForDebtId.add(d.id);
        // A real payment that went past this cycle's minimum slot(s) —
        // extraPaidTimes already computes that for every debt regardless of
        // plan status, but "beyond the minimum" alone isn't "plan money": a
        // currently in-plan debt's extra is trusted outright (it's still
        // being actively targeted), while an out-of-plan debt only earns the
        // badge when its own amount matches one of the debt's still-open
        // historical targets above (consumed once matched, so a later
        // payment can't also claim the same target).
        const beyondSlots = !!corrected?.extraPaidTimes.has(payment.occurredOn.getTime());
        let isExtraPaid = false;
        if (beyondSlots) {
          if (d.includeInPayoffPlan) {
            isExtraPaid = true;
          } else {
            const targets = supersededTargetsByDebtId.get(d.id);
            const paidAbs = Math.abs(payment.amountCents);
            const matchIdx = targets?.findIndex((t) => Math.abs(t - paidAbs) <= TARGET_MATCH_TOLERANCE_CENTS) ?? -1;
            if (matchIdx !== -1) {
              isExtraPaid = true;
              targets!.splice(matchIdx, 1);
            }
          }
        }
        // Math.abs: the linked leg can be the lender-feed credit (negative) —
        // see filterDebtPaymentTwins.
        add(
          payment.occurredOn,
          debtDisplayName(d),
          Math.abs(payment.amountCents),
          "paid",
          d.includeInPayoffPlan,
          isPayoff,
          undefined,
          undefined,
          isExtraPaid,
        );
      }
      // The minimum still owed on this occurrence: the rolling amount due
      // when it's in arrears, never less than the regular minimum — that
      // counter reads $0 whenever any payment this cycle (even a payoff-plan
      // extra, or a loan paid outside the synced accounts) was credited
      // against it, which hid real upcoming minimums from the grid entirely
      // (real report, 2026-10-03: Voyager Loan due Oct 3, Amazon Card's $35
      // due Oct 10). Same "minimum is always shown" rule as DebtRow's
      // minDisplayCents and This Week's Bills' owedThisWeekCents. A $0-minimum
      // debt (ignoreMinimumPayment / paid in full each cycle) still gets no
      // "$0.00 due" cell (household report, 2026-08-31).
      const minimumOwedCents = Math.max(p.amountDueCents, p.amountCents);
      if (d.balanceCents > 0 && corrected && !corrected.cyclePaid && minimumOwedCents > 0) {
        add(corrected.date, debtDisplayName(d), minimumOwedCents, "due", d.includeInPayoffPlan);
      }
      // A minimum an earlier, bigger payment already covered (a $177 payment
      // against an $84 minimum due the 27th) is still on the calendar until
      // skipped — same rule as /debts' ledger (household request, 2026-09-20).
      if (d.balanceCents > 0 && corrected) {
        for (const date of corrected.coveredSlotDates) {
          add(date, debtDisplayName(d), p.amountCents, "due", d.includeInPayoffPlan);
        }
      }
    }
    if (!minimumOnly && thisCycle && d.balanceCents > 0) {
      const entry = thisCycle.debts.find((e) => e.debtId === d.id);
      // A skipped line is a household "not doing this one" decision — the
      // calendar grid is read-only (the skip/undo control lives on the
      // /debts list view instead), so it just omits the line entirely,
      // same as a fully-posted one that projectCyclePlan already dropped.
      for (const line of entry?.lines.filter((l) => l.kind === "extra" && !l.skipped) ?? []) {
        add(line.date, debtDisplayName(d), line.amountCents, "expected", d.includeInPayoffPlan, line.isPayoff, line.poolBreakdown);
      }
    }
  }

  // Fallback for a debt paid off purely by a synced balance dropping to $0
  // (see checkAndSyncLinkedBalances in simplefin-sync.ts) — there's no
  // matching DebtPayment.payments transaction to hang the star on, only
  // Debt.paidOffDate itself, so this adds a payoff-only line whenever the
  // payments loop above didn't already cover that debt.
  //
  // Dated off the plan's own PayoffExtraSnapshot when one exists (isPayoff
  // this month), not paidOffDate — paidOffDate is just whenever the balance
  // sync happened to notice $0, which routinely lands well after the
  // household actually expected the payoff (real report, 2026-09-07: Sam's
  // Club Card's plan expected Sep 3 — same date "Last Week's Bills" already
  // shows — but the balance sync didn't confirm it until Sep 7, so the
  // fallback here read Sep 7 instead of matching the plan). Falls back to
  // paidOffDate only when no such snapshot exists (a debt outside the
  // payoff plan, or one that closed before snapshotting existed).
  const payoffSnapshotByDebtId = new Map(
    (
      await db.payoffExtraSnapshot.findMany({
        where: { householdId, isPayoff: true, dueDate: { gte: monthStart, lt: monthEnd } },
        select: { debtId: true, dueDate: true, amountCents: true },
        // A debt paid off then restored within the same month can leave more
        // than one isPayoff row behind (the stale pre-restoration projection
        // plus the plan's current one). Ordered ascending so this Map's last
        // -write-wins keying always keeps the latest projection, not
        // whichever row the DB happened to return last.
        orderBy: { weekStart: "asc" },
      })
    ).map((s) => [s.debtId, s]),
  );
  for (const d of allDebts) {
    if (payoffShownForDebtId.has(d.id)) continue;
    // Still balance-positive: the "expected" loop above (d.balanceCents > 0)
    // already added this debt's live projected line for this cycle — this
    // fallback is only for a debt actually paid off ($0) with no real linked
    // transaction to hang the star on (see this block's own comment above).
    // Missing this let a still-owing, still-in-plan debt (paid off earlier
    // this same cycle, then restored by a new purchase) show up twice on the
    // same calendar day — the live line and this stale-looking duplicate of
    // it (real report, 2026-09-14: Sam's Club Card). payoff-planner.tsx's
    // own client-side twin (thisCycleDayEvents) already has this guard.
    if (d.balanceCents > 0) continue;
    // Only trust this month's live snapshot while the debt is still actually
    // in the plan — once excluded, its last snapshot row just stops getting
    // refreshed (snapshotPlannedExtraForCurrentWeek's own comment) and can be
    // a stale projection for a payoff that never happens the way it describes
    // (real report, 2026-09-16: Sam's Club Card excluded from the plan after
    // its Sep 13 snapshot projected a Sep 17 payoff — the real payoff instead
    // came from an unrelated purchase-driven restore and posted Sep 16, but
    // this fallback kept showing the stale Sep 17 projection since the real
    // payment hadn't synced/matched to a tracker yet). An excluded debt's
    // real outcome is the paidOffDate fallback below instead.
    const snapshot = d.includeInPayoffPlan ? payoffSnapshotByDebtId.get(d.id) : undefined;
    if (snapshot) {
      // pendingConfirmation: true — neither branch here has an actual
      // transaction behind it, only the plan's own projection or the raw
      // balance-crossing date, so neither earns the plain "Paid" checkmark
      // (see CalendarDayEvent's own comment).
      //
      // isExtraPayment: true — a PayoffExtraSnapshot(isPayoff) line is by
      // definition a payoff-plan extra payment, so it carries the badge on
      // its planned date even while still pending / confirmed only by a
      // balance drop. Once a real linked transaction posts, the paid loop
      // above sets payoffShownForDebtId and this branch is skipped, so the
      // badge moves to the actual posting date (household request,
      // 2026-09-08).
      add(snapshot.dueDate, debtDisplayName(d), snapshot.amountCents, "paid", d.includeInPayoffPlan, true, undefined, true, true);
      continue;
    }
    if (!d.paidOffDate || d.paidOffDate < monthStart || d.paidOffDate >= monthEnd) continue;
    // paidOffAmountCents — the balance right before this same transition
    // (nextPaidOffAmountCents, debt-payoff.ts) — gives this line a real
    // dollar figure even though there's no linked transaction to read one
    // from yet (real report, 2026-09-17: Sam's Club Card showed a bare star
    // with no amount here and on This Week's Bills).
    add(
      d.paidOffDate,
      debtDisplayName(d),
      d.paidOffAmountCents ?? undefined,
      "paid",
      d.includeInPayoffPlan,
      true,
      undefined,
      true,
      d.includeInPayoffPlan,
    );
  }

  // --- Recurring bills + subscriptions this month ---
  const bills = await db.recurringBill.findMany({
    where: { householdId, ...currentPeriodBillWhere() },
    select: {
      id: true,
      name: true,
      amountCents: true,
      cadence: true,
      nextDueDate: true,
      lastPaidDate: true,
      payments: { select: { amountCents: true, occurredOn: true } },
    },
  });
  // The one shared "is this bill's most recent skip still active" primitive
  // — see its own comment (recurring-bills.ts). Reused here instead of a
  // second hand-rolled cycleSkips-include pairing (2026-09-14 code review).
  const activeBillSkips = await getActiveBillCycleSkips(householdId, bills);
  for (const bill of bills) {
    // buildCycleSlots derives this month's expected occurrence date(s)
    // purely from cadence math off nextDueDate — a skip advances
    // nextDueDate past the skipped cycle the same way a real payment does,
    // so the skipped cycle's own date still comes back as a slot here
    // (walking backward one cadence period), just with no payment attached
    // to it. Without checking for that, a skipped bill read as a plain
    // still-"due" obligation on the calendar forever (real report,
    // 2026-09-14: Summit Gas, skipped, kept showing as a normal due bill).
    const activeSkipDate = activeBillSkips.get(bill.id) ?? null;
    // Same slot primitive the bill ledger uses — pairs each expected
    // occurrence this month against a real linked payment, in date order.
    const { slots } = buildCycleSlots(
      bill.nextDueDate,
      bill.cadence,
      monthStart,
      monthEnd,
      bill.payments.map((p) => ({ occurredOn: p.occurredOn, amountCents: Math.abs(p.amountCents) })),
    );
    for (const slot of slots) {
      if (slot.payment) {
        addBill(slot.payment.occurredOn, bill.name, slot.payment.amountCents, "paid");
      } else if (bill.lastPaidDate && slot.date <= bill.lastPaidDate) {
        // Marked paid by hand (a no-merchant manual bill) — no transaction to
        // point at, but the household confirmed it.
        addBill(slot.date, bill.name, bill.amountCents, "paid");
      } else if (activeSkipDate && slot.date.getTime() === activeSkipDate.getTime()) {
        addBill(slot.date, bill.name, bill.amountCents, "skipped");
      } else {
        addBill(slot.date, bill.name, bill.amountCents, "due");
      }
    }
  }

  // --- Scheduled outgoing P2P patterns this month ---
  // Same filter as getPatternsThisWeek (recurring-bills.ts): DEBIT, scheduled,
  // not pinned to a bill or debt (those already render above). Drawn as a
  // "bill" event — same name/amount/status shape. Slots use the same
  // tracker-createdAt bound PatternRow's own cyclePaid does
  // (serializePatternDates), so the two can't disagree on paid vs due.
  const patterns = await db.recurringPattern.findMany({
    where: {
      householdId,
      direction: "DEBIT",
      countsAsIncome: false,
      billId: null,
      debtId: null,
      cadence: { not: null },
      nextDueDate: { not: null },
      ...currentPeriodPatternWhere(),
    },
    select: {
      label: true,
      cadence: true,
      nextDueDate: true,
      createdAt: true,
      amountMinCents: true,
      amountMaxCents: true,
      transactions: { select: { amountCents: true, occurredOn: true } },
    },
  });
  for (const pattern of patterns) {
    const { slots } = buildCycleSlots(
      pattern.nextDueDate!,
      pattern.cadence!,
      monthStart,
      monthEnd,
      pattern.transactions.map((t) => ({ occurredOn: t.occurredOn, amountCents: Math.abs(t.amountCents) })),
      slotBounds(monthStart, { trackerCreatedAt: pattern.createdAt }),
    );
    const expectedCents = Math.round((pattern.amountMinCents + pattern.amountMaxCents) / 2);
    for (const slot of slots) {
      if (slot.payment) addBill(slot.payment.occurredOn, pattern.label, slot.payment.amountCents, "paid");
      else addBill(slot.date, pattern.label, expectedCents, "due");
    }
  }

  // No payment activity anywhere this cycle (a debt-free household with no
  // tracked bills) — skip the card rather than render an empty grid.
  if (eventsByDay.size === 0) return null;

  return { monthDate: monthStart, eventsByDay };
}

// The full /api/calendar/[token] ICS feed — the multi-month, forward-looking
// version of the dashboard's Payment Calendar (getPaymentCalendarThisCycle):
// every recurring bill / subscription occurrence + every still-owed debt's
// minimum + the payoff plan's projected extra payments, 3 months out,
// flattened to a plain event list (a subscribed calendar has no "viewed
// month" to scope to). Deliberately excludes real "paid" history — a feed a
// household glances at from their phone's calendar app is for what's coming
// up, not a ledger of what already happened.
//
// The payoff plan's extra payments are added only when the plan is genuinely
// active — toggle on, a real income schedule, at least one in-plan debt —
// exactly like the dashboard grid. Plan off ≠ empty feed; it just means no
// extra lines. A household with only bills and no debts still gets a feed.
export async function getPaymentCalendarIcsEvents(householdId: string): Promise<IcsEvent[]> {
  const household = await db.household.findUniqueOrThrow({
    where: { id: householdId },
    select: {
      payoffPlanEnabled: true,
      payoffOrder: true,
      payoffExtraCents: true,
      payoffRollFreedMinimums: true,
      payoffRollFreedMinimumsSplit: true,
    },
  });

  const income = await getPrimaryIncomeSchedule(householdId);

  const allDebts = await db.debt.findMany({
    where: { householdId },
    orderBy: { sortOrder: "asc" },
    include: { account: { select: { displayName: true } } },
  });
  const owedDebts = allDebts.filter((d) => d.balanceCents > 0);
  // In-plan debts (still owed + opted in) — the only ones the extra-payment
  // pool ever cascades onto (extraEligibleIds below).
  const inPlanIds = new Set(owedDebts.filter((d) => d.includeInPayoffPlan).map((d) => d.id));
  // Extra-payment lines only when the plan is genuinely running — same three
  // conditions getPaymentCalendarThisCycle's `planActive` checks.
  const planActive = household.payoffPlanEnabled && !!income && inPlanIds.size > 0;
  const nameById = new Map(allDebts.map((d) => [d.id, debtDisplayName(d)]));

  const debtPayments = await db.debtPayment.findMany({
    where: { householdId, debtId: { in: allDebts.map((d) => d.id) }, active: true },
    select: {
      debtId: true,
      cadence: true,
      nextDueDate: true,
      lastPaidDate: true,
      createdAt: true,
      amountCents: true,
      // The tracked minimum owed on the current occurrence — used below to
      // decide whether a still-unpaid debt gets an explicit "upcoming
      // minimum" event in the feed (mirrors getPaymentCalendarThisCycle's
      // own `amountDueCents > 0` guard on its "due" cells).
      amountDueCents: true,
      payments: { select: { amountCents: true, occurredOn: true } },
    },
  });
  const { start: monthStart, end: monthEnd } = utcPeriodBounds(currentPeriodKey());
  const debtMetaById = new Map(
    allDebts.map((d) => [
      d.id,
      {
        debtType: d.debtType,
        purchaseDate: d.purchaseDate,
        installmentsRemaining: d.installmentsRemaining,
        balanceCents: d.balanceCents,
        paidOffDate: d.paidOffDate,
      },
    ]),
  );
  const dueDateByDebtId = correctedDueDateByDebtId(
    debtPayments,
    monthStart,
    monthEnd,
    debtMetaById,
    await getSkippedMinimumKeys(householdId, monthStart, monthEnd),
    await planExtraTargetsByDebt(householdId, monthStart, monthEnd),
  );

  // Only the debts whose current cycle is genuinely paid per the real ledger
  // — the exact same slot-based `cyclePaid` primitive getPaymentCalendarThisCycle
  // (the in-app dashboard calendar) and PayoffPlanner both key off. This feed
  // used to pass *every* debt id here instead, which fed projectCyclePlan a
  // simulation where every genuinely-unpaid debt's current-cycle minimum +
  // interest was dropped (its due date rolled a cycle forward) — so the
  // extra-payment waterfall was seeded wrong and per-debt payoff dates in the
  // feed drifted a cycle off what the in-app calendar showed, leaving
  // interest-tick residuals ("$0.45 — Pays It Off!" a month late). The
  // still-unpaid current occurrence is instead surfaced explicitly below, the
  // way getPaymentCalendarThisCycle surfaces it as a "due" cell.
  const minimumSatisfiedThisCycleIds = new Set<string>();
  for (const p of debtPayments) {
    if (dueDateByDebtId.get(p.debtId)?.cyclePaid) minimumSatisfiedThisCycleIds.add(p.debtId);
  }
  const amountDueByDebtId = new Map(debtPayments.map((p) => [p.debtId, p.amountDueCents]));
  const minimumByDebtId = new Map(debtPayments.map((p) => [p.debtId, p.amountCents]));

  // Every still-owed debt, in-plan or not — same reasoning as
  // getPaymentCalendarThisCycle: an excluded debt still keeps its own
  // real payment schedule on the calendar, it just never receives cascaded
  // extra. paymentCadence comes from the same tracker as dueDateByDebtId
  // above — see getAlreadyFreedMinimums for why it matters.
  const debtInputs: DebtInput[] = owedDebts.map((d) => ({
    id: d.id,
    name: debtDisplayName(d),
    balanceCents: d.balanceCents,
    aprBasisPoints: d.aprBasisPoints,
    minPaymentCents: d.minPaymentCents,
    debtType: d.debtType,
    paymentCadence: dueDateByDebtId.get(d.id)?.cadence,
  }));

  const alreadyFreedMinimums = planActive
    ? await getAlreadyFreedMinimums(householdId, household.payoffRollFreedMinimums)
    : [];
  const extraPaidThisCycleByDebtId = new Map(
    [...dueDateByDebtId.entries()].map(([id, v]) => [id, v.extraPaidCents]),
  );
  const skippedExtraPairs = planActive ? await getPayoffExtraSkips(householdId) : new Set<string>();

  // Same 3-month horizon payoff-planner.tsx projects client-side (see
  // projectionDebtInputs there) — keeps the calendar feed agreeing with
  // what the in-app Payoff Calendar shows instead of exposing a longer,
  // never-shown-elsewhere projection window.
  const cyclePlan = projectCyclePlan(debtInputs, {
    order: household.payoffOrder as PayoffOrder,
    rollFreedMinimums: planActive && household.payoffRollFreedMinimums,
    rollFreedMinimumsSplit: household.payoffRollFreedMinimumsSplit,
    extraPerPaycheckCents: planActive ? household.payoffExtraCents : 0,
    // projectCyclePlan places paycheck events off this schedule to size the
    // extra pool; with the plan inactive there's no pool to place, so a
    // synthetic biweekly anchor just lets the minimum-only cadence walk run
    // when the household has no income tracked yet.
    income: income ?? { nextPayDate: monthStart, cadence: "BIWEEKLY" },
    monthsCount: 3,
    // The real slot-based set (see its comment above), same as every other
    // projectCyclePlan caller — NOT a blanket "every debt satisfied", which
    // used to quietly drop this cycle's minimum + interest for every unpaid
    // debt and drift the feed a cycle off the in-app calendar. The current
    // still-unpaid occurrence is surfaced explicitly after this call.
    minimumSatisfiedThisCycleIds,
    dueDateByDebtId,
    alreadyFreedMinimums,
    extraEligibleIds: inPlanIds,
    extraPaidThisCycleByDebtId,
    skippedExtraPairs,
  });

  const minimumOnly =
    !planActive || (household.payoffExtraCents === 0 && !household.payoffRollFreedMinimums);
  const events: IcsEvent[] = [];
  const emittedUids = new Set<string>();
  for (const month of cyclePlan) {
    for (const entry of month.debts) {
      const debtName = nameById.get(entry.debtId) ?? "Debt";
      for (const line of entry.lines) {
        if (line.kind === "extra" && minimumOnly) continue;
        // A pending line is a real, assumed-through allocation now (see
        // projectCyclePlan's past-payday branch) — publish it same as any
        // other extra. A skipped one is a household "not doing this one"
        // decision; a subscribed calendar shouldn't nag about it.
        if (line.kind === "extra" && line.skipped) continue;
        // Never emit a $0 event — projectCyclePlan already drops $0 minimum
        // lines, this is the belt-and-suspenders guard for the one surface a
        // subscribed calendar app renders verbatim (household report,
        // 2026-08-31: a "$0.00 min payment — Sam's Club" event).
        if (line.amountCents <= 0) continue;
        const day = ymd(line.date);
        const amount = formatCents(line.amountCents);
        const payoffSuffix = line.isPayoff ? " — Pays It Off!" : "";
        const summary =
          line.kind === "minimum"
            ? `${amount} min payment — ${debtName}${payoffSuffix}`
            : `${amount} extra — ${debtName}${payoffSuffix}`;
        const description =
          line.kind === "extra" && line.poolBreakdown && line.poolBreakdown.parts.some((p) => p.kind === "rolled")
            ? line.poolBreakdown.parts
                .filter((p) => p.amountCents > 0)
                .map((p) => `${formatCents(p.amountCents)} ${p.kind === "base" ? "extra" : `rolled from ${p.name}`}`)
                .join(", ")
            : undefined;
        const uid = `${entry.debtId}-${line.kind}-${day}`;
        emittedUids.add(uid);
        events.push({ uid, date: line.date, summary, description });
      }
    }
  }

  // Explicitly surface each still-owed debt's current, not-yet-paid minimum —
  // the one occurrence projectCyclePlan simulates but renders invisibly (the
  // in-app calendar shows it as its own "due" cell instead, see
  // getPaymentCalendarThisCycle; a subscribed feed has no such companion
  // view). Emitted at the same corrected date and with the same
  // `!cyclePaid && amountDueCents > 0` guard getPaymentCalendarThisCycle uses
  // for its "due" cells, so the feed and the in-app calendar list the same
  // set. `dueDateByDebtId` already scopes this to the current period's own
  // first-unpaid slot, so the date is never far in the past even when the
  // tracker's nextDueDate has drifted; a genuinely-overdue-and-unpaid minimum
  // still belongs on the calendar. Skipped when projectCyclePlan already
  // emitted that debt+date.
  for (const d of owedDebts) {
    const corrected = dueDateByDebtId.get(d.id);
    // Never less than the regular minimum — see getPaymentCalendarThisCycle's
    // identical minimumOwedCents (2026-10-03).
    const amountDueCents = Math.max(amountDueByDebtId.get(d.id) ?? 0, minimumByDebtId.get(d.id) ?? 0);
    if (!corrected || corrected.cyclePaid || amountDueCents <= 0) continue;
    const day = ymd(corrected.date);
    if (emittedUids.has(`${d.id}-minimum-${day}`)) continue;
    const debtName = nameById.get(d.id) ?? "Debt";
    events.push({
      uid: `${d.id}-minimum-${day}`,
      date: corrected.date,
      summary: `${formatCents(amountDueCents)} min payment — ${debtName}`,
    });
  }

  // A minimum an earlier, bigger payment already covered stays on the feed
  // until skipped — same rule as the in-app calendars (2026-09-20). Uses the
  // tracker's regular minimum, not amountDueCents (which is 0 once covered).
  for (const d of owedDebts) {
    const corrected = dueDateByDebtId.get(d.id);
    const regularMinimum = debtPayments.find((p) => p.debtId === d.id)?.amountCents ?? 0;
    if (!corrected || regularMinimum <= 0) continue;
    const debtName = nameById.get(d.id) ?? "Debt";
    for (const date of corrected.coveredSlotDates) {
      const uid = `${d.id}-minimum-${ymd(date)}`;
      if (emittedUids.has(uid)) continue;
      emittedUids.add(uid);
      events.push({ uid, date, summary: `${formatCents(regularMinimum)} min payment — ${debtName}` });
    }
  }

  // --- Recurring bills + subscriptions, same 3-month horizon ---
  const billHorizonEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 3, 1));
  const bills = await db.recurringBill.findMany({
    where: { householdId, ...currentPeriodBillWhere() },
    select: {
      id: true,
      name: true,
      amountCents: true,
      cadence: true,
      nextDueDate: true,
    },
  });
  // Same shared active-skip lookup as getPaymentCalendarThisCycle just
  // above (2026-09-14 code review — this used to hand-roll its own copy).
  const activeBillSkipsForIcs = await getActiveBillCycleSkips(householdId, bills);
  for (const bill of bills) {
    if (bill.amountCents <= 0) continue;
    const activeSkipDate = activeBillSkipsForIcs.get(bill.id) ?? null;
    for (const date of occurrencesInPeriod(bill.nextDueDate, bill.cadence, monthStart, billHorizonEnd)) {
      // occurrencesInPeriod walks backward from nextDueDate too, so a
      // skipped cycle's own now-past date still comes back here even though
      // nextDueDate has already advanced past it — a subscribed calendar
      // would otherwise keep reminding the household of a bill they already
      // marked as skipped (household request, 2026-09-14, same underlying
      // gap as the in-app calendar just above).
      if (activeSkipDate && date.getTime() === activeSkipDate.getTime()) continue;
      events.push({
        uid: `bill-${bill.id}-${ymd(date)}`,
        date,
        summary: `${formatCents(bill.amountCents)} — ${bill.name}`,
      });
    }
  }

  // --- Scheduled outgoing P2P patterns, same 3-month horizon ---
  // Same filter as getPaymentCalendarThisCycle's pattern section (and
  // getPatternsThisWeek): DEBIT, scheduled, not pinned to a bill or debt.
  // Amount is the range midpoint, same as PatternRow. Patterns have no skip.
  const patterns = await db.recurringPattern.findMany({
    where: {
      householdId,
      direction: "DEBIT",
      countsAsIncome: false,
      billId: null,
      debtId: null,
      cadence: { not: null },
      nextDueDate: { not: null },
      ...currentPeriodPatternWhere(),
    },
    select: { id: true, label: true, cadence: true, nextDueDate: true, amountMinCents: true, amountMaxCents: true },
  });
  for (const pattern of patterns) {
    const amountCents = Math.round((pattern.amountMinCents + pattern.amountMaxCents) / 2);
    if (amountCents <= 0) continue;
    for (const date of occurrencesInPeriod(pattern.nextDueDate!, pattern.cadence!, monthStart, billHorizonEnd)) {
      events.push({
        uid: `pattern-${pattern.id}-${ymd(date)}`,
        date,
        summary: `${formatCents(amountCents)} — ${pattern.label}`,
      });
    }
  }

  return events;
}

function ymd(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

export type PaidOffDebt = { id: string; name: string; paidOffDate: Date };

// Dashboard "paid off this week" card — the debt-list mirror of
// getBillsThisWeek's lastPaidDate check, same currentWeekBounds convention.
// Lives here (not debt-payoff.ts) because that module is pure/client-safe
// for the live payoff-plan preview and can't import `db`.
export async function getDebtsPaidOffThisWeek(householdId: string): Promise<PaidOffDebt[]> {
  const { start, end } = currentWeekBounds();
  const debts = await db.debt.findMany({
    where: { householdId, paidOffDate: { gte: start, lt: end } },
    orderBy: { paidOffDate: "asc" },
    select: { id: true, name: true, paidOffDate: true, account: { select: { displayName: true } } },
  });
  return debts.map((d) => ({ id: d.id, name: debtDisplayName(d), paidOffDate: d.paidOffDate! }));
}

// Dashboard's "Paid off this week" card — dismissed per debt id (same
// STALE_ASSET-style convention as dismissStaleAsset in networth.ts), not
// per week, so a debt paying off *after* the card was dismissed makes it
// reappear with the new debt included instead of staying hidden for the
// rest of the week. The dismissal rows go stale on their own once the week
// rolls over — getDebtsPaidOffThisWeek only ever looks at this week's
// paidOffDate, so a debt paid off in a prior week can never match here
// again.
export async function isPaidOffThisWeekDismissed(householdId: string, debtIds: string[]): Promise<boolean> {
  if (debtIds.length === 0) return false;
  const dismissed = await db.suggestionDismissal.count({
    where: { householdId, kind: "PAID_OFF_THIS_WEEK", key: { in: debtIds } },
  });
  return dismissed >= debtIds.length;
}

export async function dismissPaidOffThisWeek(householdId: string, debtIds: string[]): Promise<void> {
  await db.suggestionDismissal.createMany({
    data: debtIds.map((debtId) => ({ householdId, kind: "PAID_OFF_THIS_WEEK", key: debtId })),
    skipDuplicates: true,
  });
}
