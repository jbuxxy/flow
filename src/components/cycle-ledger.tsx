"use client";

import { CheckCircle2 } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import type { PaymentReceipt } from "@/lib/payment-receipt";
import { useReceiptToggle } from "@/components/receipt-toggle";

export type CycleLedgerPayment = {
  id: string;
  occurredOn: string;
  amountCents: number;
  // Its matched receipt, if any — glyph after the date toggles the "From
  // Receipt" block under that payment (see useReceiptToggle).
  receipt?: PaymentReceipt | null;
};

function LedgerPaymentLine({ payment: p, primaryOccurredOn }: { payment: CycleLedgerPayment; primaryOccurredOn: string | null }) {
  const { trigger, panel } = useReceiptToggle(p.receipt);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="flex flex-1 items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
          <span>
            {formatDate(new Date(p.occurredOn), { month: "short", day: "numeric" })}
            {p.occurredOn === primaryOccurredOn ? " · this cycle" : " · extra"}
          </span>
          {trigger}
        </span>
        <span className="font-medium text-neutral-800 dark:text-neutral-200">{formatCents(p.amountCents)}</span>
      </div>
      {panel}
    </li>
  );
}

// The per-cycle "what actually posted this cycle" list — every payment
// within the current cycle's match window, the one considered "official"
// (primaryOccurredOn) labeled "this cycle", any other same-cycle payment
// labeled "extra", plus a Total row once there's more than one. Shared by
// BillRow (RecurringBill) and PatternRow (a scheduled RecurringPattern) so
// both render the exact same card family — was duplicated inline in
// bill-row.tsx before PatternRow needed the identical treatment
// (2026-09-11). Every entry here is a real posted payment (that's this
// list's whole purpose), so each gets the same emerald checkmark BillRow's
// own single-payment "Paid {date}" line uses elsewhere — a caller showing
// this ledger should never *also* render a separate summary "Paid" line
// above it repeating one of these entries under a different label (real
// report, 2026-09-14: a bill's $35 charge plus its $2 attached service fee
// read as the $35 one listed twice, once as "Paid Sep 01" up top and again
// as "Sep 01 · this cycle" down here).
export function CycleLedger({
  payments,
  primaryOccurredOn,
  totalCents,
}: {
  payments: CycleLedgerPayment[];
  // The payment date the caller considers "the" cycle payment (a bill's
  // lastPaidDate, a pattern's lastPaidDate) — every other same-cycle payment
  // reads as "extra" instead.
  primaryOccurredOn: string | null;
  totalCents: number;
}) {
  if (payments.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1 text-xs">
      {payments.map((p) => (
        <LedgerPaymentLine key={p.id} payment={p} primaryOccurredOn={primaryOccurredOn} />
      ))}
      {payments.length > 1 && (
        <li className="flex items-center gap-1.5 border-t border-blue-100 dark:border-neutral-800 pt-1 font-medium text-neutral-800 dark:text-neutral-200">
          {/* Empty spacer matching the checkmark's own width above, so
              "Total" lines up under the payment dates instead of sitting
              flush left of them. */}
          <span className="inline-block w-[15px] shrink-0" aria-hidden />
          <span className="flex-1">Total</span>
          <span>{formatCents(totalCents)}</span>
        </li>
      )}
    </ul>
  );
}
