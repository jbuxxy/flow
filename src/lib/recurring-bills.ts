import { createHash } from "crypto";
import { db } from "@/lib/db";
import { isDemoHousehold } from "@/lib/demo";
import { summarizeUpcomingBills } from "@/lib/ai";
import { currentPeriodKey, currentDateKey, currentWeekBounds, currentWeekKey, utcPeriodBounds } from "@/lib/period";
import { nameSimilarity } from "@/lib/fuzzy-match";
import { todayAsUTCDate } from "@/lib/date";
import { amountToleranceCents } from "@/lib/amount-tolerance";
import { stepCadence } from "@/lib/cadence-step";
import { MATCH_WINDOW_DAYS, catchupCycleWindow, fastForwardCycleDate } from "@/lib/bill-match-window";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import type { PoolBreakdown } from "@/lib/debt-payoff";
import type { BillCadence, Prisma } from "@prisma/client";

// Which RecurringBills count as "live this month." A cancelled bill
// (active:false — see deleteBill in src/app/bills/actions.ts) still
// represents real money out *only* if its last payment actually landed in
// the current calendar month — then every "this month" surface (the bucket
// + /bills recurring lists, the dashboard's This Week's Bills card, the
// Recurring Total projection, getBucketsWithProgress' pace math that feeds
// the monthly AI report) keeps showing it, and it drops out of all of them
// at rollover with no cleanup. Payment date, not due date: a subscription
// charged July 30 is a July expense even if its notional next-due is in
// August (household call, 2026-08-27 — "if it was actually paid in July it
// shouldn't be listed here").
// Deliberately NOT used by matchBillPayments (a cancelled bill must never
// re-match a payment), the due-date nags (hasBillsNeedingAttention /
// getActiveBillsNeedingDueDate), or bill-detect's re-suggestion exclusion
// (a cancelled subscription stays suppressed — re-track it by hand if it
// comes back). lastPaidDate is a UTC-midnight @db.Date, so the bound is a
// UTC month start (utcPeriodBounds), not the local-time periodBounds.
export function currentPeriodBillWhere(): Prisma.RecurringBillWhereInput {
  const { start } = utcPeriodBounds(currentPeriodKey());
  return { OR: [{ active: true }, { active: false, lastPaidDate: { gte: start } }] };
}

const DAY_MS = 86_400_000;

// UTC setters, not local — every date this touches (nextDueDate, etc.) is a
// `@db.Date` value, UTC midnight for a specific calendar day (src/lib/
// date.ts). A local setter reads/writes the wrong calendar day whenever the
// server's TZ (America/Denver) puts that UTC-midnight instant on the
// *previous* local day — usually invisible, but it silently misclassifies
// which month a date falls in right at a month boundary (real report,
// 2026-08-21: a payoff-plan line landing on the actual 1st of the month
// bucketed into the *previous* month's cycle because this used local
// getters while the UI displaying that same date used UTC ones).
// Month/year steps clamp to the target month's last day (cadence-step.ts).
export function addCadence(date: Date, cadence: BillCadence, anchorDay?: number): Date {
  return stepCadence(date, cadence, 1, anchorDay);
}

