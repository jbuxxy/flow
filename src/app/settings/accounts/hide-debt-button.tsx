"use client";

import { useTransition } from "react";
import { EyeOff } from "lucide-react";
import { hideDebt } from "@/app/debts/actions";
import { showToast } from "@/lib/toast";

// Confirm()-gated, same as the manual debt editor's own "Remove from View"
// button — this one used to fire on the first click with no confirmation at
// all (a plain `<form action={hideDebt.bind(...)}>` submit), unlike every
// other reversible-but-not-trivial action on this page (household request,
// 2026-09-23: hiding shouldn't be one misclick away just because the debt
// happens to be paid off already).
export function HideDebtButton({ debtId, debtName }: { debtId: string; debtName: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => {
        if (
          !confirm(
            `Remove "${debtName}" from view? This only hides the card, nothing is deleted — it can be permanently removed later from the cleanup section once hidden a year.`,
          )
        )
          return;
        startTransition(async () => {
          try {
            await hideDebt(debtId);
            showToast("Debt Hidden");
          } catch {
            showToast("Couldn’t Hide Debt", "error");
          }
        });
      }}
      disabled={pending}
      aria-label="Remove from View"
      title="Remove from View"
      className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
    >
      <EyeOff size={12} />
    </button>
  );
}
