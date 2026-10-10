// Shared "could this email receipt be the original purchase behind this BNPL
// installment plan?" gating — used by both the automatic linker
// (matchReceiptToBnplPlan, src/lib/receipt-sync.ts) and the manual picker
// (src/app/settings/email/page.tsx), the same way receipt-match.ts is shared
// across the transaction-match paths.
//
// A BNPL purchase (Affirm / Klarna / Afterpay / Zip / PayPal "Pay in 4")
// never posts to the bank as one charge — only the fixed installments do —
// so a receipt for the whole purchase has no transaction to match. The plan
// (a Debt, debtType INSTALLMENT) is the thing it belongs to. We recognise it
// by the purchase total lining up with the plan's original principal, the
// merchant lining up with the plan name, and the purchase date sitting a
// little before / well after the receipt.

import { BNPL_KEYWORDS } from "@/lib/bnpl-keywords";
import { nameSimilarity } from "@/lib/fuzzy-match";

export type BnplPlanShape = {
  name: string;
  balanceCents: number;
  minPaymentCents: number;
  installmentsTotal: number | null;
  purchaseDate: Date | null;
  // DebtPayment.amountDueCents when the plan has a tracked recurring payment
  // (all do in practice) — the fixed per-installment amount.
  perInstallmentCents: number | null;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "Nike - Klarna" -> "Nike", "Afterpay - CR-V" -> "CR-V",
// "GlassesUSA.com - Klarna" -> "GlassesUSA com", "Affirm — Dick's" -> "Dick s".
// The household names these plans "<lender> - <what/merchant>" (or the
// reverse); stripping the lender token leaves the part a receipt's party can
// actually be compared against.
export function bnplPlanMerchantName(planName: string): string {
  let s = planName;
  for (const k of BNPL_KEYWORDS) s = s.replace(new RegExp(escapeRe(k), "ig"), " ");
  return s
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Best estimate of what the purchase originally cost: the contracted number
// of installments times the fixed per-installment amount. Falls back to the
// current balance (correct when nothing's been paid yet, an approximation
// otherwise) when the plan isn't tracking installments.
export function bnplPlanOriginalPrincipalCents(plan: BnplPlanShape): number | null {
  const per = plan.perInstallmentCents ?? (plan.minPaymentCents || null);
  if (plan.installmentsTotal && per) return plan.installmentsTotal * per;
  if (plan.balanceCents > 0) return plan.balanceCents;
  return null;
}

// A BNPL schedule trues up rounding on the final payment, so the sum can sit
// a few cents off the receipt total; allow 1% or $1, whichever is larger —
// tight enough that a different same-merchant order ($78.22 vs an $80.04
// plan) doesn't collide.
export function bnplPlanTotalMatches(originalCents: number, receiptTotalCents: number): boolean {
  return Math.abs(originalCents - receiptTotalCents) <= Math.max(Math.round(receiptTotalCents * 0.01), 100);
}

function bnplPlanNameResemblesParty(planName: string, party: string): boolean {
  return nameSimilarity(bnplPlanMerchantName(planName), party) >= 0.6;
}

// The plan's purchase can predate the receipt email by a few weeks (a plan
// set up after the fact, dated back to the purchase) or follow it by a
// couple of months (Klarna's first payment, and often the in-app plan
// creation, lag the purchase). null purchaseDate = don't rule it out.
const PURCHASE_DATE_BEFORE_DAYS = 21;
const PURCHASE_DATE_AFTER_DAYS = 75;

export function bnplPlanDateInWindow(purchaseDate: Date | null, receiptAnchor: Date): boolean {
  if (!purchaseDate) return true;
  const deltaDays = (purchaseDate.getTime() - receiptAnchor.getTime()) / 86_400_000;
  return deltaDays >= -PURCHASE_DATE_BEFORE_DAYS && deltaDays <= PURCHASE_DATE_AFTER_DAYS;
}

// Full gate for the automatic linker: merchant, total and date all have to
// line up. The manual picker composes the pieces more loosely (total + date,
// name optional) since a human confirms the pick.
export function bnplPlanMatchesReceipt(
  plan: BnplPlanShape,
  receipt: { party: string | null; totalCents: number | null },
  receiptAnchor: Date,
): boolean {
  if (receipt.totalCents == null || !receipt.party) return false;
  if (!bnplPlanNameResemblesParty(plan.name, receipt.party)) return false;
  if (!bnplPlanDateInWindow(plan.purchaseDate, receiptAnchor)) return false;
  const original = bnplPlanOriginalPrincipalCents(plan);
  return original != null && bnplPlanTotalMatches(original, receipt.totalCents);
}
