"use client";

import { useState } from "react";
import { Bookmark, Link2, PartyPopper, Receipt, Target } from "lucide-react";
import { formatCents } from "@/lib/money";
import { DebtPaymentRow, type DebtPaymentData } from "./debt-payment-row";
import { InstallmentProgressBar } from "@/components/installment-progress-bar";
import { PlanReceiptSection, type PlanReceiptItem } from "@/components/plan-receipt-section";
import { MerchantLogos } from "@/components/merchant-logo";
import { debtLogoSearchText } from "@/lib/merchant-domains";
import type { AccountedForCandidate } from "@/lib/debt-payments";
import { useEntryFilter } from "@/components/bucket-entry-filter";

// accountBudgetTracked already lives on DebtPaymentData itself — used there
// to gate the per-payment "already accounted for" linker (DebtPaymentRow).
// There is no whole-debt "exclude everything" toggle here (removed
// 2026-08-19 — a household never wants to blanket-exclude an account from a
// recurring/mixed bucket, only specific already-double-counted payments; see
// the schema comment on Transaction.accountedForLinks).
export type DebtPaymentWithName = DebtPaymentData & {
  debtName: string;
  // The linked account's raw synced name, when this debt is linked —
  // distinct from debtName above, which already prefers a household's own
  // renamed displayName over it. Logo matching alone also searches this
  // (see the MerchantLogos call below), and only reaches for
  // accountOrgName below as a last resort — see debtLogoSearchText's own
  // comment for why the tiering matters. Never shown as text; null for a
  // manual (unlinked) debt.
  accountRawName: string | null;
  // The linked account's institution name (Account.orgName, e.g. "Capital
  // One") — SimpleFIN's own field, not always accurate (a real household's
  // Discover card reports "Capital One" here), so debtLogoSearchText only
  // ever falls back to it when accountRawName alone found nothing.
  accountOrgName: string | null;
  debtLabel: string | null;
  balanceCents: number;
  // Debt.source === "SIMPLEFIN" — drives the same blue "Synced from a
  // Connected Account" indicator debt-row.tsx shows on /debts, propagated
  // here (2026-08-26 household request) so a synced debt reads the same way
  // wherever its payment card renders (Bills, Buckets). Deliberately NOT
  // shown in manual-debt-editor.tsx (Account Settings) — that page's rows
  // already sit under a "Connected Account" heading, so the icon would be
  // redundant there.
  linked: boolean;
  // Debt.includeInPayoffPlan — same emerald Target icon
  // src/app/settings/simplefin/page.tsx already shows on its connected-
  // account badges ("Included in the Debt Payoff Plan"), propagated here
  // alongside `linked` (2026-08-26 household request) so a plan-tracked
  // debt reads the same way on its Bills/Buckets payment card too.
  includeInPayoffPlan: boolean;
  // Non-null only for an INSTALLMENT/BNPL debt (see the DebtType schema
  // comment — debtType:"INSTALLMENT" is the reliable BNPL proxy elsewhere in
  // the codebase; these two fields are that same signal here, since a plain
  // REVOLVING debt payment never has them set) — drives the gradient
  // progress bar at the bottom of the card below.
  installmentsTotal: number | null;
  installmentsRemaining: number | null;
  // Itemization + total from the email receipt for the original BNPL
  // purchase, when one's been linked to this plan (see Receipt.debtId /
  // linkReceiptToPlan). The bank only ever sees the installments, so this is
  // the only place the purchase's line items show.
  debtReceiptItems: PlanReceiptItem[] | null;
  debtReceiptTotalCents: number | null;
};

