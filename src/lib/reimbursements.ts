import { db } from "@/lib/db";
import { isP2PMerchant } from "@/lib/p2p-keywords";
import { DAY_MS } from "@/lib/date";


// A generic bank/card-network dispute-resolution credit never identifies the
// real merchant it's paying back, the same shape of ambiguity P2P credit
// text has (see P2P_DISCOVERY_KEYWORDS) — its own merchant field is a
// processor artifact ("Visa Chargeback Adjustment"), not the store the
// original purchase was actually made at. Real household report, 2026-09-27:
// exactly that credit got zero suggestions — no purchase is ever literally
// named "Visa Chargeback Adjustment", so the same-merchant tier below always
// comes up empty for it, and it wasn't eligible for the amount-tolerance
// fallback tier either since it isn't a P2P credit.
const GENERIC_CREDIT_KEYWORDS = ["chargeback", "dispute", "provisional credit"];

// A credit whose own merchant text is either a P2P app or a generic bank
// artifact never identifies who it's really paying back — see
// GENERIC_CREDIT_KEYWORDS above. Pulled out as its own pure function (rather
// than left inline in getReimbursementSuggestions) so this gate has a direct
// unit test, the same reasoning that already pulled isP2PReceipt/
// receiptChargeScopeWhere out of receipt-match.ts.
export function creditDoesNotIdentifyPayee(merchant: string): boolean {
  const m = merchant.trim().toLowerCase();
  return isP2PMerchant(m) || GENERIC_CREDIT_KEYWORDS.some((k) => m.includes(k));
}

// Split-credit offsets (see TransactionOffset) — total cents carved off each
// credit id passed in. One grouped query; ids with no offsets are simply
// absent from the map (caller treats missing as 0).
export async function offsetSumByCreditId(creditIds: string[]): Promise<Map<string, number>> {
  if (creditIds.length === 0) return new Map();
  const rows = await db.transactionOffset.groupBy({
    by: ["creditTransactionId"],
    where: { creditTransactionId: { in: creditIds } },
    _sum: { amountCents: true },
  });
  return new Map(rows.map((r) => [r.creditTransactionId, r._sum.amountCents ?? 0]));
}

// What a credit still contributes as income once its offsets are carved off.
// `absAmountCents` is Math.abs(transaction.amountCents) (money-in is stored
// negative); floored at 0 in case offsets somehow over-allocate.
export function countedIncomeCents(absAmountCents: number, offsetSum: number): number {
  return Math.max(0, absAmountCents - offsetSum);
}

// A reimbursement can trail the bill it's paying back by weeks, not just
// days — "mom Venmos me back next payday" is normal, not an edge case — so
// this has to look back far enough to find last cycle's payment even when
// this cycle's already posted and sitting closer in time. Matches
// SUGGESTION_WINDOW_DAYS below so the auto-linker and the manual-link
// suggestions agree on how stale a match can be.
const REIMBURSEMENT_LOOKBACK_DAYS = 45;
// Forward-dated matches get only a small grace window, not a symmetric one —
// a reimbursement can land a day or two before the bill itself posts (paid
// mom back before the debit hit the bank), but "closest in time" must never
// let a future payment outrank a real past one just because it happens to
// be a day away instead of a month away.
const REIMBURSEMENT_LOOKAHEAD_DAYS = 3;

// Suggestion-only (manual link flow) — looser than the auto-link window
// above since a human is confirming the pick, not the app committing to it
// unsupervised. $3 tolerance absorbs a return's shipping/restocking
// adjustment; 45 days covers a slow refund.
const SUGGESTION_WINDOW_DAYS = 45;
const SUGGESTION_TOLERANCE_CENTS = 300;

export type ReimbursementCandidate = {
  id: string;
  merchant: string;
  amountCents: number;
  occurredOn: string; // ISO date
  // Set when this debit is itself a tracked bill payment — lets the manual
  // Link flow's suggestions double as a hint for the "define a recurring
  // reimbursement pattern" flow (PatternFields' billId dropdown): if the
  // same-amount debit Link would suggest is a bill payment, that's the bill
  // a pattern should default to reimbursing too.
  billId?: string | null;
  billName?: string | null;
  // Set when this debit is a tracked debt payment — for the split-offset
  // flow (searchOffsetTargets), where a loan payoff is the usual target and
  // its checking-side leg may not exist (some servicers only post the
  // balance-reducing credit on the loan's own feed, amountCents < 0). The
  // linker shows this instead of the raw merchant text.
  debtName?: string | null;
};

