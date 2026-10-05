// Cheap, no-AI first pass over fetched mail: is this even plausibly a
// receipt? Only messages that clear this bar are ever sent to the
// household's AI provider (privacy + cost). Deliberately broad — a
// household connected their whole inbox to catch *all* receipts, so an
// unknown sender still qualifies on content alone; a known receipt sender
// just skips straight through.

const RECEIPT_SENDER_HINTS = [
  "venmo.com",
  "paypal.",
  "@paypal",
  "amazon.com",
  "squareup.com",
  "cash.app",
  "block.xyz",
  "stripe.com",
  "intuit.com",
  "receipts@",
  "receipt@",
  "orders@",
  "order-update",
  "no-reply@",
  "noreply@",
  "invoice",
];

const RECEIPT_PHRASES = [
  "order confirmation",
  "your order",
  "thanks for your order",
  "thank you for your order",
  "your receipt",
  "receipt from",
  "your purchase",
  "payment to",
  "you paid",
  "payment sent",
  "payment received",
  "sent you",
  "requests $",
  "invoice",
  "order #",
  "order number",
  "subtotal",
  "order total",
  "amount charged",
  "total charged",
];

// A money amount anywhere in the text: "$12.99", "USD 12.99", "12.99 USD",
// or a bare "1,234.56" next to a total-ish word (handled by the phrase list
// above, so a plain decimal is enough here).
const MONEY_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?)|(?:\b(?:usd|eur|gbp|cad|aud)\s?\d[\d,]*\.\d{2})|(?:\b\d[\d,]*\.\d{2}\s?(?:usd|eur|gbp|cad|aud)\b)|(?:\b\d[\d,]*\.\d{2}\b)/i;

// Venmo emails far more than the household's own bank-funded payments: a
// Venmo Debit Card swipe (every kid's teen-card purchase included), money
// landing in someone's Venmo balance, a balance-funded "Pay with Venmo"
// checkout, a cash-out transfer to the bank, a bare pre-charge
// authorization. None of those ever post to the household's bank feed as a
// "Venmo" line, so there's nothing to match and nothing to budget — they'd
// just pile up unmatched forever. Only a payment/purchase funded from a
// linked bank/card account is worth keeping. (Household ask, 2026-08-29 —
// the inbox was full of the kids' Venmo card notifications.)
const VENMO_DROP_SUBJECT = [
  /purchase with (?:their|your|his|her) debit card/i, // "<Name> made a $X purchase with their debit card"
  /transfer (?:has been |was )?initiated/i, // cash-out to a bank account
  /authorized .+ to charge/i, // pre-charge authorization notice
  /\brequests?\s+\$/i, // a payment request / reminder — not a completed payment
];

export function isIgnorableVenmoNotification(msg: { subject: string; from: string; text: string }): boolean {
  if (!/venmo/i.test(msg.from)) return false;
  if (VENMO_DROP_SUBJECT.some((re) => re.test(msg.subject))) return true;

  const body = msg.text.toLowerCase();
  if (/payment method[\s:]*[^\n]{0,40}venmo debit card/.test(body)) return true;

  // "<Person> received a payment" — you get these as the manager of a
  // family/teen account. When the body names a "<Sender> paid <Person>"
  // transfer it IS a receipt: a household member funding one from a linked
  // account posts to the bank feed as "Transfer to Venmo", and the match
  // step retires it on its own if no bank charge ever shows up (item,
  // 2026-08-29 — the counterparty for these is the name AFTER "paid", not
  // the sender). Only a bare balance credit with no named payer is noise.
  if (/received a payment/i.test(msg.subject) && !/\bpaid\b/i.test(body)) return true;

  // Funded from the Venmo balance rather than a linked bank/card — the money
  // never touches the household's bank feed. Only when no bank funding line
  // is present (a split-funded payment naming a real account is kept).
  const bankFunded = /checking|savings|credit union|account ending in \d|card ending in \d|·{2,}\s*\d{4}/.test(body);
  if (!bankFunded && /venmo balance\s*\$\s*[1-9]/.test(body)) return true;

  return false;
}

export function looksLikeReceipt(msg: { subject: string; from: string; text: string }): boolean {
  if (isIgnorableVenmoNotification(msg)) return false;

  const haystack = `${msg.subject}\n${msg.text}`.toLowerCase();
  if (!MONEY_RE.test(haystack)) return false;

  const from = msg.from.toLowerCase();
  const senderHit = RECEIPT_SENDER_HINTS.some((h) => from.includes(h));
  const phraseHit = RECEIPT_PHRASES.some((p) => haystack.includes(p));

  // A recognizable receipt sender + any money is enough; an unknown sender
  // needs both a money amount and a receipt-shaped phrase.
  return senderHit || phraseHit;
}

// Deliberately a separate phrase list from RECEIPT_PHRASES, not folded in —
// a bill notice ("your bill is ready", "amount due") is shaped nothing like
// a completed-purchase receipt, and loosening RECEIPT_PHRASES to also catch
// these would loosen what the receipt pipeline itself treats as
// receipt-shaped. No sender-hint bypass either (unlike looksLikeReceipt):
// there's no equivalent of a known checkout/payment-processor domain list
// for arbitrary utility/card billers, so every candidate needs both a money
// amount and a bill-shaped phrase.
const BILL_NOTICE_PHRASES = [
  "amount due",
  "payment due",
  "minimum payment due",
  "minimum due",
  "your bill is ready",
  "bill is ready",
  "statement is ready",
  "balance due",
  "auto pay",
  "autopay",
  "your next payment",
  "payment reminder",
  "new statement",
];

export function looksLikeBillNotice(msg: { subject: string; from: string; text: string }): boolean {
  const haystack = `${msg.subject}\n${msg.text}`.toLowerCase();
  if (!MONEY_RE.test(haystack)) return false;
  return BILL_NOTICE_PHRASES.some((p) => haystack.includes(p));
}
