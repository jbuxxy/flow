// Split out from simplefin-sync.ts (which imports `db`) so a client
// component — the All Transactions reclassify dropdown
// (src/app/transactions/transaction-row.tsx), deciding whether "Debt
// payment" even belongs as an option for a given transaction — can reuse
// the same heuristic without pulling a server-only module into the client
// bundle. Same reasoning as p2p-keywords.ts's split from p2p-transfers.ts.
//
// A checking-side "Transfer to Loan" or "Capital One Credit Card Payment"
// line is the only kind of debit that's ever actually a debt payment — an
// ordinary purchase (Wingstop, gas, groceries) never is, regardless of
// amount. Conservative on purpose: some false negatives are fine (a real
// payment with unusual merchant text still has the manual debt-id override
// in TrackAsBillForm/reclassify), but a false positive here means "Debt
// payment" showing up as a nonsensical option on every retail purchase.
//
// The `^transfer\b` branch only fires alongside a loan-context word for the
// same reason — bank transfer wording is otherwise unconstrained ("Transfer
// to Money Market", "Transfer from Venmo"), so a bare `^transfer\b` matched
// every unresolved internal transfer whose destination merely started with
// the word "Transfer", not just an actual "Transfer to Loan" line. Real
// report, 2026-09-09: a Money Market transfer and a Venmo reimbursement both
// showed up under "Possible Debt Payment" this way. Same word list as
// LOAN_TRANSFER_TEXT_PATTERN (simplefin-sync.ts) for consistency — a
// household's own tracked-debt name (e.g. "Transfer to Capital One") is
// still caught separately by debtNameMatchesMerchant below.
export const CARD_PAYMENT_MERCHANT_PATTERN = /payment|autopay|credit card|^transfer\b.*\b(loan|mortgage|principal)\b/i;

// A stronger, narrower signal than CARD_PAYMENT_MERCHANT_PATTERN, meant for
// Transaction.rawDescription (the untouched bank line) rather than the cleaned
// merchant. SimpleFIN's `payee` normalisation routinely strips a co-branded
// card payment down to just the store name ("Sam's Club"), but the raw ACH
// descriptor keeps the tell: "AUTOMATIC WITHDRAWAL, SAMSCLUB MSTRCRD SYF
// PAYMNT WEB". Requires BOTH a payment token (incl. the banking abbreviations
// "PAYMNT"/"PYMNT"/"PYMT"/"PMT" that the merchant regex's bare /payment/
// misses) AND a card/loan context token in the same string — the conjunction
// is what keeps an ordinary "AUTOMATIC WITHDRAWAL ... PYMT" utility autopay
// from matching, and what a real debit-card purchase at the same store
// ("SAMSCLUB #6304", "POS PURCHASE ...") never satisfies. rawDescription can
// be null (rows synced before the column existed) — callers fall back to the
// merchant pattern / an offsetting card-side leg.
const CARD_PAYMENT_DESCRIPTOR_TOKEN = /\b(payment|paymnt|pymnt|pymt|pmt|autopay|e-?pay)\b/i;
const CARD_PAYMENT_CONTEXT_TOKEN = /\b(card|crd|mstrcrd|mastercard|visa|discover|amex|cc|loan|mortgage)\b/i;

export function isCardPaymentDescriptor(rawDescription: string | null | undefined): boolean {
  if (!rawDescription) return false;
  return CARD_PAYMENT_DESCRIPTOR_TOKEN.test(rawDescription) && CARD_PAYMENT_CONTEXT_TOKEN.test(rawDescription);
}

// The same pattern above, decomposed for a Prisma `contains`/`startsWith`
// where-clause (transactions/page.tsx's status filter) instead of a JS
// regex test — kept as a separate export right next to the regex, not
// re-derived, so the two can't silently drift apart.
export const CARD_PAYMENT_MERCHANT_CONTAINS_TERMS = ["payment", "autopay", "credit card"];

// The loan-context word list the regex's `^transfer\b.*\b(loan|mortgage|
// principal)\b` branch requires — see looksLikeDebtPaymentWhere,
// transactions/page.tsx, which ANDs this against `startsWith("transfer")`
// since Prisma has no regex/lookahead equivalent.
export const LOAN_TRANSFER_CONTAINS_TERMS = ["loan", "mortgage", "principal"];