// Runs right after matchBillPayments each sync (see simplefin-sync.ts) and
// after a pattern's billId is set/changed (see transactions/actions.ts) — only
// ever touches a RecurringPattern the household explicitly marked as a
// reimbursement (countsAsIncome:false) AND explicitly pinned to a specific
// bill. Never looks at an unpinned reimbursement pattern or a plain
// unlabeled P2P credit — those stay manual (see linkReimbursement,
// src/app/transactions/actions.ts) specifically so this can never misfire
// onto a genuine one-off gift or a side-income Venmo credit.
export async function matchReimbursements(householdId: string): Promise<void> {
  const patterns = await db.recurringPattern.findMany({
    where: { householdId, active: true, direction: "CREDIT", countsAsIncome: false, billId: { not: null } },
    select: {
      id: true,
      billId: true,
      channelKeyword: true,
      amountMaxCents: true,
      bill: { select: { bucketId: true, name: true, merchant: true, amountCents: true } },
    },
  });
  if (patterns.length === 0) return;

  const billIdByPatternId = new Map(patterns.map((p) => [p.id, p.billId!]));
  // Nets an auto-matched reimbursement against the bill's own bucket, same
  // reasoning as linkReimbursement's manual inheritance (see
  // src/app/transactions/actions.ts) — a Venmo-repaid bill shouldn't count
  // twice against the household's spend.
  const bucketIdByBillId = new Map(patterns.map((p) => [p.billId!, p.bill?.bucketId ?? null]));

  // --- Phase 1: pattern-matched credits ----------------------------------
  // Every credit the sync-time matcher already tagged with one of these
  // pinned patterns (amount in band + channel keyword) — link it to the
  // cycle it pays back.
  const candidates = await db.transaction.findMany({
    where: { householdId, patternId: { in: patterns.map((p) => p.id) }, reimbursesTransactionId: null },
    select: { id: true, patternId: true, occurredOn: true },
  });
  for (const t of candidates) {
    const billId = billIdByPatternId.get(t.patternId!);
    if (!billId) continue;
    await linkToClosestBillPayment(householdId, billId, bucketIdByBillId.get(billId) ?? null, t.id, t.occurredOn);
  }

  // --- Phase 2: email-corroborated widening -----------------------------
  // Only meaningful once a household has connected a mailbox. A Venmo/Zelle
  // "you got paid" email, parsed into a Receipt and linked to the credit
  // (matchReceipts, runs earlier in the sync), leaves its memo on
  // Transaction.receiptNote. When that memo names the bill, trust it enough
  // to link a repayment whose amount fell outside the pattern's configured
  // band — the one case Phase 1 structurally can't see, since no patternId
  // ever got set (matchRecurringPattern's amount gate).
  const hasEmail = (await db.emailConnection.count({ where: { householdId } })) > 0;
  if (!hasEmail) return;

  for (const p of patterns) {
    if (!p.bill) continue;
    const tokens = billMemoTokens(p.bill.name, p.bill.merchant);
    if (tokens.length === 0) continue;
    // A widened match can miss the band, but not by a wild margin — a memo
    // that says "Verizon" on a $5 credit is noise, not this month's share.
    const amountCeilingCents = Math.max(p.amountMaxCents * 2, Math.round(p.bill.amountCents * 1.2));

    const widened = await db.transaction.findMany({
      where: {
        householdId,
        amountCents: { lt: 0, gte: -amountCeilingCents },
        reimbursesTransactionId: null,
        reimbursesMerchant: null,
        patternId: null,
        receiptNote: { not: null },
        // Still a P2P credit on this pattern's own channel — never widen
        // onto an unrelated deposit just because a memo mentions the payee.
        OR: [
          { merchant: { contains: p.channelKeyword, mode: "insensitive" } },
          { rawDescription: { contains: p.channelKeyword, mode: "insensitive" } },
          { receiptPaidWith: { contains: p.channelKeyword, mode: "insensitive" } },
        ],
      },
      select: { id: true, occurredOn: true, receiptNote: true },
    });

    for (const t of widened) {
      const memo = t.receiptNote!.toLowerCase();
      if (!tokens.some((tok) => memo.includes(tok))) continue;
      await linkToClosestBillPayment(
        householdId,
        p.billId!,
        bucketIdByBillId.get(p.billId!) ?? null,
        t.id,
        t.occurredOn,
        // Unlike a Phase 1 credit, this one was never routed by a pattern —
        // it may still carry the isIncome:true P2P default. Clear it, same
        // as the manual linkReimbursement does.
        { clearIncome: true },
      );
    }
  }
}

