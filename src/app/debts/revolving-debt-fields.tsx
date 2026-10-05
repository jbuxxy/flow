"use client";

import { useState } from "react";
import { MoneyInput } from "@/components/money-input";
import { PercentInput } from "@/components/percent-input";

// The Balance/APR/Min-payment/optional-first-due-date field set for a
// REVOLVING (Card/Loan) debt — shared by AddDebtForm's own modal and
// AddDebtModal (src/app/buckets/[id]/add-debt-modal.tsx), the quick-add-from-
// a-transaction flow, so both call the exact same createDebt action with the
// exact same fields.
//
// First due date is a full calendar date, not a bare day-of-month
// (2026-08-30): whatever date the household picks IS the first cycle. Nothing
// before it is treated as a missed payment — a card added today with a due
// date next month simply starts next month. createDebt derives the recurring
// day-of-month from it and rolls it forward to the next occurrence if the
// date entered is already in the past.
export function RevolvingDebtFields({
  // Hidden when embedded in AddDebtModal — that flow always creates the
  // transaction's own DebtPayment immediately after via the surrounding
  // TrackAsBillForm submit, and asking for a due date here too would race
  // createDebtPaymentFromTransaction into a false "already has a tracked
  // payment" rejection the moment both tried to create one.
  showDueDay = true,
}: {
  showDueDay?: boolean;
}) {
  const [dueDate, setDueDate] = useState("");

  return (
    <div className="flex flex-col gap-2">
      {/* Balance on its own row, APR/Min below it — three fields side
          by side (the old layout) didn't fit a phone-width modal
          without horizontal scrolling (real report, 2026-08-17). */}
      <MoneyInput
        name="balance"
        placeholder="Balance $"
        required
        className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
      />
      <div className="flex gap-2">
        <PercentInput
          name="apr"
          placeholder="APR %"
          required
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
        />
        <MoneyInput
          name="minPayment"
          placeholder="Min $/mo"
          required
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
        />
      </div>
      {showDueDay && (
        <label className="flex flex-col gap-1 text-sm font-medium text-emerald-700 dark:text-emerald-400 font-comfortaa">
          First Due Date <span className="font-sans font-normal text-gray-500 dark:text-neutral-400">— optional, starts tracking the monthly payment</span>
          <input
            type="date"
            name="dueDate"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-sans font-normal focus:border-blue-900 focus:outline-none"
          />
        </label>
      )}
    </div>
  );
}
