"use client";

import { PartyPopper } from "lucide-react";
import { formatCents } from "@/lib/money";
import { EntryLine } from "@/components/entry-line";
import type { CyclePaymentLine } from "@/lib/debt-payoff";

// Read-only projection of one predictive cycle (this cycle + 1, this cycle +
// 2) for a single debt — the balance at the moment the cycle starts, then
// every minimum/extra line landing in it, in date order. Unlike DebtRow's
// ledger (real payments, checkable minimum), nothing here has happened yet,
// so there's no drag handle, mark-paid button, or account-link suggestion —
// just the plan.
export function PayoffCycleCard({
  name,
  attackOrderIndex,
  startBalanceCents,
  endBalanceCents,
  lines,
}: {
  name: string;
  attackOrderIndex: number | null;
  startBalanceCents: number;
  endBalanceCents: number;
  lines: CyclePaymentLine[];
}) {
  const projectedPaidOff = endBalanceCents === 0 && startBalanceCents > 0;
  const sortedLines = [...lines].sort((a, b) => a.date.getTime() - b.date.getTime());

  return (
    <li
      className={`relative rounded-xl border p-4 ${
        attackOrderIndex !== null
          ? "border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20"
          : "border-blue-100 dark:border-neutral-800"
      }`}
    >
      {/* Same corner badge as DebtRow on "This Month" so the priority number
          reads identically across the two views. */}
      {attackOrderIndex !== null && (
        <span className="font-comfortaa absolute -top-2 -left-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-900 dark:bg-blue-700 text-base text-white ring-2 ring-white dark:ring-neutral-950">
          {attackOrderIndex + 1}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-neutral-900 dark:text-neutral-100">{name}</p>
        <p className="font-medium">{formatCents(startBalanceCents)}</p>
      </div>

      {projectedPaidOff && (
        <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          <PartyPopper size={13} className="animate-celebrate" /> Projected Paid Off This Month
        </p>
      )}

      {sortedLines.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5 border-t border-blue-100 dark:border-neutral-800 pt-2 text-xs">
          {sortedLines.map((line, i) =>
            line.kind === "minimum" ? (
              // A projected cycle — nothing is overdue, so the date stays
              // neutral (no dueDateProximity colouring here).
              <EntryLine key={i} state="due" date={line.date} amountCents={line.amountCents} />
            ) : (
              // Same all-green "extra" styling as DebtRow's projected extra
              // rows — one line per paycheck, not split by source (household
              // request, 2026-09-01); hovering the icon shows the same
              // "Rolled From X" breakdown the calendar-view popover shows.
              <EntryLine
                key={i}
                state="expected"
                date={line.date}
                amountCents={line.amountCents}
                payoff={line.isPayoff}
                poolBreakdown={line.poolBreakdown}
              />
            ),
          )}
        </ul>
      )}
    </li>
  );
}
