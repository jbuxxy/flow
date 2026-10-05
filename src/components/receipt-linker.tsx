"use client";

import { useState, useTransition } from "react";
import { CalendarClock, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { showToast } from "@/lib/toast";
import { MerchantLogo } from "@/components/merchant-logo";
import {
  linkReceiptToTransaction,
  linkReceiptToTransactions,
  linkReceiptToPlanAction,
  dismissReceipt,
} from "@/app/transactions/actions";

export type ReceiptToLink = {
  id: string;
  party: string | null;
  // The P2P app ("Venmo" etc.) when this is a peer payment — so the card
  // shows "Venmo · Ryan Carter" with the Venmo logo, not a bare name.
  p2pApp: string | null;
  totalCents: number | null;
  occurredOn: string | null; // YYYY-MM-DD
  itemSummary: string | null;
  // The payment memo / stated purpose off the receipt email.
  noteText: string | null;
  kind: string;
  // A merchant refund (Receipt.isRefund) and where the money's going — the
  // card waits for a credit, not a charge. Optional for older callers.
  isRefund?: boolean;
  refundTo?: string | null;
  refundToLast4?: string | null;
};

export type LinkCandidateTransaction = {
  id: string;
  merchant: string;
  amountCents: number;
  occurredOn: string; // YYYY-MM-DD
  accountLabel: string | null;
};

// A BNPL installment plan (Debt) the receipt could belong to when there's no
// single bank charge for it — see bnpl-plan-match.ts.
export type LinkCandidatePlan = {
  id: string;
  name: string;
  label: string | null;
  installmentsTotal: number | null;
};

// The manual half of receipt→transaction matching, for receipts
// matchReceipts couldn't place on its own. Modeled on ReimbursementLinker:
// a compact "which charge is this?" picker plus a dismiss.
export function ReceiptLinker({
  receipt,
  candidates,
  comboCandidates = [],
  planCandidates = [],
}: {
  receipt: ReceiptToLink;
  candidates: LinkCandidateTransaction[];
  // Pairs of charges that together add up to the receipt's total — a bill's
  // own bank fee posting as its own separate charge, a multi-shipment order.
  // See findComboCandidates (src/app/settings/email/page.tsx).
  comboCandidates?: LinkCandidateTransaction[][];
  planCandidates?: LinkCandidatePlan[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pick = (transactionId: string) =>
    startTransition(async () => {
      setError(null);
      const res = await linkReceiptToTransaction(receipt.id, transactionId);
      if (!res.ok) setError(res.error);
      else showToast("Receipt Linked");
    });

  const pickCombo = (transactionIds: string[]) =>
    startTransition(async () => {
      setError(null);
      const res = await linkReceiptToTransactions(receipt.id, transactionIds);
      if (!res.ok) setError(res.error);
      else showToast("Receipt Linked");
    });

  const pickPlan = (debtId: string) =>
    startTransition(async () => {
      setError(null);
      const res = await linkReceiptToPlanAction(receipt.id, debtId);
      if (!res.ok) setError(res.error);
      else showToast("Receipt Linked");
    });

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-900 dark:bg-amber-950/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {(receipt.p2pApp || receipt.party) && (
              <MerchantLogo
                merchant={receipt.p2pApp ?? receipt.party ?? ""}
                size={14}
                allowGuess={!receipt.p2pApp}
              />
            )}
            <span className="truncate">
              {receipt.p2pApp
                ? `${receipt.p2pApp}${receipt.party ? ` · ${receipt.party}` : ""}`
                : (receipt.party ?? "Unknown Sender")}
              {receipt.totalCents != null ? ` · ${formatCents(receipt.totalCents)}` : ""}
            </span>
            {receipt.isRefund && (
              <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                Refund
              </span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-neutral-400">
            {receipt.occurredOn ?? "No Date"}
            {receipt.noteText
              ? ` · "${receipt.noteText}"`
              : receipt.itemSummary
                ? ` · ${receipt.itemSummary}`
                : ""}
          </p>
        </div>
        <button
          onClick={() => startTransition(async () => { await dismissReceipt(receipt.id); showToast("Dismissed"); })}
          disabled={pending}
          aria-label="Not a Household Charge"
          title="Not a Household Charge"
          className="shrink-0 rounded-lg border border-neutral-300 p-1.5 text-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400"
        >
          <X size={13} />
        </button>
      </div>

      {candidates.length === 0 && comboCandidates.length === 0 && planCandidates.length === 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-neutral-400">
          {receipt.isRefund
            ? `Refund${receipt.totalCents != null ? ` of ${formatCents(receipt.totalCents)}` : ""}${
                receipt.refundTo
                  ? ` to ${receipt.refundTo}${receipt.refundToLast4 && !receipt.refundTo.includes(receipt.refundToLast4) ? ` (…${receipt.refundToLast4})` : ""}`
                  : ""
              } — waiting for the credit to post. Once it does, Flow ties it back to the original purchase.`
            : "No matching charge yet — Flow keeps trying as new transactions sync."}
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {candidates.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => pick(c.id)}
                disabled={pending}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-blue-100 px-2.5 py-1.5 text-left text-xs disabled:opacity-50 dark:border-neutral-800"
              >
                <span className="min-w-0 truncate">
                  {c.merchant}
                  <span className="text-gray-500 dark:text-neutral-400">
                    {" · "}
                    {c.occurredOn}
                    {c.accountLabel ? ` · ${c.accountLabel}` : ""}
                  </span>
                </span>
                <span className="shrink-0 font-medium">{formatCents(Math.abs(c.amountCents))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {comboCandidates.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-[11px] text-gray-500 dark:text-neutral-400">
            Or Two Charges That Add Up To The Total
          </p>
          <ul className="flex flex-col gap-1">
            {comboCandidates.map((combo) => (
              <li key={combo.map((c) => c.id).join("+")}>
                <button
                  onClick={() => pickCombo(combo.map((c) => c.id))}
                  disabled={pending}
                  className="flex w-full flex-col gap-0.5 rounded-lg border border-blue-100 px-2.5 py-1.5 text-left text-xs disabled:opacity-50 dark:border-neutral-800"
                >
                  {combo.map((c) => (
                    <span key={c.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {c.merchant}
                        <span className="text-gray-500 dark:text-neutral-400">
                          {" · "}
                          {c.occurredOn}
                          {c.accountLabel ? ` · ${c.accountLabel}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 font-medium">{formatCents(Math.abs(c.amountCents))}</span>
                    </span>
                  ))}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {planCandidates.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-[11px] text-gray-500 dark:text-neutral-400">
            Or Attach To an Installment Plan
          </p>
          <ul className="flex flex-col gap-1">
            {planCandidates.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => pickPlan(p.id)}
                  disabled={pending}
                  className="flex w-full items-center gap-1.5 rounded-lg border border-blue-100 px-2.5 py-1.5 text-left text-xs disabled:opacity-50 dark:border-neutral-800"
                >
                  <CalendarClock size={13} className="shrink-0 text-gray-500 dark:text-neutral-400" />
                  <span className="min-w-0 truncate">
                    {p.name}
                    {p.label ? (
                      <span className="text-gray-500 dark:text-neutral-400">{` · ${p.label}`}</span>
                    ) : null}
                    {p.installmentsTotal ? (
                      <span className="text-gray-500 dark:text-neutral-400">
                        {` · ${p.installmentsTotal} payments`}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
