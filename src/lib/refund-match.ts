import { db } from "@/lib/db";
import { currentWeekKey, daysAgo } from "@/lib/period";
import { budgetTrackedWhere } from "@/lib/budget-tracked";
import { creditDoesNotIdentifyPayee } from "@/lib/reimbursements";

// How far back a refund can plausibly point — most return windows close
// well within this, padded generously rather than tuned tight: missing a
// genuine match (leaving a credit unlinked, netting on its own post date,
// today's existing behavior) costs far less than a WRONG auto-link would
// (silently misattributing a refund to the wrong purchase's month). Also
// doubles as how long an ambiguous credit sits in getUnmatchedRefunds/the
// "Refunds" review queue before it's dropped on its own (real household
// ask, 2026-09-05: "just like the others once something is over 90 days we
// drop it") — a credit still unresolved after 90 days isn't going to get
// resolved by staring at it longer; dismissRefundReview below is the other,
// explicit way out of the queue.
const REFUND_MATCH_LOOKBACK_DAYS = 90;

export type RefundCandidate = { id: string; amountCents: number; occurredOn: Date };

// Every positive transaction at this merchant that could plausibly be what
// a refund credit is paying back: same household, same merchant
// (case-insensitive), on or before the credit's own date (a refund can't
// precede its purchase), within the lookback window, and not already
// claimed by another refund — a purchase already reimbursedBy something
// isn't offered again. No partial-refund tracking here (see the schema's
// own TransactionOffset for that separate, harder case); this is strictly
// "which one whole purchase does this whole credit undo."
export async function findRefundPurchaseCandidates(
  householdId: string,
  merchant: string,
  onOrBefore: Date,
): Promise<RefundCandidate[]> {
  const since = new Date(onOrBefore.getTime() - REFUND_MATCH_LOOKBACK_DAYS * 86_400_000);
  return db.transaction.findMany({
    where: {
      householdId,
      merchant: { equals: merchant, mode: "insensitive" },
      amountCents: { gt: 0 },
      occurredOn: { gte: since, lte: onOrBefore },
      reimbursedBy: { none: {} },
    },
    orderBy: { occurredOn: "desc" },
    select: { id: true, amountCents: true, occurredOn: true },
  });
}

// Attempts to link a refund-looking credit (merchant has real spend
// history — see simplefin-sync.ts's own hasSpendHistory check, which is
// what decides whether this gets called at all instead of defaulting the
// credit to income) to the one specific purchase it pays back. Exactly one
// candidate at that merchant for the exact same amount — refunds routinely
// are exact, a returned item's own price, not a fuzzy approximation — gets
// linked outright. Two or more candidates (which one?) is left alone for a
// human; see getUnmatchedRefunds for that queue. Zero candidates can't
// happen from the sync caller (it already confirmed spend history exists)
// but is handled the same safe way regardless.
export async function tryAutoLinkRefund(
  householdId: string,
  credit: { id: string; merchant: string; amountCents: number; occurredOn: Date },
): Promise<"linked" | "ambiguous" | "none"> {
  const candidates = await findRefundPurchaseCandidates(householdId, credit.merchant, credit.occurredOn);
  const exactMatches = candidates.filter((c) => c.amountCents === Math.abs(credit.amountCents));
  if (exactMatches.length === 1) {
    await db.transaction.update({
      where: { id: credit.id },
      data: { reimbursesTransactionId: exactMatches[0].id },
    });
    return "linked";
  }
  return candidates.length > 0 ? "ambiguous" : "none";
}

// Same-merchant matching above requires the credit's own merchant text to
// literally match the original purchase's — never true for a P2P app or a
// card network's own dispute-resolution credit ("Visa Chargeback
// Adjustment"), whose merchant field never identifies the real payee at all
// (see creditDoesNotIdentifyPayee, reimbursements.ts). Every positive
// transaction of the exact same amount, regardless of merchant, is the
// fallback candidate pool for exactly that subset — household request,
// 2026-09-27, after a "Visa Chargeback Adjustment" credit found zero
// same-merchant candidates (no purchase is ever literally named that) and
// fell straight to being counted as income with no review at all.
async function findAmountOnlyRefundCandidates(
  householdId: string,
  amountCents: number,
  onOrBefore: Date,
): Promise<RefundCandidate[]> {
  const since = new Date(onOrBefore.getTime() - REFUND_MATCH_LOOKBACK_DAYS * 86_400_000);
  return db.transaction.findMany({
    where: {
      householdId,
      amountCents,
      occurredOn: { gte: since, lte: onOrBefore },
      reimbursedBy: { none: {} },
    },
    orderBy: { occurredOn: "desc" },
    select: { id: true, amountCents: true, occurredOn: true },
  });
}

// The amount-only counterpart to tryAutoLinkRefund, called only for a credit
// creditDoesNotIdentifyPayee already flagged as unable to match by merchant.
// findAmountOnlyRefundCandidates already filters to the exact amount, so
// (unlike tryAutoLinkRefund) there's no separate exact-match filter step —
// every candidate returned already qualifies.
export async function tryAutoLinkGenericCredit(
  householdId: string,
  credit: { id: string; amountCents: number; occurredOn: Date },
): Promise<"linked" | "ambiguous" | "none"> {
  const candidates = await findAmountOnlyRefundCandidates(householdId, Math.abs(credit.amountCents), credit.occurredOn);
  if (candidates.length === 1) {
    await db.transaction.update({
      where: { id: credit.id },
      data: { reimbursesTransactionId: candidates[0].id },
    });
    return "linked";
  }
  return candidates.length > 0 ? "ambiguous" : "none";
}

export type UnmatchedRefund = {
  id: string;
  merchant: string;
  amountCents: number;
  occurredOn: Date;
  // Import time — the refund-review nudge's "anything new?" anchor.
  createdAt: Date;
  candidates: RefundCandidate[];
};

