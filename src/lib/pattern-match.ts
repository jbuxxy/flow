import type { Prisma, RecurringPattern } from "@prisma/client";
import { nameSimilarity } from "@/lib/fuzzy-match";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";

// Mirrors currentPeriodBillWhere (src/lib/recurring-bills.ts) for a
// scheduled pattern: cancelling one (active:false — see cancelPattern,
// src/app/transactions/actions.ts) doesn't retroactively vanish a cycle
// that's already paid and already counted against its bucket this month —
// same "cancel a subscription right after making its final payment" story
// a bill already gets. An unscheduled pattern has no real cycle to
// preserve this way, so it drops the instant it's inactive, same as
// before this existed.
export function currentPeriodPatternWhere(): Prisma.RecurringPatternWhereInput {
  const { start } = utcPeriodBounds(currentPeriodKey());
  return {
    OR: [{ active: true }, { active: false, cadence: { not: null }, lastPaidDate: { gte: start } }],
  };
}

// A receipt-resolved counterparty name is expected to closely match a
// pattern's own stored counterpartyName (both ultimately came from the same
// AI receipt-extraction pipeline) — 0.75 is the same "one string basically
// contains/resembles the other" bar recurring-bills.ts's own
// NAME_SIMILARITY_THRESHOLD uses for the analogous merchant-name check.
const COUNTERPARTY_SIMILARITY_THRESHOLD = 0.75;

// Both only ever populated once a receipt has linked (see linkReceipt,
// src/lib/receipt-sync.ts) — null for a household with no email connected,
// or a transaction whose receipt hasn't arrived/matched yet. Every
// counterparty/note check is a no-op (passes) whenever the *pattern*
// doesn't require it, regardless of whether these are set.
export type CounterpartyCandidateTxn = {
  resolvedMerchant?: string | null;
  receiptNote?: string | null;
};

export type PatternCandidateTxn = CounterpartyCandidateTxn & {
  merchant: string;
  amountCents: number;
  occurredOn: Date;
};

// Whether `txn` satisfies `pattern`'s counterparty/note requirements — a
// no-op (true) for a pattern with neither set, which is the actual live
// path for most patterns: a household with no email connected, or one whose
// pattern predates this field, keeps matching purely on channelKeyword +
// amount, exactly as before this existed. Exported so
// matchPatternPayments (src/lib/pattern-payments.ts) can reuse the exact
// same predicate for its own cycle-scoped candidate search instead of
// re-implementing it.
export function patternCounterpartyMatches(
  pattern: Pick<RecurringPattern, "counterpartyName" | "noteKeywords">,
  txn: CounterpartyCandidateTxn,
): boolean {
  if (pattern.counterpartyName) {
    if (!txn.resolvedMerchant) return false;
    if (nameSimilarity(txn.resolvedMerchant, pattern.counterpartyName) < COUNTERPARTY_SIMILARITY_THRESHOLD) {
      return false;
    }
  }
  if (pattern.noteKeywords.length > 0) {
    const note = txn.receiptNote?.toLowerCase() ?? "";
    if (!note || !pattern.noteKeywords.some((k) => note.includes(k.toLowerCase()))) return false;
  }
  return true;
}

// A transaction with amountCents < 0 (money in) can only match a CREDIT
// pattern; amountCents > 0 (money out) can only match DEBIT. Direction is
// derived from sign, never stored per-transaction, so the caller decides
// which side to check by passing the pattern list already filtered — this
// just does the amount/channel/date scoring.
//
// Only ever called with *unscheduled* patterns (no cadence/nextDueDate) —
// a scheduled one is matched by matchPatternPayments' own cycle-aware walk
// instead (see that file, and simplefin-sync.ts's patterns query, which
// excludes cadence-having patterns from what it passes in here). Both
// callers of this function (the sync-time categorizer, and
// reassignTransactionsForPattern's retroactive sweep) already scope their
// own pattern lists the same way.
export function matchRecurringPattern(
  patterns: RecurringPattern[],
  txn: PatternCandidateTxn,
): RecurringPattern | null {
  const merchant = txn.merchant.toLowerCase();
  const amount = Math.abs(txn.amountCents);
  const direction = txn.amountCents < 0 ? "CREDIT" : "DEBIT";

  const candidates = patterns.filter(
    (p) =>
      p.active &&
      p.direction === direction &&
      merchant.includes(p.channelKeyword.toLowerCase()) &&
      amount >= p.amountMinCents &&
      amount <= p.amountMaxCents &&
      patternCounterpartyMatches(p, txn),
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // More than one pattern's amount range covers this transaction (e.g. two
  // activities that happen to cost about the same) — break the tie using
  // day-of-month/weekday hints. Only auto-resolve if one candidate clearly
  // scores higher; a genuine tie is left unmatched rather than guessed.
  const day = txn.occurredOn.getUTCDate();
  const weekday = txn.occurredOn.getUTCDay();
  const scored = candidates.map((p) => {
    let score = 0;
    if (p.dayOfMonthStart != null && p.dayOfMonthEnd != null) {
      score += day >= p.dayOfMonthStart && day <= p.dayOfMonthEnd ? 2 : -2;
    }
    if (p.weekdays.length > 0) {
      score += p.weekdays.includes(weekday) ? 1 : -1;
    }
    return { pattern: p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score > scored[1].score) return scored[0].pattern;
  return null;
}

// Shared by the sync-time matcher (simplefin-sync.ts) and the retroactive
// reassignment sweep (pattern-reassign.ts) so a matched transaction always
// gets routed identically regardless of which one found it. DEBIT can point
// at a bucket, a debt, or neither ("tag only" — isTransfer but no spend
// disposition); the two are always mutually exclusive (see resolveTarget in
// src/app/transactions/actions.ts).
export function patternMatchData(pattern: RecurringPattern) {
  if (pattern.direction === "DEBIT") {
    return {
      patternId: pattern.id,
      bucketId: pattern.bucketId,
      debtId: pattern.debtId,
      // A category only ever rides along with a bucket (2026-08-27 household
      // rule — Transaction.categoryId must sit inside Transaction.bucketId).
      // A debt-targeted pattern has no bucket, so its matches are pure
      // transfers with no spend category.
      categoryId: pattern.bucketId ? pattern.categoryId : null,
      isTransfer: !pattern.bucketId,
      isIncome: false,
      aiSuggestedBucketId: null,
      aiSuggestedCategoryId: null,
    };
  }
  return {
    patternId: pattern.id,
    isIncome: pattern.countsAsIncome,
    isTransfer: !pattern.countsAsIncome,
    bucketId: null,
    debtId: null,
    categoryId: pattern.categoryId,
    aiSuggestedBucketId: null,
    aiSuggestedCategoryId: null,
  };
}
