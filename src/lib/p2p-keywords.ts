// Split out from p2p-transfers.ts (which imports `db`) so client components
// — e.g. unlabeled-p2p-list.tsx, auto-detecting which app a transaction came
// from to prefill a new pattern's channelKeyword — can use this list without
// pulling a server-only module into the client bundle.
//
// "paypal" included alongside the true P2P apps for the same underlying
// reason: it's a generic app-name merchant string that can mean genuinely
// different things per-transaction (a checking-account debit named just
// "PayPal" might be a payment toward a PayPal Credit debt, or an ordinary
// online purchase checked out through PayPal) — same shape of ambiguity
// that keeps this list out of MerchantRule auto-classification (see
// the P2P skip in reassignTransaction, src/app/buckets/actions.ts, and the BNPL exact-match note
// in simplefin-sync.ts: "paypal credit" only matches transactions whose
// *entire* merchant string is literally "PayPal Credit", which real
// PayPal-issued payment descriptors ("PayPal") never are).
export const P2P_DISCOVERY_KEYWORDS = ["venmo", "zelle", "cash app", "cashapp", "apple cash", "paypal"];

// Whether a merchant string names a P2P app (case-insensitive substring).
// Only the merchant text — callers that also honor a receipt-resolved
// business party (reassignTransaction, the sync categorizer) check that
// themselves.
export function isP2PMerchant(merchant: string | null | undefined): boolean {
  const m = (merchant ?? "").toLowerCase();
  return P2P_DISCOVERY_KEYWORDS.some((k) => m.includes(k));
}

// The Prisma-shaped counterpart: `{ OR: [...] }` matching a P2P merchant.
// Plain object, no Prisma import, so this file stays client-safe.
export function p2pMerchantMatch() {
  return { OR: P2P_DISCOVERY_KEYWORDS.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })) };
}

// What merchant a charge counts as for rules, history and composition. A
// receipt-resolved BUSINESS party ("Jane's Dog Walking") supersedes the raw
// P2P app text ("Venmo") — that's how a P2P charge becomes a learnable
// merchant. A resolved PERSON ("Danny R") does not: a friend-to-friend
// payment could be for anything, so it stays on the one-at-a-time P2P path.
// `p2p` is true when the charge should be treated as unresolved P2P. Shared
// by the sync categorizer, manual reassignment and the bucket composition
// summary, which used to drop every P2P charge, resolved business or not
// (2026-10-09 review).
export function effectiveMerchant(t: {
  merchant: string;
  resolvedMerchant?: string | null;
  resolvedMerchantIsPerson?: boolean | null;
}): { merchant: string; p2p: boolean } {
  const resolvedBusiness = t.resolvedMerchant && !t.resolvedMerchantIsPerson ? t.resolvedMerchant.trim() : "";
  if (resolvedBusiness) return { merchant: resolvedBusiness, p2p: false };
  return { merchant: t.merchant, p2p: isP2PMerchant(t.merchant) };
}
