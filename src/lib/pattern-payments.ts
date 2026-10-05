import { db } from "@/lib/db";
import { todayAsUTCDate } from "@/lib/date";
import { nextBillDueDate, MAX_CATCHUP_CYCLES } from "@/lib/recurring-bills";
import { MATCH_WINDOW_DAYS, catchupCycleWindow, fastForwardCycleDate } from "@/lib/bill-match-window";
import { patternCounterpartyMatches, patternMatchData } from "@/lib/pattern-match";
import { mapConcurrent } from "@/lib/concurrency";
import { Prisma, type RecurringPattern } from "@prisma/client";

const DAY_MS = 86_400_000;

// How far past a cycle's own tight match window (MATCH_WINDOW_DAYS on
// either side) to still look for a *counterparty-matched* transaction worth
// raising a review for, instead of just giving up on this cycle silently.
// Wide enough to catch "paid a couple weeks early/late, different amount
// than usual" without becoming a second, looser matcher in disguise — it's
// still gated on a real counterparty match (see below), never on amount or
// channelKeyword alone.
const REVIEW_SEARCH_DAYS = 21;

// The RecurringPattern counterpart to matchBillPayments (recurring-bills.ts)
// — only ever processes a *scheduled* pattern (cadence + nextDueDate set).
// An unscheduled pattern (no email connected when it was created, or one
// from before this feature existed) keeps matching through the generic
// per-sync categorizer instead (matchRecurringPattern, called from
// simplefin-sync.ts's categorizeUncategorizedTransactions, which excludes
// every pattern this function owns — see that query's own comment).
//
// Same "one cycle at a time, self-heal a stuck nextDueDate, MAX_CATCHUP_CYCLES
// cap" shape as matchBillPayments — see that function's own comment for the
// real incident (2026-08-14) this structure exists to avoid repeating.
//
// `patternId` scopes the sweep to just one pattern — createPattern/
// updatePattern (transactions/actions.ts) pass the pattern they just saved
// rather than leaving this unscoped, which used to re-walk every *other*
// scheduled pattern in the household synchronously inside that one save's
// server action (real finding, 2026-09-12 code review; reassignTransactionsForPattern
// right above those call sites already shows the scoped, single-pattern
// alternative). Omit it (the SimpleFIN sync path, simplefin-sync.ts) to run
// the full household sweep, same as before.
export async function matchPatternPayments(householdId: string, patternId?: string): Promise<void> {
  const patterns = await db.recurringPattern.findMany({
    where: {
      householdId,
      active: true,
      cadence: { not: null },
      nextDueDate: { not: null },
      ...(patternId ? { id: patternId } : {}),
    },
  });
  if (patterns.length === 0) return;

  const now = todayAsUTCDate();

  // Each pattern's own catch-up walk is fully independent (no shared
  // mutable state, order doesn't matter) — bounded concurrency instead of
  // one-at-a-time sequential, same treatment simplefin-sync.ts's own
  // per-transaction loops already got (real finding, 2026-09-22 code
  // review: this new file didn't carry the pattern over).
  await mapConcurrent(patterns, 8, async (pattern) => {
    if (!pattern.cadence || !pattern.nextDueDate) return; // narrows for TS; query already guarantees this

    let cycleDueDate = pattern.nextDueDate;

    // Self-heal: lastPaidDate can already be ahead of nextDueDate with
    // nothing left to search for (its own qualifying transaction is already
    // linked to a past cycle) — same fast-forward matchBillPayments/
    // matchIncomePayments both do.
    const paidThroughMs = pattern.lastPaidDate
      ? pattern.lastPaidDate.getTime() + MATCH_WINDOW_DAYS * DAY_MS
      : null;
    if (paidThroughMs !== null && cycleDueDate.getTime() <= paidThroughMs) {
      cycleDueDate = fastForwardCycleDate(cycleDueDate, paidThroughMs, MAX_CATCHUP_CYCLES, (d) =>
        nextBillDueDate(pattern.cadence!, d, []),
      );
      await db.recurringPattern.update({ where: { id: pattern.id }, data: { nextDueDate: cycleDueDate } });
    }

    for (let i = 0; i < MAX_CATCHUP_CYCLES; i++) {
      const nextCycleDueDate = nextBillDueDate(pattern.cadence, cycleDueDate, []);
      const window = catchupCycleWindow(cycleDueDate, nextCycleDueDate, now, MATCH_WINDOW_DAYS);
      if (!window) break; // this cycle isn't due yet, even loosely
      const { windowStart, windowEnd } = window;

      const candidates = await db.transaction.findMany({
        where: {
          householdId,
          patternId: null,
          amountCents: pattern.direction === "DEBIT" ? { gt: 0 } : { lt: 0 },
          occurredOn: { gte: windowStart, lte: windowEnd },
        },
        orderBy: { occurredOn: "asc" },
        select: { id: true, merchant: true, amountCents: true, occurredOn: true, resolvedMerchant: true, receiptNote: true },
      });

      // amountMinCents/amountMaxCents already have the pattern's own
      // tolerance baked in at save time (transactions/actions.ts:
      // amountMinCents = amountCents - effectiveTolerance) — applying
      // `tolerance` a second time here on top of that doubled the effective
      // acceptance band (real finding, 2026-09-12 code review: a $150 ± $10
      // pattern was actually accepting $130-$170, not the configured
      // $140-$160).
      const qualifying = candidates.filter((c) => {
        const amount = Math.abs(c.amountCents);
        if (amount < pattern.amountMinCents || amount > pattern.amountMaxCents) return false;
        if (!patternCounterpartyMatches(pattern, c)) return false;
        // No known counterparty (no email connected, or nothing resolved
        // yet) — the channelKeyword substring is the only identity signal
        // available, same bar the unscheduled matcher uses.
        if (!pattern.counterpartyName && !c.merchant.toLowerCase().includes(pattern.channelKeyword.toLowerCase())) {
          return false;
        }
        return true;
      });

      if (qualifying.length > 0) {
        const official = qualifying.reduce((closest, c) =>
          Math.abs(c.occurredOn.getTime() - cycleDueDate.getTime()) <
          Math.abs(closest.occurredOn.getTime() - cycleDueDate.getTime())
            ? c
            : closest,
        );
        await db.transaction.updateMany({
          where: { id: { in: qualifying.map((c) => c.id) } },
          data: patternMatchData(pattern),
        });
        await db.recurringPattern.update({
          where: { id: pattern.id },
          data: { lastPaidDate: official.occurredOn, nextDueDate: nextCycleDueDate, dueDateLocked: true },
        });
        cycleDueDate = nextCycleDueDate;
        if (cycleDueDate > now) break; // caught up to real time
        continue;
      }

      // No candidate qualified for this cycle's own tight window. Widen the
      // search — but only when there's a real counterparty to search for;
      // a channelKeyword-only pattern has no identity signal precise enough
      // to safely flag a "close but not quite" candidate without just
      // reinventing the too-broad matching this feature exists to fix.
      if (pattern.counterpartyName) {
        await raisePatternPaymentReview(householdId, pattern, cycleDueDate);
      }
      break; // a genuinely-missed cycle stays overdue, not guessed past
    }
  });
}

