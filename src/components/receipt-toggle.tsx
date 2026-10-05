"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";
import { ReceiptDetailBlock } from "@/components/receipt-detail-block";
import type { PaymentReceipt } from "@/lib/payment-receipt";

// A recurring card's paid line gets the same receipt glyph a Singles row
// carries in its title — here as a tap target, since these lines have no
// expanded view of their own to put the "From Receipt" block in. Split
// trigger/panel (same shape as useTransactionLabelEditor) so the glyph can
// sit inline right after the date while the block lands under the line.
// Both are null when the payment has no receipt.
export function useReceiptToggle(receipt: PaymentReceipt | null | undefined) {
  const [open, setOpen] = useState(false);
  if (!receipt) return { trigger: null, panel: null };
  const trigger = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      aria-expanded={open}
      aria-label={open ? "Hide Receipt" : "Show Receipt"}
      title={open ? "Hide Receipt" : "Show Receipt"}
      className="inline-flex shrink-0 items-center"
    >
      <Receipt size={12} className="text-emerald-700 dark:text-emerald-400" />
    </button>
  );
  const panel = open ? <ReceiptDetailBlock {...receipt} p2pTitle={null} /> : null;
  return { trigger, panel };
}
