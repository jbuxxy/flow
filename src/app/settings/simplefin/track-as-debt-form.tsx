"use client";

import { useActionState, useState } from "react";
import { Plus, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { trackAccountAsDebt, type TrackAccountState } from "@/app/debts/actions";
import { InlineSaveButton } from "@/components/inline-save-button";
import { useActionToast } from "@/lib/use-action-toast";
import { MoneyInput } from "@/components/money-input";
import { PercentInput } from "@/components/percent-input";
import { DayOfMonthPicker } from "@/components/day-of-month-picker";

const initialState: TrackAccountState = {};

// Moved from /debts' "Connected but not tracked" section (2026-08-15
// account-settings consolidation) — start tracking a synced CREDIT_CARD/
// LOAN account as a payoff-calculator Debt, right from its own row here.
// Balance/name already come from the sync; this only needs what SimpleFIN
// doesn't provide — APR, minimum payment, and (optionally) a due date.
export function TrackAsDebtForm({
  accountId,
  balanceCents,
  knownMinPaymentCents,
}: {
  accountId: string;
  balanceCents: number;
  knownMinPaymentCents?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tracked, setTracked] = useState(false);
  const [dueDay, setDueDay] = useState("");
  const trackWithId = trackAccountAsDebt.bind(null, accountId);
  const [state, formAction, pending] = useActionState(trackWithId, initialState);
  const { justSaved } = useActionToast(pending, state, { success: "Now Tracking as Debt" });

  if (tracked) return null;

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-label={expanded ? "Cancel Tracking as Debt" : "Track as Debt"}
        title={expanded ? "Cancel" : "Track as Debt"}
        className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 underline"
      >
        {expanded ? <X size={12} /> : <Plus size={12} />}
        {expanded ? "Cancel" : "Not Tracked — Track It"}
      </button>

      {expanded && (
        <form
          action={(formData) => {
            formAction(formData);
            setTracked(true);
          }}
          className="mt-2 flex flex-col gap-1.5"
        >
          <span className="text-xs text-gray-500 dark:text-neutral-400">
            Balance ({formatCents(Math.abs(balanceCents))}) syncs automatically — just need:
          </span>
          {/* APR/Min + Due date on separate rows — all three side by side
              (the old layout, plus a fixed-width native date input) didn't
              fit this form's own narrow width, nested inside an account
              row (real report, 2026-08-17). */}
          <div className="flex items-center gap-2">
            <PercentInput
              name="apr"
              placeholder="APR %"
              required
              className="w-20 shrink-0 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
            />
            <MoneyInput
              name="minPayment"
              placeholder="Min $/mo"
              defaultCents={knownMinPaymentCents}
              required
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
            />
          </div>
          <DayOfMonthPicker
            name="dueDay"
            value={dueDay}
            onChange={setDueDay}
            placeholder="Due — day of month (optional)"
            small
          />
          {knownMinPaymentCents !== undefined && (
            <p className="text-xs text-blue-800 dark:text-blue-400">
              Min $/mo pre-filled from a tracked bill for this lender — edit it if that&apos;s wrong.
            </p>
          )}
          <InlineSaveButton pending={pending} justSaved={justSaved} tone="emerald">
            {state.error && <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>}
          </InlineSaveButton>
        </form>
      )}
    </div>
  );
}
