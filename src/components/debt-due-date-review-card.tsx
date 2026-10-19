"use client";

import { CalendarClock } from "lucide-react";
import { formatDate, ordinal } from "@/lib/date";
import { confirmDebtDueDateChanged, declineDebtDueDateChanged } from "@/app/debts/actions";
import { QuickConfirmCard } from "@/components/quick-confirm-card";
import type { PendingDebtDueDateReview } from "@/lib/debt-payments";

// Dashboard nudge for every pending "did your due date change?" question — a
// card/loan statement email naming a different due day than the one tracked
// (see DebtDueDateReview, reviewDebtNoticeDueDate in bill-notice-sync.ts).
// The DebtAmountReviewCard counterpart, same Quick Confirm shell.
export function DebtDueDateReviewCard({ reviews }: { reviews: PendingDebtDueDateReview[] }) {
  return (
    <QuickConfirmCard
      icon={<CalendarClock size={18} className="shrink-0 text-amber-700 dark:text-amber-400" />}
      items={reviews.map((r) => ({
        id: r.id,
        text: (
          <>
            <span className="font-medium">{r.debtName}</span> — its latest statement says it&apos;s due{" "}
            {formatDate(r.observedDueDate, { month: "short", day: "numeric" })} (Flow has the{" "}
            {ordinal(r.expectedDueDate.getUTCDate())}). Did the due date change?
          </>
        ),
        confirmLabel: `Yes, Use The ${ordinal(r.observedDueDate.getUTCDate())}`,
        confirmToast: "Due Date Updated",
        onConfirm: () => confirmDebtDueDateChanged(r.id),
        declineLabel: "No, Leave It",
        onDecline: () => declineDebtDueDateChanged(r.id),
      }))}
    />
  );
}
