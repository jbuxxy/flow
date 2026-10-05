"use client";

import { HelpCircle } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { confirmDebtAmountChanged, declineDebtAmountChanged } from "@/app/debts/actions";
import { QuickConfirmCard } from "@/components/quick-confirm-card";
import type { PendingDebtAmountReview } from "@/lib/debt-payments";

// Dashboard nudge for every pending "did your minimum payment change?"
// question — either a bank-sync overpayment (matchDebtPayments,
// src/lib/debt-payments.ts) or a parsed bill-notice email stating a
// different minimum (matchBillNoticeAmounts, src/lib/bill-notice-sync.ts).
// Surfaced here rather than only on /debts since resolving it can't wait on
// the household happening to visit that page, and a push notification
// already pointed them at the dashboard when this was created.
export function DebtAmountReviewCard({ reviews }: { reviews: PendingDebtAmountReview[] }) {
  return (
    <QuickConfirmCard
      icon={<HelpCircle size={18} className="shrink-0 text-amber-700 dark:text-amber-400" />}
      items={reviews.map((r) => ({
        id: r.id,
        text:
          r.source === "EMAIL" ? (
            <>
              <span className="font-medium">{r.debtName}</span> — its latest bill says {formatCents(r.observedAmountCents)} is
              now due{r.dueDate ? ` by ${formatDate(r.dueDate, { month: "short", day: "numeric" })}` : ""} (was{" "}
              {formatCents(r.expectedAmountCents)}). Did the minimum change?
            </>
          ) : (
            <>
              <span className="font-medium">{r.debtName}</span> — expected {formatCents(r.expectedAmountCents)}, saw{" "}
              {formatCents(r.observedAmountCents)} instead. Did the minimum change?
            </>
          ),
        confirmLabel: "Yes, Update It",
        confirmToast: "Confirmed",
        onConfirm: () => confirmDebtAmountChanged(r.id),
        declineLabel: r.source === "EMAIL" ? "No, Leave It" : "No, Just a Payment",
        onDecline: () => declineDebtAmountChanged(r.id),
      }))}
    />
  );
}
