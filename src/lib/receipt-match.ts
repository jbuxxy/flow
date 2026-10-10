// Shared "which charge could this receipt belong to" gating, used by all
// three receipt→transaction match paths so they never disagree:
//   - matchReceipts        (automatic linking, src/lib/receipt-sync.ts)
//   - the /settings/email   manual picker (src/app/settings/email/page.tsx)
//   - buildReceiptSuggestions (the inline "Attach receipt?" prompt,
//     src/app/transactions/page.tsx)
//
// Before this, all three matched on amount + a date window alone, which
// surfaced nonsense candidates: a $20 Venmo receipt offering an unrelated
// real merchant that happened to cost $20 that week, a $10 "Google Cloud"
// receipt offering a $10 car wash. The rules here:
//   1. A P2P receipt (Venmo/PayPal/etc. payment) only ever matches a charge
//      whose merchant text reads as a P2P app; a non-P2P receipt never does.
//   2. For a non-P2P receipt, the charge's merchant / raw descriptor also
//      has to actually resemble the receipt's party.

import type { Prisma } from "@prisma/client";
import { P2P_DISCOVERY_KEYWORDS, p2pMerchantMatch } from "@/lib/p2p-keywords";
import { nameSimilarity } from "@/lib/fuzzy-match";

export type ReceiptMatchShape = {
  kind: string;
  party: string | null;
  partyIsPerson: boolean;
  p2pApp: string | null;
  // A merchant refund confirmation (Receipt.isRefund) — always a credit.
  isRefund?: boolean;
};

// The real, actionable signal that a receipt is a peer-app payment: the AI
// is asked to name the app ("p2pApp") for every genuine P2P notification and
// to say whether the other side is a person, so either one being set is
// trustworthy. `kind` alone is NOT — PAYMENT_SENT/PAYMENT_RECEIVED both read
// naturally for plenty of non-P2P business notices too ("your payment to
// Affirm was processed", "you received a Capital One rewards credit"), and
// trusting kind alone scoped those to Venmo/PayPal/Zelle-looking merchant
// text, so the real (correctly budget-tracked) charge/credit never entered
// the candidate pool at all — two real incidents, both 2026-09-04: an
// Affirm installment payment that had already posted, and a Capital One
// rewards credit whose own noteText literally said "Rewards credit."
const isPeerPayment = (r: ReceiptMatchShape): boolean => r.partyIsPerson || r.p2pApp != null;

export function isP2PReceipt(r: ReceiptMatchShape): boolean {
  return isPeerPayment(r);
}

const p2pMerchantOr = (): Prisma.TransactionWhereInput[] => p2pMerchantMatch().OR;

// Coarse DB-side gate for the amount/date candidate query — a P2P receipt is
// scoped to P2P-looking charges, everything else is scoped away from them.
//
// Exception: "paypal" (and any future dual-use keyword) is also a legitimate
// non-P2P business channel — a PayPal Credit installment payment posts on
// the bank side as a plain "PayPal" debit, indistinguishable from a peer
// transfer through the same app (see P2P_DISCOVERY_KEYWORDS' own doc
// comment). A non-P2P receipt whose own party names that same channel
// ("PayPal Credit") still needs to match a "PayPal"-merchant charge, so only
// an *unrelated* P2P keyword (a Netflix receipt offering a Venmo charge)
// stays excluded — real incident, 2026-09-25: a PayPal Credit payment
// receipt never matched its own posted "PayPal" transaction because the
// blanket exclusion below scoped every "PayPal"-merchant charge away from
// any receipt that hadn't been flagged partyIsPerson/p2pApp.
export function receiptChargeScopeWhere(r: ReceiptMatchShape): Prisma.TransactionWhereInput {
  if (isP2PReceipt(r)) return { OR: p2pMerchantOr() };
  const party = (r.party ?? "").toLowerCase();
  const excluded = P2P_DISCOVERY_KEYWORDS.filter((k) => !party.includes(k));
  return { NOT: { OR: excluded.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })) } };
}

// Direction gate. `amountCents > 0` is money out (a debit) in this app's
// sign convention, `< 0` is money in.
//
// Almost every receipt in this pipeline is for something the household
// BOUGHT — an order, a subscription, a shipment, a payment sent, a bare
// OTHER confirmation — so the default is debit-only. Offering a same-amount
// *credit* (a refund/return) as a candidate for a purchase receipt is pure
// noise: a $9.64 "Google Play — Google AI Plus" purchase receipt kept being
// offered the $9.64 Google refund, and every purchase receipt turned its
// week's same-amount return into a phantom AMBIGUOUS candidate
// (2026-08-30 / 2026-08-31).
//
// The ONE receipt that matches a credit is a genuine "you received money"
// notice from a real person / named P2P app (PAYMENT_RECEIVED + peer, see
// isPeerPayment above). A PAYMENT_RECEIVED the AI tagged for a *business* is
// either a misclassified order confirmation or an actual merchant refund/
// credit — either sign is possible there, so that case alone stays
// two-sided.
// PAYMENT_SENT is two-sided for the same reason a non-peer PAYMENT_RECEIVED
// is: a payment to a credit card / loan / BNPL issuer doesn't reliably post
// as a plain debit on the household's own checking account. SimpleFIN often
// exposes it instead on the debt's OWN liability account, as a *negative*
// credit that lowers the balance owed (see filterDebtPaymentTwins,
// src/lib/debt-payments.ts, for the same convention on the bank-sync side) —
// real incident, 2026-09-11: a Chase "we received your payment" receipt for
// an Amazon Card payment that posted exactly this way (amountCents -3500)
// never entered the candidate pool at all under the old debit-only rule,
// so a receipt the AI classified perfectly correctly still never linked.
// Not a refund-noise risk the way loosening a purchase receipt's sign would
// be (see the comment above) — a card/loan payment doesn't get "refunded"
// the way an order does, so a same-amount credit here is far more likely to
// be exactly this pattern than an unrelated decoy.
export function receiptAmountWhere(r: ReceiptMatchShape, totalCents: number): Prisma.TransactionWhereInput {
  // A refund is money coming back — only ever the credit (2026-10-04).
  if (r.isRefund) return { amountCents: -totalCents };
  if (r.kind === "PAYMENT_RECEIVED" && isPeerPayment(r)) return { amountCents: -totalCents };
  if (r.kind === "PAYMENT_RECEIVED" || r.kind === "PAYMENT_SENT") {
    return { OR: [{ amountCents: totalCents }, { amountCents: -totalCents }] };
  }
  return { amountCents: totalCents };
}

