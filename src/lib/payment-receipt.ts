// Per-payment receipt enrichment for recurring cards (BillRow, PatternRow) —
// the same "From Receipt" detail a Singles/transaction row shows, carried on
// each matched payment in a bill's or pattern's ledger so a paid recurring
// entry gets its receipt glyph + detail too (household request, 2026-09-30).
// Plain module (no "use client") — server pages call PAYMENT_RECEIPT_SELECT /
// paymentReceiptOf while building their props; see pattern-data.ts's header
// for why that matters.
import { deriveP2PDisplay } from "@/lib/transaction-display";
import type { ReceiptLineItem } from "@/app/transactions/transaction-row";

export type PaymentReceipt = {
  hasReceipt: boolean;
  receiptItems: ReceiptLineItem[] | null;
  receiptNote: string | null;
  // Already null when the payee is a P2P person — the card's own "Venmo -
  // Name" identity line already says how it was paid (same suppression
  // ReceiptDetailBlock's p2pTitle guard does on a transaction row).
  receiptPaidWith: string | null;
  receiptDate: string | null; // YYYY-MM-DD
  receiptTotalCents: number | null;
};

// Spread into a payment transaction's Prisma `select`.
export const PAYMENT_RECEIPT_SELECT = {
  merchant: true,
  resolvedMerchant: true,
  resolvedMerchantIsPerson: true,
  receiptItems: true,
  receiptNote: true,
  receiptPaidWith: true,
  receiptTotalCents: true,
  receipt: { select: { occurredOn: true, receivedAt: true } },
} as const;

export type PaymentReceiptSource = {
  merchant: string;
  resolvedMerchant: string | null;
  resolvedMerchantIsPerson: boolean;
  receiptItems: unknown;
  receiptNote: string | null;
  receiptPaidWith: string | null;
  receiptTotalCents: number | null;
  receipt: { occurredOn: Date | null; receivedAt: Date } | null;
};

// null when nothing receipt-derived is on this payment — the common case, and
// what the UI keys off to show no glyph at all.
export function paymentReceiptOf(t: PaymentReceiptSource): PaymentReceipt | null {
  const items = Array.isArray(t.receiptItems) && t.receiptItems.length > 0 ? (t.receiptItems as ReceiptLineItem[]) : null;
  if (!t.receipt && !items && !t.receiptNote) return null;
  const { p2pTitle } = deriveP2PDisplay(t);
  return {
    hasReceipt: !!t.receipt,
    receiptItems: items,
    receiptNote: t.receiptNote,
    receiptPaidWith: p2pTitle ? null : t.receiptPaidWith,
    receiptDate: t.receipt ? (t.receipt.occurredOn ?? t.receipt.receivedAt).toISOString().slice(0, 10) : null,
    receiptTotalCents: t.receiptTotalCents,
  };
}
