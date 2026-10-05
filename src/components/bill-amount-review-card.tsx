"use client";

import { HelpCircle } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { confirmBillAmountChanged, declineBillAmountChanged } from "@/app/bills/actions";
import { QuickConfirmCard } from "@/components/quick-confirm-card";
import type { PendingBillAmountReview } from "@/lib/recurring-bills";

// Dashboard/bills-page nudge for every pending "did your bill's amount
// change?" question — the RecurringBill counterpart to
// DebtAmountReviewCard, sourced entirely from parsed bill-notice emails (see
// matchBillNoticeAmounts, src/lib/bill-notice-sync.ts). Bills have no
// bank-sync-triggered review — a real bank-matched payment just silently
// refreshes RecurringBill.amountCents (see that field's schema comment) —
// an email-derived change always asks first, since extraction is less
// trustworthy than a bank-observed transaction.
export function BillAmountReviewCard({ reviews }: { reviews: PendingBillAmountReview[] }) {
  return (
    <QuickConfirmCard
      icon={<HelpCircle size={18} className="shrink-0 text-amber-700 dark:text-amber-400" />}
      items={reviews.map((r) => ({
        id: r.id,
        text: (
          <>
            <span className="font-medium">{r.billName}</span> — its latest bill says {formatCents(r.observedAmountCents)} is
            now due{r.dueDate ? ` by ${formatDate(r.dueDate, { month: "short", day: "numeric" })}` : ""} (was{" "}
            {formatCents(r.expectedAmountCents)}). Did the amount change?
          </>
        ),
        confirmLabel: "Yes, Update It",
        confirmToast: "Confirmed",
        onConfirm: () => confirmBillAmountChanged(r.id),
        declineLabel: "No, Leave It",
        onDecline: () => declineBillAmountChanged(r.id),
      }))}
    />
  );
}