// The reverse of addCadence — used to bound "this cycle" lookback windows
// (see backfillDebtPaymentHistory in debt-payments.ts) one cadence period
// before a given due date.
export function subtractCadence(date: Date, cadence: BillCadence, anchorDay?: number): Date {
  return stepCadence(date, cadence, -1, anchorDay);
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

// SimpleFIN never tells us a bill's actual due date, only when money has
// already moved — so a household's own payment history is the only real
// signal available for which day of the month a MONTHLY bill is due. Used
// both for a fresh suggestion's first guess (bill-detect.ts) and every
// ongoing roll-forward (matchBillPayments below), so the estimate keeps
// tightening as more real payments accumulate instead of perpetuating
// whatever day the very first heuristic guess happened to land on forever.
// Median rather than most-recent or average: robust to a single early/late
// payment (a weekend push, a holiday) without permanently dragging the
// schedule off the household's real billing day. WEEKLY/BIWEEKLY need no
// such correction — their day-of-week is invariant under addCadence
// regardless of anchor — and ANNUAL rarely accumulates enough history for a
// median to mean anything, so both just fall back to the plain cadence roll.
// Pure UTC arithmetic throughout (matching how these @db.Date values are
// actually displayed — see toISOString().slice(0,10) on /bills — rather
// than addCadence's local-time methods, which would reintroduce exactly the
// kind of off-by-one this function exists to fix).
export function nextBillDueDate(cadence: BillCadence, previousDueDate: Date, history: Date[]): Date {
  if (cadence !== "MONTHLY" || history.length === 0) return addCadence(previousDueDate, cadence);

  const days = history.map((d) => d.getUTCDate()).sort((a, b) => a - b);
  const medianDay = days[Math.floor(days.length / 2)];

  const year = previousDueDate.getUTCFullYear();
  const month = previousDueDate.getUTCMonth() + 1;
  return new Date(Date.UTC(year, month, Math.min(medianDay, daysInMonth(year, month))));
}

// Whether a skip recorded for `skippedCycleDueDate` is still the one
// describing a bill's *current* cycle transition, vs. one from a stale,
// already-rolled-past cycle that shouldn't linger forever. skipBillCycle
// both records the skip AND advances nextDueDate in the same breath (a
// bill's own due date has to actually move, unlike a payoff extra's fixed
// cadence — see BillCycleSkip's schema comment), so there's no separate
// "current cycle" pointer to check the skip against; a skip is still active
// exactly while it's the one that maps forward — via the bill's own
// cadence, empty history, matching every skipBillCycle call — to the
// bill's own current nextDueDate. Once a real payment or a second skip
// moves nextDueDate again, this stops matching and the row quietly reverts
// to its ordinary due/paid treatment, same self-clearing "no separate
// rollover cleanup" shape as PayoffExtraSkip. Pulled out from
// getActiveBillCycleSkips below as its own pure function so this actual
// decision has a regression test independent of the DB round trip around it.
export function isBillCycleSkipActive(cadence: BillCadence, skippedCycleDueDate: Date, currentNextDueDate: Date): boolean {
  return nextBillDueDate(cadence, skippedCycleDueDate, []).getTime() === currentNextDueDate.getTime();
}

// A bill row (/bills, a bucket's recurring list) covers the current month,
// so its "Skipped {date}, Undo" line — which stands in for the due line —
// only applies while the skipped cycle is this month's (or a later one,
// skipped early). An active skip from last month would otherwise hide this
// month's expected payment until it's paid (real report, 2026-10-07:
// Lakeside Gas, skipped Sep 9, kept showing "Skipped Sep 09" all October with
// its Oct 9 bill nowhere on the row). Deliberately not folded into
// isBillCycleSkipActive: the week cards and the payment calendar still need
// a last-month skip to mark its own past date as skipped, not due.
export function skipShownOnBillRow(activeSkip: Date | undefined, monthStart: Date): Date | null {
  return activeSkip && activeSkip.getTime() >= monthStart.getTime() ? activeSkip : null;
}

// Which bills currently have a skip (BillCycleSkip) still worth showing as
// "Skipped {date}, Undo" on their row — see isBillCycleSkipActive above for
// the actual decision. Only the most recent skip per bill is ever relevant,
// so this only fetches and checks that one.
export async function getActiveBillCycleSkips(
  householdId: string,
  bills: { id: string; cadence: BillCadence; nextDueDate: Date }[],
): Promise<Map<string, Date>> {
  if (bills.length === 0) return new Map();

  const skips = await db.billCycleSkip.findMany({
    where: { householdId, billId: { in: bills.map((b) => b.id) } },
    orderBy: { skippedAt: "desc" },
  });
  const latestByBill = new Map<string, Date>();
  for (const s of skips) {
    if (!latestByBill.has(s.billId)) latestByBill.set(s.billId, s.cycleDueDate);
  }

  const active = new Map<string, Date>();
  for (const bill of bills) {
    const cycleDueDate = latestByBill.get(bill.id);
    if (cycleDueDate && isBillCycleSkipActive(bill.cadence, cycleDueDate, bill.nextDueDate)) {
      active.set(bill.id, cycleDueDate);
    }
  }
  return active;
}

// Real bank statement descriptors drift cycle to cycle — an extra suffix, a
// reference number, "Autopay" vs "Epay" — so requiring the merchant text to
// match byte-for-byte missed genuine payments. nameSimilarity's word-overlap
// scoring alone isn't safe here on its own, though: two *different* municipal
// utility charges from the same city ("Fairview Water Improvement District" vs
// "Fairview City Debits Web") share just enough vocabulary to score the same
// as real drift would. 0.75 sits just below nameSimilarity's "one string
// contains the other" tier (0.8) — the safe signal for genuine drift — while
// staying well above what a multi-word coincidental overlap can reach (two
// 4-word phrases sharing one word score 0.25). Combined with an amount
// check so a same-named-ish but unrelated charge can't slip through either.
const NAME_SIMILARITY_THRESHOLD = 0.75;

// Allows real variance (a utility bill runs higher some months) without
// treating an unrelated same-ish-amount charge as a match — whichever
// tolerance is wider: 30% of the bill's tracked amount, or a flat $5 floor
// so small flat bills (a $9.64 Netflix charge) still get a little slack.
// Exported for bill-detect.ts, which uses the same tolerance to cluster a
// merchant's transactions by amount before checking for a recurring cadence.
// Lives in amount-tolerance.ts (no imports) so client components can share it
// without dragging this module's `db` import into the browser bundle; re-
// exported here so every existing import keeps working.
export { amountToleranceCents };

// A learned BillExtraChargeRule's own tolerance — deliberately much tighter
// than amountToleranceCents. That function's $5 floor exists for a bill's
// own (typically $20+) main amount; applied to a small flat ancillary fee
// (a $2 service charge) it would swallow almost anything from $0-$7 as "the
// same fee," which is exactly what a household flagged as a real concern
// (2026-09-14: "make sure the total still lines up with expected amount" —
// a same-descriptor charge for an unrelated amount must never auto-attach).
// 10% or a $0.50 floor, whichever is wider — enough slack for a fee that
// drifts a few cents, not enough to admit a materially different charge.
export function extraChargeToleranceCents(amountCents: number): number {
  return Math.max(Math.round(amountCents * 0.1), 50);
}

// Name-similarity bar required to accept a match *outside* the normal
// amount-tolerance band — much stricter than NAME_SIMILARITY_THRESHOLD.
// Prompted by real bills whose price legitimately changes cycle to cycle
// by more than the tolerance band allows (a power bill, an insurance
// premium) — a real recurring merchant's bank descriptor is stable enough
// that requiring a near-exact name match safely compensates for a wider
// amount swing, without reopening the original failure case
// NAME_SIMILARITY_THRESHOLD alone guards against (two *different* same-city
// utility merchants sharing enough vocabulary to false-positive at only
// moderate similarity).
const STRICT_NAME_SIMILARITY_THRESHOLD = 0.9;

// Corroboration bar for RecurringBill.lastMatchDescriptor vs a candidate's
// Transaction.rawDescription — only consulted when the merchant match isn't
// exact (see the `merchantSimilarity >= 1` short-circuit below). Raw
// descriptions carry a per-transaction reference number/ID that never
// repeats cycle to cycle, so nameSimilarity's word-overlap tier (not its
// exact/substring tiers) is what actually does the work here — real
// same-bill descriptors share several tokens (brand, product line, billing
// suffix) against only 1-2 coincidental overlaps for an unrelated charge
// from the same brand. 0.4 is well above the ~0.25-0.3 two *different*
// Amazon.com retail purchases scored against a real "AMAZON PRIME*…AMZN.COM/
// BILL" descriptor, and well below the ~0.7 two genuine Prime charges scored
// against each other (see lastMatchDescriptor's schema comment for the real
// incident this guards against).
const RAW_DESCRIPTION_SIMILARITY_THRESHOLD = 0.4;

// A bill's own real payment history is a far more accurate tolerance guide
// than the blanket 30%/$5-floor guess (amountToleranceCents) once there's
// enough of it to trust — a subscription that's posted the exact same
// amount every month running gives no reason to accept a same-merchant
// charge over a dollar off as "probably this bill" (real incident,
// 2026-08-26: an "Apple" bill tracked at a steady $9.99/mo — 4 straight
// identical payments — matched an unrelated $8.57 Apple charge because the
// blanket tolerance's $5 floor comfortably covered the gap and the merchant
// text was an *exact* match, `RAW_DESCRIPTION_SIMILARITY_THRESHOLD`'s check
// never even applying — Apple routes essentially all of its billing through
// one shared "APPLE.COM/BILL…" descriptor regardless of charge type, so
// rawDescription carried no distinguishing signal here either, unlike the
// Amazon incident this file's other tolerance guard addresses). Requires
// >=3 real payments before trusting the spread — too little history is no
// safer a guide than the blanket guess; a genuinely variable bill (a
// usage-based utility) keeps this wide on its own, no separate handling
// needed, since its own past spread *is* the wide part.
function historicalToleranceCents(recentAmountsCents: number[]): number | null {
  if (recentAmountsCents.length < 3) return null;
  const spread = Math.max(...recentAmountsCents) - Math.min(...recentAmountsCents);
  // A little slack above the observed spread (tax rounding, a cent of
  // interchange drift) rather than an exact-match-only band.
  return Math.max(spread + 50, 100);
}

// Runs every sync (see simplefin-sync.ts), right after categorization.
// Looks for a transaction matching each active bill within a few
// days of its due date, and not already linked to a bill, using
// name-similarity + amount-tolerance. Real bank statement descriptors drift
// cycle to cycle (an extra suffix, a reference number, "Autopay" vs
// "Epay"), so requiring byte-for-byte text would miss genuine payments —
// and once a bill is established, name is the trustworthy signal, amount
// secondary: a candidate within the tolerance band needs only the normal
// name bar, but one outside it (a real price change) still matches given a
// near-exact name. On a hit: links the transaction, records lastPaidDate,
// rolls nextDueDate forward exactly one cadence period from the *due* date
// (never re-estimated from payment history — see nextBillDueDate's `[]`
// below) so a late payment doesn't shift the schedule, and refreshes
// amountCents to the newly observed value so next cycle's expected amount
// tracks the real trend instead of staying frozen at whatever was first
// accepted.
// categorizeUncategorizedTransactions runs first each sync, so the merchant
// rule set at track-time (see acceptBillSuggestion) normally buckets this
// match before we ever see it — bucketId is only backfilled here as a
// fallback for a bill whose bucket was assigned/changed with no matching
// merchant rule in place.
// Venmo/P2P transactions aren't handled here at all — they share one
// generic merchant string across every use of the app, so name-similarity
// says nothing useful about them; that needs its own signal
// (RecurringPattern's amount-range matching already does this for
// buckets/debts/income, but no equivalent exists yet for bills).
// Debt-linked payments (a card/loan's tracked recurring payment) are a
// separate concept/model entirely — see matchDebtPayments in
// src/lib/debt-payments.ts.
//
// A household that's been away for months means a bill can be several
// cadence periods overdue at once — this processes one cycle at a time
// (see the inner loop) rather than one widened pass, so `nextDueDate`
// catches all the way up to real time in a single sync run instead of
// permanently sticking after the first missed cycle. A real incident
// (2026-08-14): the original single-pass version widened its window to
// `now` once overdue (to still catch one late payment) and, combined with
// linking every qualifying transaction, bulk-linked several *separate*
// months' worth of already-legitimate payments to one cycle in one shot —
// nextDueDate only advanced once, so the bill stayed stuck "overdue"
// forever even though the dashboard (driven by lastPaidDate directly)
// correctly showed it as paid, and BillRow's payments list mislabeled
// months-old, already-resolved payments as "extra."
export const MAX_CATCHUP_CYCLES = 24;

// The actual DB write behind "attach this transaction to that bill as an
// extra charge" — shared by attachExtraBillCharge (bills/actions.ts, the
// household's own one-click confirm) and matchBillPayments' automatic
// re-application of an already-learned BillExtraChargeRule below, so the
// two paths can never silently drift apart on what "attached" means.
// Deliberately does not touch the bill's own lastPaidDate/nextDueDate/
// amountCents (those stay driven by the cycle's real official payment) —
// this transaction just joins the current cycle's payments list as an
// "extra" (bill-row.tsx), same as a genuine second same-cycle charge already does.
export async function attachTransactionAsExtraCharge(
  transactionId: string,
  bill: { id: string; bucketId: string | null; categoryId: string | null },
): Promise<void> {
  await db.transaction.update({
    where: { id: transactionId },
    data: {
      billId: bill.id,
      // Same "a bill's payment always follows the bill's own bucket +
      // category" rule matchBillPayments/updateBill enforce for every other
      // linked payment.
      bucketId: bill.bucketId,
      categoryId: bill.categoryId,
      aiSuggestedBucketId: null,
      aiSuggestedCategoryId: null,
    },
  });
}

// The manual counterpart to matchBillPayments' own automatic "official
// payment" write below — for a real payment the automatic matcher missed
// entirely, most often a bank-garbled merchant descriptor that scores too
// low against bill.merchant for nameSimilarity to ever accept (household
// report, 2026-09-22: a SimpleFIN transaction with a garbled bank merchant
// descriptor never matched the existing bill it was actually for — no edit-
// distance/fuzzy tolerance in nameSimilarity bridges noise that different).
// Unlike attachTransactionAsExtraCharge above, this DOES roll the bill's
// own lastPaidDate/nextDueDate/amountCents forward — the household is
// declaring this transaction the cycle's real payment, not an ancillary fee
// riding alongside one. Always reconciles the bill's *current* cycle
// (nextDueDate) — the one a household would actually be looking at when
// they notice a synced transaction stuck in "Needs a Bucket" — rather than
// re-running the full catch-up search matchBillPayments does.
export async function attachTransactionAsBillPayment(
  transactionId: string,
  bill: { id: string; cadence: BillCadence; nextDueDate: Date; bucketId: string | null; categoryId: string | null },
  transaction: { occurredOn: Date; amountCents: number; rawDescription: string | null },
): Promise<void> {
  await db.transaction.update({
    where: { id: transactionId },
    data: {
      billId: bill.id,
      bucketId: bill.bucketId,
      categoryId: bill.categoryId,
      aiSuggestedBucketId: null,
      aiSuggestedCategoryId: null,
    },
  });
  await db.recurringBill.update({
    where: { id: bill.id },
    data: {
      lastPaidDate: transaction.occurredOn,
      nextDueDate: nextBillDueDate(bill.cadence, bill.nextDueDate, []),
      amountCents: transaction.amountCents,
      ...(transaction.rawDescription ? { lastMatchDescriptor: transaction.rawDescription } : {}),
    },
  });
}

export async function matchBillPayments(householdId: string): Promise<void> {
  const bills = await db.recurringBill.findMany({
    where: { householdId, active: true, merchant: { not: null } },
  });
  if (bills.length === 0) return;

  // UTC midnight of the household's local "today" — every date it's compared
  // against below (cycleDueDate, a candidate's occurredOn) is a `@db.Date`
  // value, and a bare `new Date()` is a day ahead here after ~6pm
  // (TZ=America/Denver), rolling a bill's cycle forward early.
  const now = todayAsUTCDate();

  // A genuine tie (multiple candidates clearing the bar) picks the one
  // closest to the cycle's due date as the "official" payment for
  // lastPaidDate/nextDueDate rollover purposes — same "leave ambiguous
  // unmatched rather than guessed" philosophy as RecurringPattern, just
  // applied as a tie-break instead of a refusal, since not matching at all
  // would just make a real payment look overdue forever. Every other
  // qualifying candidate *within that same cycle's window* still gets
  // linked (see matchDebtPayments in debt-payments.ts for the pattern this
  // mirrors) so a second same-merchant charge in one billing cycle isn't
  // silently discarded — it shows up as an "extra" in BillRow's payments
  // list instead of vanishing with no trace.
  function closestToDue<T extends { occurredOn: Date }>(candidates: T[], dueDate: Date): T | undefined {
    return candidates.sort(
      (a, b) => Math.abs(a.occurredOn.getTime() - dueDate.getTime()) - Math.abs(b.occurredOn.getTime() - dueDate.getTime()),
    )[0];
  }

  // One batched query across every bill instead of one findMany per bill in
  // the loop below — almost every bill has zero extra-charge rules, so the
  // per-bill version paid for a full round trip per bill just to learn
  // "nothing here" most of the time (real finding, 2026-09-22 code review).
  const allExtraChargeRules = await db.billExtraChargeRule.findMany({
    where: { billId: { in: bills.map((b) => b.id) } },
  });
  const extraChargeRulesByBillId = new Map<string, typeof allExtraChargeRules>();
  for (const rule of allExtraChargeRules) {
    const arr = extraChargeRulesByBillId.get(rule.billId) ?? [];
    arr.push(rule);
    extraChargeRulesByBillId.set(rule.billId, arr);
  }

  for (const bill of bills) {
    let cycleDueDate = bill.nextDueDate;
    let cycleAmountCents = bill.amountCents;

    // Self-heals a bill left stuck by the incident above: its nextDueDate
    // can be behind its own already-recorded lastPaidDate with nothing left
    // to search for (the transaction that proves it's paid is already
    // linked) — the candidate-search loop below would never find a reason
    // to advance it. Fast-forward using only the bill's own recorded state,
    // no transaction query needed, before searching for anything new.
    // The grace window matters: a payment up to MATCH_WINDOW_DAYS *before*
    // the due date still belongs to that cycle (a bill paid a few days
    // early). Without it, a bill whose single catch-up payment got consumed
    // by an older overdue cycle sits one cycle behind forever — its bucket
    // row shows "due"/"overdue" while the lastPaidDate-driven dashboard
    // correctly shows it paid (real report, 2026-08-27).
    const paidThroughMs = bill.lastPaidDate ? bill.lastPaidDate.getTime() + MATCH_WINDOW_DAYS * DAY_MS : null;
    if (paidThroughMs !== null && cycleDueDate.getTime() <= paidThroughMs) {
      cycleDueDate = fastForwardCycleDate(cycleDueDate, paidThroughMs, MAX_CATCHUP_CYCLES, (d) =>
        nextBillDueDate(bill.cadence, d, []),
      );
      await db.recurringBill.update({ where: { id: bill.id }, data: { nextDueDate: cycleDueDate } });
    }

    // Fetched once per bill, not per cycle — this run's own newly-linked
    // matches shouldn't feed back into the same run's tolerance for a later
    // catch-up cycle, and the bill's real track record doesn't change
    // mid-run anyway.
    const recentPayments = await db.transaction.findMany({
      where: { householdId, billId: bill.id },
      orderBy: { occurredOn: "desc" },
      take: 6,
      select: { amountCents: true },
    });
    const historicalTolerance = historicalToleranceCents(recentPayments.map((p) => p.amountCents));

    // Learned ancillary fees for this bill (attachExtraBillCharge, bills/
    // actions.ts) — batched once for every bill above, not per bill here.
    // Empty for the overwhelming majority of bills that have never had one
    // manually confirmed.
    const extraChargeRules = extraChargeRulesByBillId.get(bill.id) ?? [];

    for (let i = 0; i < MAX_CATCHUP_CYCLES; i++) {
      const nextCycleDueDate = nextBillDueDate(bill.cadence, cycleDueDate, []);
      // Never let this cycle's search window bleed into the next cycle's
      // own window — that's exactly what caused the incident above. Once
      // this cycle is overdue, widen up to today (still capped) to catch a
      // payment that posted more than a few days late; a cycle that's not
      // yet due keeps the normal tight window instead. Shared with
      // matchPatternPayments/matchIncomePayments (catchupCycleWindow,
      // bill-match-window.ts) rather than hand-copied — this function is
      // where that shape originated.
      const window = catchupCycleWindow(cycleDueDate, nextCycleDueDate, now, MATCH_WINDOW_DAYS);
      if (!window) break; // this cycle isn't due yet, even loosely
      const { windowStart, windowEnd } = window;

      const tolerance = bill.toleranceCents ?? historicalTolerance ?? amountToleranceCents(cycleAmountCents);
      const candidates = await db.transaction.findMany({
        where: {
          householdId,
          billId: null,
          // A bill payment is always money out — without this, a same-
          // merchant refund credit landing in the cycle window could pass
          // the strict-name tier below (which deliberately accepts
          // candidates outside the normal amount-tolerance band) and get
          // linked as the cycle's "payment," overwriting amountCents with a
          // negative number and marking a cycle nobody actually paid as
          // paid (2026-09-11 fix).
          amountCents: { gt: 0 },
          occurredOn: { gte: windowStart, lte: windowEnd },
        },
        orderBy: { occurredOn: "asc" },
      });
      const qualifying = candidates.filter((c) => {
        const similarity = nameSimilarity(c.merchant, bill.merchant!);
        const withinTolerance = Math.abs(c.amountCents - cycleAmountCents) <= tolerance;
        const nameOk = withinTolerance
          ? similarity >= NAME_SIMILARITY_THRESHOLD
          : similarity >= STRICT_NAME_SIMILARITY_THRESHOLD;
        if (!nameOk) return false;
        // An exact merchant-text match needs no further corroboration. A
        // non-exact one (word-overlap, or the containment tier a short
        // generic brand name like "Amazon" always clears against its own
        // longer subscription name) does, whenever both sides have a raw
        // descriptor recorded — see lastMatchDescriptor's schema comment.
        if (similarity >= 1 || !bill.lastMatchDescriptor || !c.rawDescription) return true;
        return nameSimilarity(c.rawDescription, bill.lastMatchDescriptor) >= RAW_DESCRIPTION_SIMILARITY_THRESHOLD;
      });
      // No candidate for this cycle — stop here rather than guessing ahead
      // to a later cycle; a genuinely-missed payment should still show as
      // overdue at the cycle it's actually missing from.
      if (qualifying.length === 0) break;

      const official = closestToDue(qualifying, cycleDueDate)!;
      const qualifyingIds = qualifying.map((c) => c.id);

      await db.transaction.updateMany({
        where: { id: { in: qualifyingIds } },
        data: { billId: bill.id },
      });
      // A bill's payment always belongs to the bill's own bucket + category —
      // forced, not just backfilled-when-empty (2026-08-27 household rule:
      // "every transaction attached to a recurring entry should have the same
      // bucket/category as the recurring entry"). Was the source of a payment
      // showing under a different bucket than the bill it satisfied — it had
      // been auto-filed somewhere else before the bill match ever ran.
      if (bill.bucketId) {
        await db.transaction.updateMany({
          where: { id: { in: qualifyingIds } },
          data: {
            bucketId: bill.bucketId,
            categoryId: bill.categoryId,
            aiSuggestedBucketId: null,
            aiSuggestedCategoryId: null,
          },
        });
      }
      await db.recurringBill.update({
        where: { id: bill.id },
        data: {
          lastPaidDate: official.occurredOn,
          nextDueDate: nextCycleDueDate,
          amountCents: official.amountCents,
          // Only overwrite when the official match actually has one — a
          // cycle matched via a candidate with no rawDescription shouldn't
          // erase a good descriptor recorded by an earlier cycle.
          ...(official.rawDescription ? { lastMatchDescriptor: official.rawDescription } : {}),
        },
      });

      // Auto-reapply any already-learned extra-charge rule for this bill,
      // now that this cycle's own official payment date is known. Tightly
      // scoped to *that real date* (not the cycle's whole due-date window)
      // — a bill's own charge and its ancillary fee land the same real day
      // in practice (confirmed directly against a real household's data,
      // 2026-09-14), so reaching any wider risks sweeping in an unrelated
      // same-descriptor charge from a different day. extraChargeToleranceCents
      // (not the bill's own wider amountToleranceCents) keeps the amount
      // check tight too — household concern, 2026-09-14: "make sure the
      // total still lines up with expected amount."
      if (extraChargeRules.length > 0) {
        const feeWindowStart = new Date(official.occurredOn.getTime() - MATCH_WINDOW_DAYS * DAY_MS);
        const feeWindowEnd = new Date(official.occurredOn.getTime() + MATCH_WINDOW_DAYS * DAY_MS);
        const feeCandidates = await db.transaction.findMany({
          where: {
            householdId,
            billId: null,
            amountCents: { gt: 0 },
            occurredOn: { gte: feeWindowStart, lte: feeWindowEnd },
          },
        });
        for (const rule of extraChargeRules) {
          const feeTolerance = extraChargeToleranceCents(rule.amountCents);
          const feeMatches = feeCandidates.filter(
            (c) =>
              nameSimilarity(c.merchant, rule.merchant) >= NAME_SIMILARITY_THRESHOLD &&
              Math.abs(c.amountCents - rule.amountCents) <= feeTolerance,
          );
          for (const match of feeMatches) {
            await attachTransactionAsExtraCharge(match.id, bill);
          }
        }
      }

      cycleAmountCents = official.amountCents;
      cycleDueDate = nextCycleDueDate;
      if (cycleDueDate > now) break; // caught up to real time
    }
  }
}

// Drives the Buckets nav tab's red-dot badge (see app-shell.tsx/bottom-nav.tsx)
// — any bill/subscription living in a RECURRING or MIXED bucket whose due
// date is still just the app's own approximation, never confirmed by a
// human. Not scoped to any particular category (utilities, subscriptions,
// city bills — anything recurring in such a bucket counts).
export async function hasBillsNeedingAttention(householdId: string): Promise<boolean> {
  const bill = await db.recurringBill.findFirst({
    where: {
      householdId,
      active: true,
      dueDateLocked: false,
      bucket: { trackingMode: { in: ["RECURRING", "MIXED"] } },
    },
    select: { id: true },
  });
  return Boolean(bill);
}

export type BillNeedingDueDate = { id: string; name: string };

// Aggregate, named counterpart to hasBillsNeedingAttention above — for the
// dashboard's warning card (BillsNeedDueDateWarning), same dismiss-until-
// next-cycle convention as getActiveInsufficientMinimumDebts/
// getActiveDebtsNeedingSetup (debt-payments.ts): dismissing one bill
// silences it until that bill's own next due date rolls around, then it
// re-evaluates and comes back if the due date is still unconfirmed.
export async function getActiveBillsNeedingDueDate(householdId: string): Promise<BillNeedingDueDate[]> {
  const bills = await db.recurringBill.findMany({
    where: {
      householdId,
      active: true,
      dueDateLocked: false,
      bucket: { trackingMode: { in: ["RECURRING", "MIXED"] } },
    },
    select: { id: true, name: true, cadence: true, nextDueDate: true },
  });
  if (bills.length === 0) return [];

  const dismissals = await db.suggestionDismissal.findMany({
    where: { householdId, kind: "BILL_NEEDS_DUE_DATE", key: { in: bills.map((b) => b.id) } },
    select: { key: true, createdAt: true },
  });
  const dismissedAtByKey = new Map(dismissals.map((d) => [d.key, d.createdAt]));

  return bills
    .filter((b) => {
      const dismissedAt = dismissedAtByKey.get(b.id);
      if (!dismissedAt) return true;
      return dismissedAt < subtractCadence(b.nextDueDate, b.cadence);
    })
    .map((b) => ({ id: b.id, name: b.name }));
}

export type UpcomingBill = {
  id: string;
  name: string;
  // "bill" is a plain RecurringBill (fixed charge — never has extra/payoff
  // semantics); "debt" is a DebtPayment minimum and/or a payoff-plan extra
  // allocation, merged into one row per debt (see getDebtPaymentsThisWeek);
  // "pattern" is a scheduled P2P RecurringPattern (getPatternsThisWeek) —
  // bill-shaped, no extra/payoff semantics.
  kind: "bill" | "debt" | "pattern";
  // What's *still* owed this week — a bill's amount (until paid), or a
  // debt's live rolling minimum still due plus any payoff-plan extra
  // allocated this week. Already net of anything paid toward the minimum
  // (it's derived from DebtPayment.amountDueCents), so consumers must not
  // subtract paidCents from it. Feeds the "due this week" totals; the card
  // shows it as the headline for an unpaid row.
  expectedCents: number;
  // What actually landed this week toward it (0 when nothing has). For a
  // bill this is either 0 or the full amount — a fixed charge doesn't drift.
  paidCents: number;
  // Surplus beyond expectedCents — money the household put toward a debt
  // over and above this cycle's minimum *and* its planned payoff-plan extra
  // (per the 2026-08-28 "extra to debt" rework). Always 0 for a bill, and 0
  // for a debt until its rolling amount due is fully cleared.
  extraCents: number;
  // The portion of expectedCents that comes from the payoff plan (vs. the
  // bare minimum) — drives the "planned extra: $X of $Y" sub-line. 0 when
  // the plan is off or doesn't touch this debt.
  plannedExtraCents: number;
  // The bare minimum obligation for this week's occurrence *before* any
  // payment — what a partial payment is measured against for the card's
  // "$X / $Y" headline. 0 when nothing's due this week (rolled forward, an
  // installment plan that's done, or a no-minimum card). Distinct from
  // expectedCents, which folds in the full payoff-plan extra and is not the
  // right denominator for "how far into the minimum are you." Always 0 for a
  // bill (a bill is never partially paid).
  minimumDueCents: number;
  // Reimbursement credits already linked to this cycle's payment(s) (a P2P
  // repayment pinned to the bill, or a hand-linked refund — see
  // matchReimbursements). The card shows this as a "− $X Reimbursed"
  // sub-line so a big shared bill like a family phone plan reads as the
  // household's real share. Always 0 for a debt row (the reimbursement
  // model is bill-only).
  reimbursedCents: number;
  dueDate: Date;
  // The rolling minimum / bill obligation is covered — not "everything
  // expected including planned extra." Drives the green check and the card's
  // "all paid, dismissible" state.
  paid: boolean;
  // A household Skip This Cycle decision (BillCycleSkip, src/app/bills/
  // actions.ts) covers this week's occurrence — drives the same slashed-
  // circle bullet EntryLine/BillRow already show elsewhere (household
  // request, 2026-09-14: "the skipped icon like elsewhere"), and excludes
  // this row from the card's "still due" total/progress bar and its
  // all-paid dismiss check the same way `paid` does — nothing is actually
  // owed either way. `dueDate` for a skipped row is the cycle that got
  // skipped, not nextDueDate (already advanced past it), same "which week
  // this row belongs to" convention `paid` already gets from lastPaidDate.
  // For a debt row (getDebtPaymentsThisWeek), true only for a covered
  // minimum the household skipped on /debts (DebtMinimumSkip) — a payoff-plan
  // extra has its own separate skip mechanism (PayoffExtraSkip), shown
  // directly on /debts, not folded into this weekly card.
  skipped: boolean;
  // This week's payment(s) took the debt's balance to zero — the card swaps
  // the check for the amber "pays off" star, same convention as
  // cycle-calendar-view.tsx. Always false for a bill.
  paysOff: boolean;
  // The payoff plan projects this week's own extra to close the balance,
  // whether or not that's actually landed/confirmed yet — drives the "For
  // Payoff!" badge ahead of the real thing (still a plain unpaid bullet, not
  // the star `paysOff` alone earns). Always true once `paysOff` is; always
  // false for a bill.
  plannedPayoff: boolean;
  // This debt is part of the household's active debt-payoff plan
  // (payoffPlanEnabled + Debt.includeInPayoffPlan + still has a balance) —
  // drives the card's green target marker, independent of whether the plan
  // routes any *extra* to it this particular week. Always false for a bill.
  inPayoffPlan: boolean;
  // False when dueDate is a projection (an installment plan's rolling
  // "last real payment + cadence" guess, or a revolving debt's inferred
  // date) rather than a confirmed one — mirrors DebtPayment.dueDateLocked,
  // which already drives the "~" marker on /debts (debt-row.tsx). Always
  // true for a bill (a RecurringBill's own schedule is never a guess).
  dueDateConfirmed: boolean;
  // True only for the rare row that reads unpaid while the debt's own
  // synced balance already shows $0 — a bank-aggregator balance feed and
  // its transaction feed refresh independently, so the balance can confirm
  // a payoff days before the actual closing transaction ever posts (see
  // getDebtPaymentsThisWeek's splitSettledPayment comment). Drives a small
  // "balance updated — payment details pending" note instead of leaving an
  // unexplained contradiction against the dashboard's own "Paid Off" badge.
  // Always false for a bill and for any other debt row.
  pendingBalanceConfirmation: boolean;
  // What this week's payoff-plan extra pool was made of — undefined for a
  // bill, a debt row with no plan extra this week, or a past week (a
  // PayoffExtraSnapshot never persisted this breakdown, only the total).
  // Drives the same "Rolled From X" hover breakdown /debts shows on its own
  // extra-payment icon (household request, 2026-09-28).
  poolBreakdown?: PoolBreakdown;
};

export { principalTowardDebtCents } from "@/lib/upcoming-bills-shared";

// "This week" for the dashboard card: the actual Sunday-through-Saturday
// calendar week, not a rolling "now +/- 7 days" window — a bill overdue from
// last month must not linger here forever just because its (stale)
// nextDueDate is still in the past. Bills due this calendar week, plus
// anything paid this calendar week (so one paid a day early still shows as
// confirmed instead of vanishing from the week's view the moment
// nextDueDate rolls forward past it).
// `weekOf` picks which Sun–Sat calendar week to report on — a date inside
// last week, for the dashboard's retrospective "Last Week's Bills" card,
// rather than always the current week. Defaults to now (unchanged callers).
export async function getBillsThisWeek(householdId: string, weekOf: Date = new Date()): Promise<UpcomingBill[]> {
  const { start, end } = currentWeekBounds(weekOf);

  const bills = await db.recurringBill.findMany({
    where: {
      householdId,
      AND: [
        // A bill cancelled but already paid this month still belongs on
        // this week's card if that payment landed this week — see
        // currentPeriodBillWhere.
        currentPeriodBillWhere(),
        {
          OR: [
            { nextDueDate: { gte: start, lt: end } },
            { lastPaidDate: { gte: start, lt: end } },
            // A skipped cycle never touches nextDueDate/lastPaidDate for the
            // week it actually belonged to — skipBillCycle advances
            // nextDueDate straight past it, same as a real payment would,
            // so without this a skipped bill just vanished from every
            // week's card entirely (real report, 2026-09-14: Summit Gas,
            // skipped, disappeared from both "This Week's Bills" and "Last
            // Week's Bills"). Deliberately wide — any skip ever recorded for
            // this week, even one since superseded by a later payment/skip
            // — isBillCycleSkipActive below narrows it to the one still
            // worth showing.
            { cycleSkips: { some: { cycleDueDate: { gte: start, lt: end } } } },
          ],
        },
      ],
    },
    orderBy: { nextDueDate: "asc" },
    include: {
      // Newest few payments + the credits linked back to each as a
      // reimbursement — enough to isolate this cycle's cluster and net it
      // (same MATCH_WINDOW_DAYS clustering as bill-row.tsx).
      payments: {
        orderBy: { occurredOn: "desc" },
        take: 5,
        select: { occurredOn: true, reimbursedBy: { select: { amountCents: true } } },
      },
    },
  });
  // The one shared "is this bill's most recent skip still active" primitive
  // (getActiveBillCycleSkips' own comment) — reused here rather than a
  // second hand-rolled cycleSkips-include + isBillCycleSkipActive pairing,
  // so a future change to how "most recent skip" is picked only has to
  // happen in one place (2026-09-14 code review: this and
  // getPaymentCalendarThisCycle/getPaymentCalendarIcsEvents, debt-payments.ts,
  // had each grown their own copy of this same pairing).
  const activeSkips = await getActiveBillCycleSkips(householdId, bills);

  return bills.map((b) => {
    const paid = Boolean(b.lastPaidDate && b.lastPaidDate >= start && b.lastPaidDate < end);
    // Only relevant to *this* week's card when the skipped cycle's own date
    // actually falls in this window, same as `paid` keys off lastPaidDate
    // above.
    const activeSkipDate = activeSkips.get(b.id) ?? null;
    const skipped = !paid && activeSkipDate !== null && activeSkipDate >= start && activeSkipDate < end;
    // This cycle's payment cluster: everything within MATCH_WINDOW_DAYS of
    // the most recent payment (b.payments is newest-first), matching how
    // bill-row.tsx isolates the current cycle from older history.
    const mostRecent = b.payments[0];
    const reimbursedCents = mostRecent
      ? b.payments
          .filter(
            (p) => Math.abs(p.occurredOn.getTime() - mostRecent.occurredOn.getTime()) <= MATCH_WINDOW_DAYS * DAY_MS,
          )
          .reduce((s, p) => s + p.reimbursedBy.reduce((rs, r) => rs + Math.abs(r.amountCents), 0), 0)
      : 0;
    return {
      id: b.id,
      name: b.name,
      kind: "bill" as const,
      expectedCents: b.amountCents,
      paidCents: paid ? b.amountCents : 0,
      extraCents: 0,
      plannedExtraCents: 0,
      minimumDueCents: 0,
      reimbursedCents,
      paysOff: false,
      plannedPayoff: false,
      inPayoffPlan: false,
      dueDateConfirmed: true,
      pendingBalanceConfirmation: false,
      // nextDueDate already rolled forward to *next* cycle the moment this
      // one was confirmed paid or skipped (see the schema comment) —
      // showing it here would display next/skipped-past month's date under
      // a "paid"/"skipped" bullet. lastPaidDate is this cycle's real date
      // once paid, the skip's own cycleDueDate once skipped; only a still-
      // open bill's dueDate is the upcoming occurrence.
      dueDate: paid ? b.lastPaidDate! : skipped ? activeSkipDate! : b.nextDueDate,
      paid,
      skipped,
    };
  });
}


// Scheduled outgoing P2P patterns (a monthly Venmo tuition payment) for the
// same Sun–Sat week as getBillsThisWeek — they're real recurring
// obligations, but the card used to read only RecurringBill + DebtPayment
// rows, so they never appeared (household report, 2026-10-02: a pattern
// due Oct 1, missing). Excluded: unscheduled patterns (no
// cadence/nextDueDate — nothing to place in a week), CREDIT patterns
// (money in), a pattern pinned to a bill (the bill row already covers it)
// or to a debt (its payments already land on that debt's row). Paid/due
// date follow getBillsThisWeek exactly: lastPaidDate in the week = paid
// (nextDueDate has already rolled past it), else nextDueDate in the week.
// Unpaid amount is the pattern's range midpoint, same as PatternRow.
export async function getPatternsThisWeek(householdId: string, weekOf: Date = new Date()): Promise<UpcomingBill[]> {
  const { start, end } = currentWeekBounds(weekOf);
  const patterns = await db.recurringPattern.findMany({
    where: {
      householdId,
      direction: "DEBIT",
      countsAsIncome: false,
      billId: null,
      debtId: null,
      cadence: { not: null },
      AND: [
        currentPeriodPatternWhere(),
        { OR: [{ nextDueDate: { gte: start, lt: end } }, { lastPaidDate: { gte: start, lt: end } }] },
      ],
    },
    include: {
      transactions: {
        where: { occurredOn: { gte: start, lt: end } },
        select: { amountCents: true },
      },
    },
  });
  return patterns.map((p) => {
    const paid = Boolean(p.lastPaidDate && p.lastPaidDate >= start && p.lastPaidDate < end);
    const paidCents = paid ? p.transactions.reduce((sum, t) => sum + Math.abs(t.amountCents), 0) : 0;
    const expectedCents = paid && paidCents > 0 ? paidCents : Math.round((p.amountMinCents + p.amountMaxCents) / 2);
    return {
      id: p.id,
      name: p.label,
      kind: "pattern" as const,
      expectedCents,
      paidCents,
      extraCents: 0,
      plannedExtraCents: 0,
      minimumDueCents: 0,
      reimbursedCents: 0,
      paysOff: false,
      plannedPayoff: false,
      inPayoffPlan: false,
      dueDateConfirmed: paid || p.dueDateLocked,
      pendingBalanceConfirmation: false,
      dueDate: paid ? p.lastPaidDate! : p.nextDueDate!,
      paid,
      skipped: false,
    };
  });
}

// Dashboard's "This week's bills" card, once every bill/payment in it is
// paid: the close button in its corner dismisses it for the rest of the
// current calendar week. Keying the dismissal on currentWeekKey (rather
// than a "newer than" comparison like getActiveUncategorizedCount) means it
// clears itself automatically — no cron/expiry needed — since next week's
// key won't match and the dismissal for this week is simply irrelevant to it.
export async function isBillsThisWeekDismissed(householdId: string): Promise<boolean> {
  const dismissal = await db.suggestionDismissal.findUnique({
    where: { householdId_kind_key: { householdId, kind: "BILLS_THIS_WEEK", key: currentWeekKey() } },
  });
  return Boolean(dismissal);
}

export async function dismissBillsThisWeek(householdId: string): Promise<void> {
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId, kind: "BILLS_THIS_WEEK", key: currentWeekKey() } },
    create: { householdId, kind: "BILLS_THIS_WEEK", key: currentWeekKey() },
    update: {},
  });
}

