// Split out of bnpl-detect.ts (which imports `db`) so a client component —
// TransactionRow's classification label (src/app/transactions/transaction-row.tsx),
// telling apart a real internal transfer from an unresolved BNPL-provider
// charge that only *looks* like one — can reuse the same keyword list
// without pulling a server-only module into the client bundle. Same
// reasoning as debt-payment-pattern.ts's split from simplefin-sync.ts.
export const BNPL_KEYWORDS = [
  "affirm",
  "klarna",
  "afterpay",
  "sezzle",
  "quadpay",
  "zip co",
  "zip.co",
  "paypal credit",
  "pay in 4",
  "uplift",
  "splitit",
];

// A synced transaction can be isTransfer:true for two very different
// reasons that the stored fields alone don't distinguish: a real internal
// transfer (matchInternalTransfers, checking<->savings) or an unresolved
// charge that merely *looks* BNPL-related by merchant text
// (categorizeUncategorizedTransactions' bnplKeyword branch, simplefin-sync.ts)
// but hasn't been attributed to a specific tracked plan (debtId still null).
// Both land as isTransfer:true/debtId:null — this is the only way to tell
// them apart for display purposes, without a schema change.
//
// `extraKeywords` is for a household's own AI-confirmed lenders
// (BnplKeyword, src/lib/bnpl-detect.ts's allBnplKeywords) — this file can't
// query the database itself (client-safe by design), so a server component
// fetches the merged list and passes the household-specific extras down.
// Defaults to just the static list, still correct (just less complete) if a
// caller doesn't have them handy.
export function looksLikeBnplMerchant(merchant: string, extraKeywords: string[] = []): boolean {
  const lower = merchant.toLowerCase();
  return [...BNPL_KEYWORDS, ...extraKeywords].some((k) => lower.includes(k));
}
