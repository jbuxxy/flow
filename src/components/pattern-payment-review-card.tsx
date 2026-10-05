"use client";

import { HelpCircle } from "lucide-react";
import { formatCents } from "@/lib/money";
import { confirmPatternPaymentReview, declinePatternPaymentReview } from "@/app/transactions/actions";
import { QuickConfirmCard } from "@/components/quick-confirm-card";
import type { PendingPatternPaymentReview } from "@/lib/pattern-payments";

// Dashboard nudge for every pending "does this count as this cycle's
// payment?" question (see matchPatternPayments, src/lib/pattern-payments.ts)
// — same shape/precedent as DebtAmountReviewCard, just for a scheduled
// RecurringPattern (P2P recurring) instead of a debt tracker.
export function PatternPaymentReviewCard({ reviews }: { reviews: PendingPatternPaymentReview[] }) {
  return (
    <QuickConfirmCard
      icon={<HelpCircle size={18} className="shrink-0 text-amber-700 dark:text-amber-400" />}
      items={reviews.map((r) => ({
        id: r.id,
        text: (
          <>
            <span className="font-medium">{r.patternLabel}</span> — expected around{" "}
            {formatCents(r.expectedAmountCents)}, saw {formatCents(r.observedAmountCents)} instead. Does this count
            as this cycle&apos;s payment?
          </>
        ),
        confirmLabel: "Yes, This Counts",
        confirmToast: "Confirmed",
        onConfirm: () => confirmPatternPaymentReview(r.id),
        declineLabel: "No, Just a Payment",
        onDecline: () => declinePatternPaymentReview(r.id),
      }))}
    />
  );
}
