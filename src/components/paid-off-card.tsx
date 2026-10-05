"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { PartyPopper, X } from "lucide-react";
import { showToast } from "@/lib/toast";

export type PaidOffDebtData = { id: string; name: string };

export function PaidOffCard({ debts, onDismiss }: { debts: PaidOffDebtData[]; onDismiss: () => Promise<void> }) {
  const [hidden, setHidden] = useState(false);
  const [, startTransition] = useTransition();

  if (debts.length === 0 || hidden) return null;

  return (
    <div className="relative rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4">
      <button
        type="button"
        onClick={() => {
          setHidden(true);
          startTransition(async () => {
            try {
              await onDismiss();
              showToast("Dismissed");
            } catch {
              showToast("Something Went Wrong", "error");
            }
          });
        }}
        aria-label="Dismiss"
        title="Dismiss Until Next Week"
        className="absolute right-3 top-3 text-emerald-500 hover:text-emerald-800 dark:text-emerald-600 dark:hover:text-emerald-300"
      >
        <X size={16} />
      </button>

      <div className="mb-1 flex items-center gap-2 pr-6">
        <PartyPopper size={18} className="animate-celebrate-lg shrink-0 text-emerald-700 dark:text-emerald-400" />
        <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Paid Off This Week</h2>
      </div>
      {/* Pills, not a bulleted list — a week with 1-2 short debt names left
          a bulleted list narrow and tall with a lopsided void of empty
          space beside it before the footer link (real household report,
          2026-09-17). Pills wrap to use the row's actual width instead. */}
      <div className="flex flex-wrap gap-1.5">
        {debts.map((d) => (
          <span
            key={d.id}
            className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:text-emerald-300"
          >
            {d.name}
          </span>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Link href="/debts" className="text-sm text-emerald-800 dark:text-emerald-300 underline">
          View Debts
        </Link>
      </div>
    </div>
  );
}
