"use client";

import { useState } from "react";
import { ChevronRight, Receipt } from "lucide-react";
import { formatCents } from "@/lib/money";

export type PlanReceiptItem = {
  description: string;
  qty: number | null;
  unitPriceCents: number | null;
  totalCents: number | null;
};

// Collapsible "what the BNPL purchase actually was" panel — the itemization
// from the email receipt linked to an installment plan (Receipt.debtId /
// linkReceiptToPlan). The bank only ever sees the installments, so the plan
// (Debt) is the only home its line items have.
//
// Rendered identically wherever a plan appears — /debts (DebtRow), /bills +
// a bucket page (DebtPaymentCard), Account Settings (ManualDebtEditor) — so
// keep it here rather than re-inlining the markup. Collapsed by default,
// toggled by its green receipt icon (chevron rotates, same convention as
// collapsible-group.tsx).
//
// `controlledOpen` (+ nothing else) makes it a controlled panel with its
// own "Receipt · $X" header suppressed — every plan surface (DebtRow on
// /debts, DebtPaymentCard on Bills/Buckets, ManualDebtEditor in Account
// Settings) drives it from a receipt icon up in the card's title bar
// instead, next to the link/plan icons (household request, 2026-09-01:
// matches how a /transactions row surfaces its receipt, and keeps all
// three surfaces in sync). The panel then renders nothing at all while
// closed.
export function PlanReceiptSection({
  items,
  totalCents,
  className = "",
  controlledOpen,
}: {
  items: PlanReceiptItem[] | null | undefined;
  totalCents: number | null | undefined;
  className?: string;
  controlledOpen?: boolean;
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : selfOpen;
  if (!items || items.length === 0) return null;
  if (controlled && !open) return null;

  return (
    <div className={`rounded-lg border border-blue-100 dark:border-neutral-800 ${className}`}>
      {!controlled && (
        <button
          type="button"
          onClick={() => setSelfOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-medium text-emerald-700 dark:text-emerald-400"
        >
          <Receipt size={12} className="shrink-0" />
          <span>Receipt{totalCents != null ? ` · ${formatCents(totalCents)}` : ""}</span>
          <ChevronRight
            size={12}
            className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>
      )}
      {open && (
        <ul
          className={`flex flex-col gap-0.5 px-2.5 py-1.5 ${controlled ? "" : "border-t border-blue-100 dark:border-neutral-800"}`}
        >
          {controlled && totalCents != null && (
            <li className="mb-0.5 flex justify-between gap-2 border-b border-blue-100 pb-1 text-xs font-medium text-emerald-700 dark:border-neutral-800 dark:text-emerald-400">
              <span>Receipt</span>
              <span>{formatCents(totalCents)}</span>
            </li>
          )}
          {items.map((item, i) => (
            <li
              key={i}
              className="flex justify-between gap-2 text-xs text-gray-600 dark:text-neutral-400"
            >
              <span className="min-w-0 truncate">
                {item.qty && item.qty > 1 ? `${item.qty}× ` : ""}
                {item.description}
              </span>
              {item.totalCents != null && <span className="shrink-0">{formatCents(item.totalCents)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