// The card wrapper (debt name, balance, tags) around
// DebtPaymentRow's own status/ledger (all term-editing now lives in
// Settings — see DebtPaymentRow's own comment) — pulled out of
// BucketBillsSection (2026-08-23) so the household-wide /bills "Recurring"
// page can render the exact same card for a debt payment regardless of
// which bucket (if any) it's assigned to, instead of duplicating this JSX.
export function DebtPaymentCard({
  debtPayment,
  accountedForSuggestions = {},
  // Forwarded to DebtPaymentRow — "bucket" gives the payment ledger the
  // shared EntryLine treatment (see that component). Set by BucketBillsSection.
  variant = "default",
}: {
  debtPayment: DebtPaymentWithName;
  accountedForSuggestions?: Record<string, AccountedForCandidate[]>;
  variant?: "default" | "bucket";
}) {
  // "Payment 3 of 12" — mirrors ManualDebtEditor's/DebtRow's own
  // currentPayment derivation (src/app/settings/simplefin/manual-debt-editor.tsx,
  // src/app/debts/debt-row.tsx).
  const currentPayment =
    debtPayment.installmentsTotal != null && debtPayment.installmentsRemaining != null
      ? debtPayment.installmentsTotal - debtPayment.installmentsRemaining + 1
      : null;

  // Receipt itemization for the original BNPL purchase — toggled from a
  // receipt icon up in the card header (next to the synced/plan icons),
  // same affordance DebtRow uses on /debts and ManualDebtEditor uses in
  // Account Settings (household request, 2026-09-01: keep it in sync).
  const [receiptOpen, setReceiptOpen] = useState(false);
  const hasReceipt = (debtPayment.debtReceiptItems?.length ?? 0) > 0;

  // Inert unless rendered inside the bucket page's BucketEntryFilterProvider
  // (no provider on /bills or /debts) — then it hides when a category/merchant
  // filter is active and unmatched, and tints its left edge. A debt payment
  // has no real merchant, so it keys off the debt name for the merchant
  // dimension (rarely a breakdown match — category filtering is the reliable
  // one for recurring cards).
  const { hidden, barClass } = useEntryFilter(debtPayment.categoryName, debtPayment.debtName);
  if (hidden) return null;

  return (
    <li
      className={`flex flex-col gap-1 rounded-xl border p-4 ${
        debtPayment.paidOff
          ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20"
          : "border-blue-100 dark:border-neutral-800"
      } ${barClass}`}
    >
      {/* Header wrapper: name + icons + inline plan label on the left,
          balance on the right, then the receipt panel below. The label
          truncates (min-w-0 on the title column) so a long one can't shove
          the balance outside the card on a phone. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-tight font-medium text-neutral-900 dark:text-neutral-100">
              {/* Curated table only, no allowGuess (unlike BillRow's own
                  MerchantLogo) — debtName here can be a household's own
                  free-text override (a synced account's renamed
                  displayName, or a manual debt's name), not always a real
                  bank-synced business descriptor, so guessing a domain for
                  it risks surfacing a wrong, unrelated company's logo for
                  a personal label. A curated hit (a real synced or BNPL
                  provider name — Klarna/Affirm/Chase/Verizon/etc.) still
                  shows normally, including once a household renames an
                  entry to one (household request, 2026-09-13). MerchantLogos
                  (not the single-logo MerchantLogo), so a composite BNPL
                  name like "Nike - Klarna" shows both the retailer's and
                  the provider's logo, in either word order.
                  debtLogoSearchText also searches the raw synced account
                  name, and — only if that alone finds nothing — the
                  account's institution name, so a rename that drops the
                  one word a pattern needed ("Capital One Venture" ->
                  "Venture (3021)") still doesn't lose the logo, without
                  unconditionally risking a wrong/misattributed second one
                  (household request, 2026-09-14: "revert the double brand
                  icon"). */}
              <MerchantLogos
                merchant={debtLogoSearchText(
                  debtPayment.debtName,
                  debtPayment.accountRawName,
                  debtPayment.accountOrgName,
                )}
                size={16}
                max={debtPayment.installmentsTotal !== null ? 2 : 1}
              />
              {debtPayment.debtName}
              {debtPayment.linked && (
                <span title="Synced from a Connected Account" className="shrink-0">
                  <Link2 size={13} className="text-blue-700 dark:text-blue-400" />
                </span>
              )}
              {debtPayment.includeInPayoffPlan && (
                <span title="Included in the Debt Payoff Plan" className="shrink-0">
                  <Target size={13} className="text-emerald-600 dark:text-emerald-400" />
                </span>
              )}
              {debtPayment.needsAttention && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" title="Needs Attention" />
              )}
              {hasReceipt && (
                <button
                  type="button"
                  onClick={() => setReceiptOpen((v) => !v)}
                  aria-expanded={receiptOpen}
                  aria-label={receiptOpen ? "Hide Receipt" : "View Receipt"}
                  title={receiptOpen ? "Hide Receipt" : "View Receipt"}
                  className="shrink-0 text-emerald-700 dark:text-emerald-400"
                >
                  <Receipt size={13} />
                </button>
              )}
              {/* The plan's own label (e.g. "Sam's speed cats") sits inline
                  right after the name + icons, same as ManualDebtEditor's
                  DebtLabelEditor — not on its own line below. */}
              {debtPayment.debtLabel && (
                <span className="inline-flex min-w-0 items-center gap-1 text-xs font-normal text-blue-900 dark:text-blue-300">
                  <Bookmark size={11} className="shrink-0" />
                  <span className="truncate">{debtPayment.debtLabel}</span>
                </span>
              )}
            </p>
          </div>
          {debtPayment.paidOff ? (
            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <PartyPopper size={12} />
              Paid Off
            </span>
          ) : (
            <span
              className={`shrink-0 text-sm font-semibold ${
                debtPayment.balanceCents > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {formatCents(debtPayment.balanceCents)}
            </span>
          )}
        </div>
        <PlanReceiptSection
          items={debtPayment.debtReceiptItems}
          totalCents={debtPayment.debtReceiptTotalCents}
          controlledOpen={receiptOpen}
        />
      </div>
      <DebtPaymentRow
        debtPayment={debtPayment}
        accountedForSuggestions={accountedForSuggestions}
        variant={variant}
      />
      {currentPayment && debtPayment.installmentsTotal && (
        <InstallmentProgressBar
          className="mt-1 border-t border-blue-100 dark:border-neutral-800 pt-3"
          currentPayment={currentPayment}
          total={debtPayment.installmentsTotal}
        />
      )}
    </li>
  );
}
