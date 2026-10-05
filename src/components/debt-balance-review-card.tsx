"use client";

import { PartyPopper } from "lucide-react";
import { confirmDebtBalancePaidOff, declineDebtBalancePaidOff } from "@/app/debts/actions";
import { QuickConfirmCard } from "@/components/quick-confirm-card";
import type { PendingDebtBalanceReview } from "@/lib/debt-payments";

// Dashboard nudge for every manual REVOLVING debt whose auto-derived
// balance (interest accrual + matched payments, see matchDebtPayments in
// src/lib/debt-payments.ts) just hit $0 — same "propagate everywhere"
// placement as DebtAmountReviewCard, since resolving it can't wait on the
// household happening to visit /debts.
export function DebtBalanceReviewCard({ reviews }: { reviews: PendingDebtBalanceReview[] }) {
  return (
    <QuickConfirmCard
      icon={<PartyPopper size={18} className="animate-celebrate-lg shrink-0 text-amber-700 dark:text-amber-400" />}
      items={reviews.map((r) => ({
        id: r.id,
        text: (
          <>
            <span className="font-medium">{r.debtName}</span>&apos;s calculated balance just hit $0. Is it paid off?
          </>
        ),
        confirmLabel: "Yes, Paid Off",
        confirmToast: "Marked Paid Off",
        onConfirm: () => confirmDebtBalancePaidOff(r.id),
        declineLabel: "No, Different Balance",
        onDecline: () => declineDebtBalancePaidOff(r.id),
      }))}
    />
  );
}