// Bill name/merchant tokens that, appearing in a P2P credit's receipt memo,
// confirm the credit is repaying THAT bill. Short/generic words dropped so
// "Auto Pay" or "Monthly" alone can never trigger a match.
function billMemoTokens(name: string, merchant: string | null): string[] {
  const STOP = new Set([
    "the", "and", "for", "bill", "pay", "payment", "monthly", "auto", "inc", "llc", "corp",
    "company", "services", "service", "utility", "utilities", "account", "autopay",
  ]);
  return [...new Set(
    `${name} ${merchant ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  )];
}

// Finds the bill payment a reimbursement credit pays back and links them.
// Shared by both phases so an email-widened match lands on the exact same
// cycle logic as a pattern-matched one.
async function linkToClosestBillPayment(
  householdId: string,
  billId: string,
  bucketId: string | null,
  creditId: string,
  creditOccurredOn: Date,
  opts: { clearIncome?: boolean } = {},
): Promise<void> {
  // Every payment this bill has ever had within the window — not just its
  // current lastPaidDate — so a reimbursement lagging behind the cycle it's
  // actually covering still finds the right one instead of whatever posted
  // most recently.
  const billPayments = await db.transaction.findMany({
    where: {
      householdId,
      billId,
      occurredOn: {
        gte: new Date(creditOccurredOn.getTime() - REIMBURSEMENT_LOOKBACK_DAYS * DAY_MS),
        lte: new Date(creditOccurredOn.getTime() + REIMBURSEMENT_LOOKAHEAD_DAYS * DAY_MS),
      },
    },
    select: { id: true, occurredOn: true },
  });
  if (billPayments.length === 0) return;

  // A reimbursement pays back something that already happened, so a past
  // payment always wins over a future one regardless of which is closer in
  // time — only fall back to a forward-dated payment (within the small
  // lookahead grace above) when there's no past payment to match at all.
  const past = billPayments.filter((p) => p.occurredOn.getTime() <= creditOccurredOn.getTime());
  const pool = past.length > 0 ? past : billPayments;

  const closest = pool.reduce((best, p) =>
    Math.abs(p.occurredOn.getTime() - creditOccurredOn.getTime()) <
    Math.abs(best.occurredOn.getTime() - creditOccurredOn.getTime())
      ? p
      : best,
  );

  await db.transaction.update({
    where: { id: creditId },
    data: {
      reimbursesTransactionId: closest.id,
      ...(bucketId ? { bucketId } : {}),
      ...(opts.clearIncome ? { isIncome: false, oneOff: true } : {}),
    },
  });
}

// Suggestions for the manual link UI (ReimbursementLinker) — one batched
// query for every candidate credit passed in, rather than one query per row.
// Keyed by credit transaction id, same-merchant matches first, then
// amount-tolerance matches.
export async function getReimbursementSuggestions(
  householdId: string,
  creditTxns: { id: string; merchant: string; amountCents: number; occurredOn: Date; accountId: string | null }[],
): Promise<Record<string, ReimbursementCandidate[]>> {
  if (creditTxns.length === 0) return {};

  // Bounded by the actual suggestion window, not an arbitrary row count — a
  // flat `take` here (an earlier version used 500) silently drops a
  // genuinely-matching purchase the moment the household has more than that
  // many OTHER debits anywhere in the date range, regardless of merchant
  // (real household report, 2026-09-05: two same-merchant June purchases,
  // both well within window and amount, missing from a July credit's
  // suggestions purely because ~1,100 unrelated debits posted more recently
  // household-wide). A purchase can never postdate the refund that pays it
  // back, so the newest relevant debit is the latest credit being resolved,
  // not "now".
  const earliestRelevant = new Date(
    Math.min(...creditTxns.map((t) => t.occurredOn.getTime())) - SUGGESTION_WINDOW_DAYS * DAY_MS,
  );
  const latestRelevant = new Date(Math.max(...creditTxns.map((t) => t.occurredOn.getTime())));
  const debits = await db.transaction.findMany({
    where: {
      householdId,
      amountCents: { gt: 0 },
      occurredOn: { gte: earliestRelevant, lte: latestRelevant },
      // A purchase already claimed by a different refund isn't offered
      // again — same rule findRefundPurchaseCandidates (refund-match.ts) uses.
      reimbursedBy: { none: {} },
    },
    orderBy: { occurredOn: "desc" },
    select: {
      id: true,
      merchant: true,
      amountCents: true,
      occurredOn: true,
      accountId: true,
      billId: true,
      bill: { select: { name: true } },
    },
  });

  const result: Record<string, ReimbursementCandidate[]> = {};
  for (const t of creditTxns) {
    const amount = Math.abs(t.amountCents);
    const creditMerchant = t.merchant.trim().toLowerCase();
    // One-directional: a purchase has to have happened *before* the refund
    // that pays it back, never after (real household report, 2026-09-05,
    // caught a same-merchant purchase 3 days after the credit showing up as
    // a suggestion — an abs() diff here can't tell "before" from "after").
    const withinWindow = (d: (typeof debits)[number]) => {
      const daysBefore = (t.occurredOn.getTime() - d.occurredOn.getTime()) / DAY_MS;
      return daysBefore >= 0 && daysBefore <= SUGGESTION_WINDOW_DAYS;
    };

    // A return/reimbursement can never exceed what was originally charged —
    // a $55.81 refund was never a purchase of $8, full stop — so neither
    // tier below ever suggests a debit smaller than the credit itself,
    // regardless of merchant or date closeness.
    const atLeastRefundAmount = (d: (typeof debits)[number]) => d.amountCents >= amount;

    // Same-merchant purchases are a far stronger signal than amount
    // closeness — a return rarely refunds the exact charged amount
    // (restocking fees, partial returns, a price that's since changed) —
    // so these skip the tight amount tolerance below entirely and are just
    // ranked by how close the amount happens to be (which, now that
    // everything here is >= the refund, means the smallest qualifying
    // purchase ranks first — the most likely exact match). Only meaningful
    // when the credit's own merchant text actually identifies who it's
    // paying back, which is never true for a P2P credit ("Venmo") — that's
    // what the amount-tolerance tier below still exists to catch. Same
    // account as the credit, too — a refund can only land back on whatever
    // card/account the original purchase was actually made on, never a
    // *different* account the household also happens to shop that merchant
    // from (real household report, 2026-09-06: a credit refund on a Sam's
    // Club store card was suggesting Sam's Club purchases made on plain
    // checking — different payment method, could never be what this refund
    // pays back). Not applied to the amount-tolerance tier below: that one
    // exists specifically for a P2P credit whose own merchant text ("Venmo")
    // doesn't identify the real payee at all, where the debit it repays is
    // routinely on a different account by design (a friend paying you back
    // for a shared purchase you put on one specific card).
    const sameMerchant = debits
      .filter(
        (d) =>
          d.merchant.trim().toLowerCase() === creditMerchant &&
          d.accountId === t.accountId &&
          atLeastRefundAmount(d) &&
          withinWindow(d),
      )
      .sort((a, b) => a.amountCents - b.amountCents);

    // The amount-tolerance tier is only meaningful for a credit whose own
    // merchant text never identifies who it's really paying back — a P2P
    // credit ("Venmo", "Zelle") or a generic bank dispute-resolution credit
    // ("Visa Chargeback Adjustment," see GENERIC_CREDIT_KEYWORDS) alike — see
    // the comment above. It wasn't actually gated on that at all, so a
    // genuine merchant refund (Google One) was matching any other unrelated
    // purchase of the exact same amount regardless of who it was from (real
    // household report, 2026-09-06: a $9.64 Google One credit suggested
    // Amazon and Netflix purchases that just happened to also cost $9.64). A
    // credit whose merchant text *does* identify a real payee only ever gets
    // same-merchant suggestions now, even if that leaves fewer than 5 (or
    // zero).
    const doesNotIdentifyPayee = creditDoesNotIdentifyPayee(creditMerchant);
    const sameMerchantIds = new Set(sameMerchant.map((d) => d.id));
    const amountMatches = doesNotIdentifyPayee
      ? debits
          .filter(
            (d) =>
              !sameMerchantIds.has(d.id) &&
              atLeastRefundAmount(d) &&
              d.amountCents - amount <= SUGGESTION_TOLERANCE_CENTS &&
              withinWindow(d),
          )
          .sort((a, b) => a.amountCents - b.amountCents)
      : [];

    result[t.id] = [...sameMerchant, ...amountMatches].slice(0, 5).map((d) => ({
      id: d.id,
      merchant: d.merchant,
      amountCents: d.amountCents,
      occurredOn: d.occurredOn.toISOString().slice(0, 10),
      billId: d.billId,
      billName: d.bill?.name ?? null,
    }));
  }
  return result;
}