// A payment descriptor the card issuer generates that names the issuer (or
// nothing) but never the specific card — "Capital One Credit Card Payment",
// "CAPITAL ONE CRCARDPMT WEB", "CARDMEMBER SERV WEB PYMT", "Chase Card
// Payment". A household with more than one card at the same issuer gets a
// byte-identical string for every one of them — and for a spouse's card
// that isn't even tracked here — so one of these must never seed a
// household-wide debt MerchantRule (real incident, 2026-09-01: a USER rule
// off one "Capital One Credit Card Payment" silently routed the other Capital
// One card's payments, and an untracked card's payments, onto the Venture
// debt). Attribute these one transaction at a time instead — a unique
// minimum-payment fingerprint, or the offsetting credit leg on a specific
// card's own synced feed — exactly the way P2P merchant text is handled
// (see P2P_DISCOVERY_KEYWORDS). Client-safe so reassignTransaction
// (src/app/buckets/actions.ts) and the sync categorizer can share it.
export function isGenericCardPaymentDescriptor(merchant: string): boolean {
  const m = merchant.toLowerCase();
  return (
    /credit\s*card/.test(m) || // "Capital One Credit Card [Payment]"
    /\bcr\s*card\s*pmt\b/.test(m) || // "CAPITAL ONE CRCARDPMT"
    /card\s*member\s*serv/.test(m) || // "CARDMEMBER SERV WEB PYMT" (Chase)
    /\bcard\b.{0,12}\b(payment|pymt|pmt|epay|e-pay)\b/.test(m) // "… Card Payment", "Card ePay"
  );
}

// The actual override path the comment above assumes exists: some issuers
// report a checking-side autopay/transfer line as just the store's own name
// (a co-branded card posting as "Sam's Club", not "Sam's Club Payment"), so
// CARD_PAYMENT_MERCHANT_PATTERN alone never offers "Debt payment" for that
// merchant in the reclassify dropdown — with no way back once reclassified
// elsewhere (real report: a household couldn't switch a mistakenly-rebucketed
// Sam's Club payment back). Still conservative, same reasoning as the
// pattern above: only true when the merchant text is actually a substring of
// one of the household's own tracked debts' names, not merchant text in
// general, so this doesn't reopen "Debt payment" on every unrelated retail
// purchase — a 3-letter merchant string matching by coincidence is exactly
// the false-positive this guards against, hence the length floor.
export function debtNameMatchesMerchant(merchant: string, debtName: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const merchantNorm = normalize(merchant);
  return merchantNorm.length >= 4 && normalize(debtName).includes(merchantNorm);
}

// An institution's org name minus generic corporate suffixes — "Chase Bank"
// → "Chase", "Synchrony Bank" → "Synchrony", "Wells Fargo Bank, N.A." →
// "Wells Fargo". The ACH line carries the brand, not the legal entity: a
// Chase card payment reads "CHASE CREDIT CRD EPAY", which never contains
// "chasebank", so the Amazon Prime Visa's $108.33 payment (2026-10-05) sat in
// "Needs a Bucket" with its offsetting card-side credit already synced. Only
// trailing words are stripped, so "Bank of America" stays whole.
const ORG_SUFFIX = /[\s,]+(bank|n\.?a\.?|usa|financial|card services?|inc\.?|corp\.?|corporation|co\.?)$/i;
export function issuerCoreName(orgName: string): string {
  let s = orgName.trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(ORG_SUFFIX, "").trim();
  }
  return s || orgName;
}

// Does a transaction's text point at exactly this debt? The cleaned merchant
// is checked against the debt name (a co-branded card's normalised payee is
// the bare store name, a substring of the debt's full name); the raw bank
// line and the merchant are each checked against the linked account's org
// name (the ACH descriptor embeds it — "…SAMSCLUB MSTRCRD…"). Same
// normalise-and-contains test with a 4-char floor as debtNameMatchesMerchant,
// so a coincidental short token can't match. Server + client safe.
export function txnTextNamesDebt(
  txn: { merchant: string; rawDescription: string | null | undefined },
  debt: { name: string; accountOrgName: string | null | undefined },
): boolean {
  if (debtNameMatchesMerchant(txn.merchant, debt.name)) return true;
  if (debt.accountOrgName) {
    if (debtNameMatchesMerchant(issuerCoreName(debt.accountOrgName), txn.rawDescription ?? "")) return true;
    if (debtNameMatchesMerchant(txn.merchant, debt.accountOrgName)) return true;
  }
  return false;
}

// Narrows the minimum-payment fingerprint's candidates to the debts the
// transaction's own text names, when it names any. A generic issuer payment
// ("Capital One Credit Card Payment", raw "…CAPITAL ONE CRCARDPMT…") whose
// amount happened to equal a *different* issuer's minimum used to be
// attributed to that other debt on amount alone — real incident 2026-09-29:
// a $29.00 Capital One payment landed on the Sam's Club (Synchrony) card,
// whose minimum is $29.00, showing it as minimum-paid on This Week's Bills.
// Named but no named candidate left (e.g. the issuer's cards have different
// minimums) → empty, so the caller falls through to the offsetting-leg check
// instead of guessing. Names nothing → every candidate, unchanged.
export function scopeToNamedDebts<T>(
  txn: { merchant: string; rawDescription: string | null | undefined },
  allDebts: T[],
  candidates: T[],
  describe: (d: T) => { name: string; accountOrgName: string | null | undefined },
): T[] {
  const named = new Set(allDebts.filter((d) => txnTextNamesDebt(txn, describe(d))));
  return named.size > 0 ? candidates.filter((d) => named.has(d)) : candidates;
}