// Every refund-looking credit sync already recognized (real spend history
// at that merchant) but couldn't confidently auto-link — the same "which of
// several trips was this?" gap Transaction.reimbursesMerchant's own schema
// comment describes, surfaced as its own queue instead of requiring a
// household to notice and open the linker unprompted. Re-evaluated live,
// same as the P2P/"needs a bucket" queues (no separate stored "ambiguous"
// flag) — so once another refund claims one of two candidates, freeing the
// other back down to a lone exact match, this queue drops the row on its
// own the next time it's read, without needing a re-sync to notice.
export async function getUnmatchedRefunds(householdId: string): Promise<UnmatchedRefund[]> {
  const since = daysAgo(REFUND_MATCH_LOOKBACK_DAYS);
  const credits = await db.transaction.findMany({
    where: {
      householdId,
      amountCents: { lt: 0 },
      isTransfer: false,
      isIncome: false,
      reimbursesTransactionId: null,
      reimbursesMerchant: null,
      refundReviewDismissed: false,
      occurredOn: { gte: since },
      // Same "budget accounts only" scope as everywhere else this queue is
      // surfaced (the /transactions Type filter defaults it on) — without
      // this, a household with several non-budget-tracked cards saw the
      // dashboard card claim "18" while the filtered list it links to
      // showed only the 1 that was actually on a budget-tracked account
      // (real household report, 2026-09-07: household wants this scoped,
      // confirmed explicitly — a refund on a card nobody buckets isn't
      // something this queue should nag about).
      ...budgetTrackedWhere(),
    },
    orderBy: { occurredOn: "desc" },
    select: { id: true, merchant: true, amountCents: true, occurredOn: true, createdAt: true },
  });
  if (credits.length === 0) return [];

  // Two batched queries covering every credit's window, split per credit in
  // memory — this used to run one candidate query per credit, serially, on
  // every dashboard load. Same rules as findRefundPurchaseCandidates /
  // findAmountOnlyRefundCandidates: a generic (P2P/dispute-credit) merchant
  // text never has same-merchant history to search, so it takes the
  // amount-only fallback tryAutoLinkGenericCredit uses at sync time; a
  // credit re-evaluated here (e.g. a second same-amount purchase landed
  // after sync already tried once) is judged by the same rule that will have
  // decided its isIncome/link state.
  const lookbackMs = REFUND_MATCH_LOOKBACK_DAYS * 86_400_000;
  const generic = credits.filter((c) => creditDoesNotIdentifyPayee(c.merchant));
  const byMerchant = credits.filter((c) => !creditDoesNotIdentifyPayee(c.merchant));
  const windowOf = (cs: typeof credits) => ({
    gte: new Date(Math.min(...cs.map((c) => c.occurredOn.getTime())) - lookbackMs),
    lte: new Date(Math.max(...cs.map((c) => c.occurredOn.getTime()))),
  });
  const candidateSelect = { id: true, amountCents: true, occurredOn: true, merchant: true } as const;
  const [merchantRows, amountRows] = await Promise.all([
    byMerchant.length > 0
      ? db.transaction.findMany({
          where: {
            householdId,
            amountCents: { gt: 0 },
            occurredOn: windowOf(byMerchant),
            reimbursedBy: { none: {} },
            OR: [...new Set(byMerchant.map((c) => c.merchant))].map((m) => ({
              merchant: { equals: m, mode: "insensitive" as const },
            })),
          },
          orderBy: { occurredOn: "desc" },
          select: candidateSelect,
        })
      : [],
    generic.length > 0
      ? db.transaction.findMany({
          where: {
            householdId,
            amountCents: { in: [...new Set(generic.map((c) => Math.abs(c.amountCents)))] },
            occurredOn: windowOf(generic),
            reimbursedBy: { none: {} },
          },
          orderBy: { occurredOn: "desc" },
          select: candidateSelect,
        })
      : [],
  ]);

  const out: UnmatchedRefund[] = [];
  for (const credit of credits) {
    const since = credit.occurredOn.getTime() - lookbackMs;
    const inWindow = (r: { occurredOn: Date }) =>
      r.occurredOn.getTime() >= since && r.occurredOn.getTime() <= credit.occurredOn.getTime();
    const isGeneric = creditDoesNotIdentifyPayee(credit.merchant);
    const merchantKey = credit.merchant.toLowerCase();
    const candidates: RefundCandidate[] = (isGeneric ? amountRows : merchantRows)
      .filter((r) =>
        inWindow(r) &&
        (isGeneric ? r.amountCents === Math.abs(credit.amountCents) : r.merchant.toLowerCase() === merchantKey),
      )
      .map(({ id, amountCents, occurredOn }) => ({ id, amountCents, occurredOn }));
    if (candidates.length >= 2) out.push({ ...credit, candidates });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dashboard "Refund Matching" card — same per-calendar-week dismissal as
// isReceiptMatchReviewDismissed/dismissReceiptMatchReview (receipt-sync.ts):
// next week's key won't match, so the card returns on its own if the queue
// is still non-empty.

export async function isRefundMatchReviewDismissed(householdId: string): Promise<boolean> {
  const row = await db.suggestionDismissal.findUnique({
    where: { householdId_kind_key: { householdId, kind: "REFUND_MATCH_REVIEW", key: currentWeekKey() } },
  });
  return Boolean(row);
}

export async function dismissRefundMatchReview(householdId: string): Promise<void> {
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId, kind: "REFUND_MATCH_REVIEW", key: currentWeekKey() } },
    create: { householdId, kind: "REFUND_MATCH_REVIEW", key: currentWeekKey() },
    update: {},
  });
}
