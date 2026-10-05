"use client";

import Link from "next/link";
import { SlidersHorizontal, X } from "lucide-react";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

// Dashboard prompt shown only while a BudgetPlan is PENDING (see
// getPendingBudgetPlan). Authoritative "handled" state is BudgetPlan.status —
// the localStorage flag here is just a per-viewer "hide it for now" that
// naturally resets next month (keyed on periodKey).
//
// Rendered full content-width at the top of the dashboard (not inside the
// capped `lg:max-w-3xl` alert stack) — it's the primary "new month" call to
// action, so at `sm:`+ it lays out horizontally: text block left, button
// right, vertically centred, instead of a lonely bottom-right button under a
// short line of copy on a wide row.
export function SetTheMonthBanner({ month, periodKey }: { month: string; periodKey: string }) {
  const [hidden, setHidden] = useStoredBoolean(`set-month-banner:${periodKey}`);
  if (hidden) return null;

  return (
    <div className="relative rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-blue-50 dark:from-emerald-950/40 dark:to-blue-950/30 p-4 sm:pr-12">
      <button
        type="button"
        onClick={() => setHidden(true)}
        aria-label="Hide until next month"
        title="Hide until next month"
        className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
      >
        <X size={16} />
      </button>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="shrink-0 text-emerald-700 dark:text-emerald-400" />
            <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Set Your {month} Budget</h2>
          </div>
          <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
            We drafted an allocation from your recent spending, goals, and payoff plan. Review the sliders and confirm.
          </p>
        </div>
        <Link
          href="/budget"
          className="shrink-0 self-end rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2 text-sm font-medium text-white sm:self-auto"
        >
          Review Budget →
        </Link>
      </div>
    </div>
  );
}