// In-memory counterpart of receiptAmountWhere's sign rule, for the
// suggestion path (buildReceiptSuggestions) which matches against already-
// loaded transactions rather than a DB query.
export function receiptSignMatches(r: ReceiptMatchShape, amountCents: number): boolean {
  if (r.isRefund) return amountCents < 0;
  if (r.kind === "PAYMENT_RECEIVED" && isPeerPayment(r)) return amountCents < 0;
  if (r.kind === "PAYMENT_RECEIVED" || r.kind === "PAYMENT_SENT") return true;
  return amountCents > 0;
}

// Date window for candidate charges. A receipt email arrives the day you
// pay; the matching bank charge posts that same day or LATER (usually a day
// or two, a mailed check a week or more). A bank transaction dated well
// before the receipt is therefore never the real match — offering it only
// invents false ambiguity (an unrelated same-amount charge from the week
// before turns a clean auto-link into an AMBIGUOUS "no matching charge
// yet", and clutters the manual picker — e.g. a $20 Venmo receipt offering
// five earlier "Transfer to Venmo" rows). So the window is asymmetric: a
// small `before` slack — the receipt's own `occurredOn` can sit a day or
// two ahead of the bank's date when the email body stated no date and we
// fell back to the arrival date (item 5, 2026-08-29) — and the full reach
// `after`. (2026-08-30.)
export const RECEIPT_MATCH_BEFORE_DAYS = 2;
export const RECEIPT_MATCH_AFTER_DAYS = 4;
// A mailed check / scheduled bill-pay clears a week+ after its receipt
// email; the distinctive-amount fallback in matchOneReceipt uses this reach.
export const RECEIPT_WIDE_MATCH_AFTER_DAYS = 14;

export function receiptMatchWindow(
  anchor: Date,
  afterDays: number = RECEIPT_MATCH_AFTER_DAYS,
): { from: Date; to: Date } {
  const from = new Date(anchor);
  from.setUTCDate(from.getUTCDate() - RECEIPT_MATCH_BEFORE_DAYS);
  const to = new Date(anchor);
  to.setUTCDate(to.getUTCDate() + afterDays);
  return { from, to };
}

export const aliasKey = (s: string): string => s.trim().toLowerCase();

// Fine JS-side gate applied after the amount/date query. A P2P receipt (memo
// is the only real signal, payee names rarely echo the bank text) and a
// receipt with no known party both pass on amount+date alone; a non-P2P
// receipt with a party has to look like that party — or match a learned
// ReceiptMerchantAlias (`aliasMerchants`, lowercased bank-merchant strings
// the household has manually linked this party to before).
export function plausibleReceiptCharge(
  r: ReceiptMatchShape,
  txn: { merchant: string; rawDescription: string | null },
  aliasMerchants?: ReadonlySet<string>,
): boolean {
  if (isP2PReceipt(r) || !r.party) return true;
  if (aliasMerchants?.has(aliasKey(txn.merchant))) return true;
  if (nameSimilarity(r.party, txn.merchant) >= 0.5) return true;
  const hay = `${txn.merchant} ${txn.rawDescription ?? ""}`.toLowerCase();
  return r.party
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
    .some((w) => hay.includes(w));
}

// Does a refund receipt's returned-item list overlap the original purchase's
// receipt? Tax / shipping / fee / discount lines are ignored on both sides —
// they'd "match" every order. An item matches on normalized-equal text or
// close name similarity ("Serveware" vs "SERVEWARE"). This is the evidence
// that ties a partial refund back to the one order it came from when the
// amounts can't (a $16.13 return off a $209.35 order — 2026-10-04).
const NON_ITEM_LINE = /^(tax|sales tax|shipping|delivery|fee|service fee|tip|discount|savings|subtotal|total)\b/i;

export function refundItemsMatch(
  refundItems: { description: string }[],
  purchaseItems: { description: string }[],
): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const items = (list: { description: string }[]) =>
    list.map((i) => i.description).filter((d) => d && !NON_ITEM_LINE.test(d.trim()));
  const purchased = items(purchaseItems);
  return items(refundItems).some((r) =>
    purchased.some((p) => norm(p) === norm(r) || nameSimilarity(p, r) >= 0.8),
  );
}
