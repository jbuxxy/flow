// Shared merchant-display derivation for a transaction row — used by both
// /transactions' TransactionRow and the bucket page's own TransactionRow
// (src/app/buckets/[id]/transaction-row.tsx), which otherwise hand-copied
// this exact logic.

export type P2PDisplayInput = {
  resolvedMerchant: string | null;
  resolvedMerchantIsPerson: boolean;
  receiptPaidWith: string | null;
  merchant: string;
};

// A matched P2P receipt shows in the row title as "Venmo · Name" — the app
// plus the real counterparty — for BOTH a person and a business payee
// (2026-08-29: every Venmo line should read this way, not just the
// friend/family ones). `receiptPaidWith` is the clean app name off the
// receipt; the older person-only path falls back to the raw merchant string
// (kept only for a P2P receipt that never named its app). No prefix when the
// receipt didn't resolve a counterparty.
//
// Outside P2P, `resolvedMerchant` never overrides the display: a receipt is
// matched to a charge by amount/date, not identity, so an ordinary card
// purchase can pick up an unrelated receipt's party (2026-09-22 — a gas
// station charge showed as "Churros" because a same-amount snack receipt
// resolved to that party). The raw bank `merchant` is always what actually
// charged the card, so it's the only safe fallback for a non-P2P row.
export function deriveP2PDisplay(t: P2PDisplayInput): {
  p2pApp: string | null;
  p2pTitle: string | null;
  displayMerchant: string;
  logoMerchant: string;
} {
  const p2pApp =
    (t.resolvedMerchant && (t.receiptPaidWith || (t.resolvedMerchantIsPerson ? t.merchant : null))) || null;
  const p2pTitle = p2pApp ? `${p2pApp} · ${t.resolvedMerchant}` : null;
  const displayMerchant = p2pTitle ?? t.merchant;
  const logoMerchant = p2pApp ?? t.merchant;
  return { p2pApp, p2pTitle, displayMerchant, logoMerchant };
}

// A BNPL installment charge's title reads as just the plan it belongs to —
// "GlassesUSA.com - Klarna". The bank descriptor on an individual
// installment is opaque and inconsistent even within one plan ("Klarna",
// "KLARNA*GLASSESUSA.CO WWW.KLARNA.CO", "AUTOMATIC WITHDRAWAL, KLARNA
// PURCHASE WEB (S)"), so the linked Debt is the only stable identity.
// Derived purely from the transaction -> Debt link (matchInstallmentPayments,
// src/lib/debt-payments.ts) — independent of whether the purchase receipt was
// ever attached to the plan, and of which side (receipt or installments)
// linked first. Returns null for any transaction not linked to an
// INSTALLMENT plan. Where it sits in the schedule ("3/6") shows separately,
// at the end of the subline (installmentDisplaySuffix below) — not folded
// into this title (2026-09-14 request).
export function installmentDisplayTitle(t: { debtType: string | null; debtName: string | null }): string | null {
  if (t.debtType !== "INSTALLMENT" || !t.debtName) return null;
  return t.debtName;
}

// The "3/6" schedule-position suffix for a BNPL installment charge's
// subline — appended after the plan name there instead of in the row title
// (see installmentDisplayTitle above). null when there's no captured
// installmentsTotal (a legacy plan) or this isn't an installment charge.
export function installmentDisplaySuffix(t: {
  debtType: string | null;
  installmentNumber: number | null;
  installmentsTotal: number | null;
}): string | null {
  if (t.debtType !== "INSTALLMENT" || !t.installmentNumber || !t.installmentsTotal) return null;
  return `${Math.min(t.installmentNumber, t.installmentsTotal)}/${t.installmentsTotal}`;
}

// Only worth showing when it says something `merchant` doesn't already —
// `merchant` falls back to this same field (see the schema comment on
// Transaction.rawDescription) whenever SimpleFIN sent no payee, so an exact
// match here is just noise, not new information.
export function bankDescriptionFor(t: { rawDescription: string | null; merchant: string }): string | null {
  return t.rawDescription && t.rawDescription.trim().toLowerCase() !== t.merchant.trim().toLowerCase()
    ? t.rawDescription
    : null;
}