function todayKey(): string {
  // Local calendar day (currentDateKey), not toISOString()'s UTC day — this
  // keys the once-per-day BillsInsight cache; a UTC key rolls the cache over
  // in the early evening here, hours before the household's day actually ends.
  return currentDateKey();
}

// A cache keyed on dateKey alone goes stale the moment anything about the
// underlying bills changes later the same day (a due date correction, a
// bill marked paid, a newly tracked bill) — the dashboard would keep
// showing an old AI narrative that visibly contradicts the freshly-queried
// "this week" list rendered right below it. Folding a hash of the actual
// bill snapshot into the cache key means a same-day repeat view with
// nothing changed still hits the cache (preserving the Gemini-quota intent
// below), but any real change earns a fresh summary instead of a stale one.
function billsSnapshotHash(bills: UpcomingBill[]): string {
  const serialized = bills
    .map(
      (b) =>
        `${b.id}:${b.expectedCents}:${b.paidCents}:${b.extraCents}:${b.reimbursedCents}:${b.paid}:${b.skipped}:${b.paysOff}:${b.dueDate
          .toISOString()
          .slice(0, 10)}`,
    )
    .join("|");
  return createHash("sha1").update(serialized).digest("hex").slice(0, 16);
}

// Wraps summarizeUpcomingBills with a once-per-day-per-household-per-
// snapshot cache (BillsInsight) — the dashboard card renders on every Home
// page load, and Gemini quota is a real billed constraint (see
// WORKING_ON.md), not something to spend on an identical narrative twenty
// times a day.
export async function getUpcomingBillsSummary(
  householdId: string,
  bills: UpcomingBill[],
): Promise<string | null> {
  if (bills.length === 0) return null;
  const dateKey = todayKey();
  const snapshotHash = billsSnapshotHash(bills);

  const cached = await db.billsInsight.findUnique({
    where: { householdId_dateKey_snapshotHash: { householdId, dateKey, snapshotHash } },
  });
  if (cached) return cached.summary;
  // Demo household: no provider to call — fall back to the most recent
  // insight the seed baked (the bill set is static), so the dashboard card
  // keeps its one-liner instead of going blank the day after seeding.
  if (await isDemoHousehold(householdId)) {
    const seeded = await db.billsInsight.findFirst({
      where: { householdId },
      orderBy: { createdAt: "desc" },
    });
    return seeded?.summary ?? null;
  }

  const summary = await summarizeUpcomingBills(
    householdId,
    bills
      // A skipped bill isn't genuinely due this week — nothing's owed — so
      // it's left out of the AI's own "$X due" narrative entirely rather
      // than teaching the prompt a new state; the card's own visual list
      // still shows it, struck through with its skipped icon, regardless
      // (household request, 2026-09-14).
      .filter((b) => !b.skipped)
      .map((b) => ({
        name: b.name,
        // What the obligation actually was: once paid, expectedCents has
        // collapsed toward 0, so fall back to what landed (net of surplus).
        amountCents: b.paid ? Math.max(b.expectedCents, b.paidCents - b.extraCents) : b.expectedCents,
        dueDate: b.dueDate.toISOString().slice(0, 10),
        paid: b.paid,
        extraCents: b.extraCents,
        reimbursedCents: b.reimbursedCents,
        paysOff: b.paysOff,
      })),
  );
  if (!summary) return null;

  await db.billsInsight.upsert({
    where: { householdId_dateKey_snapshotHash: { householdId, dateKey, snapshotHash } },
    create: { householdId, dateKey, snapshotHash, summary },
    update: { summary },
  });
  return summary;
}

export type PendingBillAmountReview = {
  id: string;
  billName: string;
  expectedAmountCents: number;
  observedAmountCents: number;
  dueDate: Date | null;
};

// Dashboard/bills-page card data (see bill-amount-review-card.tsx) — every
// pending "did your bill's amount change?" question across the household,
// oldest first. The RecurringBill counterpart to getPendingDebtAmountReviews
// (debt-payments.ts) — bills have no bank-sync-triggered review (see
// RecurringBill.amountCents' schema comment), only the email-sourced one.
export async function getPendingBillAmountReviews(householdId: string): Promise<PendingBillAmountReview[]> {
  const reviews = await db.billAmountReview.findMany({
    where: { householdId },
    orderBy: { createdAt: "asc" },
    include: { bill: { select: { name: true } } },
  });
  return reviews.map((r) => ({
    id: r.id,
    billName: r.bill.name,
    expectedAmountCents: r.expectedAmountCents,
    observedAmountCents: r.observedAmountCents,
    dueDate: r.dueDate,
  }));
}