// Widened, counterparty-identity-only search (no amount/date tolerance) for
// a transaction that's clearly the same person but landed outside this
// cycle's expected window — surfaced on the dashboard for a human decision
// instead of silently dropped or silently forced through. One review per
// transaction (the schema's own @unique constraint on transactionId is the
// real guard; the pre-check here just avoids a pointless duplicate query
// each sync once one's already pending).
async function raisePatternPaymentReview(
  householdId: string,
  pattern: RecurringPattern,
  cycleDueDate: Date,
): Promise<void> {
  const windowStart = new Date(cycleDueDate.getTime() - REVIEW_SEARCH_DAYS * DAY_MS);
  const windowEnd = new Date(cycleDueDate.getTime() + REVIEW_SEARCH_DAYS * DAY_MS);

  const candidates = await db.transaction.findMany({
    where: {
      householdId,
      patternId: null,
      patternPaymentReview: null,
      amountCents: pattern.direction === "DEBIT" ? { gt: 0 } : { lt: 0 },
      occurredOn: { gte: windowStart, lte: windowEnd },
    },
    select: { id: true, amountCents: true, occurredOn: true, resolvedMerchant: true, receiptNote: true },
  });

  const matched = candidates.filter((c) => patternCounterpartyMatches(pattern, c));
  if (matched.length === 0) return;

  // Closest to the expected due date — same "one candidate, not a bulk
  // flag" restraint as matchBillPayments' own tie-break.
  const official = matched.reduce((closest, c) =>
    Math.abs(c.occurredOn.getTime() - cycleDueDate.getTime()) < Math.abs(closest.occurredOn.getTime() - cycleDueDate.getTime())
      ? c
      : closest,
  );

  try {
    await db.patternPaymentReview.create({
      data: {
        householdId,
        patternId: pattern.id,
        transactionId: official.id,
        observedAmountCents: Math.abs(official.amountCents),
        expectedAmountCents: Math.round((pattern.amountMinCents + pattern.amountMaxCents) / 2),
      },
    });
  } catch (err) {
    // transactionId is @unique — a manual "Sync Now" overlapping the
    // scheduled poll can have two matchPatternPayments runs both see
    // patternPaymentReview:null for the same candidate before either
    // writes. The loser used to throw this unhandled, aborting every later
    // step of that sync run (matchReimbursements onward) and marking the
    // whole BankConnection ERROR over what's actually a benign race — same
    // "loser is a no-op, not a real error" idiom reports.ts/budget-plan.ts
    // already use for their own racy creates (real finding, 2026-09-14
    // code review).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
}

export type PendingPatternPaymentReview = {
  id: string;
  patternLabel: string;
  expectedAmountCents: number;
  observedAmountCents: number;
};

// Dashboard card data (see pattern-payment-review-card.tsx) — every pending
// "does this count as this cycle's payment?" question across the household,
// oldest first. Mirrors getPendingDebtAmountReviews (debt-payments.ts).
export async function getPendingPatternPaymentReviews(householdId: string): Promise<PendingPatternPaymentReview[]> {
  const reviews = await db.patternPaymentReview.findMany({
    where: { householdId, declinedAt: null },
    orderBy: { createdAt: "asc" },
    include: { pattern: { select: { label: true } } },
  });
  return reviews.map((r) => ({
    id: r.id,
    patternLabel: r.pattern.label,
    expectedAmountCents: r.expectedAmountCents,
    observedAmountCents: r.observedAmountCents,
  }));
}
