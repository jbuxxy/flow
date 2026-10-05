"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { PartyPopper, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { showToast } from "@/lib/toast";
import { formatISODate } from "@/lib/date";

export type PaydayData = {
  key: string;
  name: string;
  amountCents: number;
  receivedDate: string; // ISO date
};

function formatShortDate(iso: string): string {
  return formatISODate(iso, { weekday: "short", month: "short", day: "numeric" });
}

// Dashboard "Payday" card — a tracked paycheck posted in the last few days.
// The upbeat mirror of PaidOffCard: same emerald celebration styling and
// dismiss-until-it-changes behaviour, keyed per paycheck so a second check
// landing this week brings it back.
export function PaydayCard({
  paydays,
  onDismiss,
}: {
  paydays: PaydayData[];
  onDismiss: () => Promise<void>;
}) {
  const [hidden, setHidden] = useState(false);
  const [, startTransition] = useTransition();

  if (paydays.length === 0 || hidden) return null;

  const totalCents = paydays.reduce((sum, p) => sum + p.amountCents, 0);

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
        title="Dismiss"
        className="absolute right-3 top-3 text-emerald-500 hover:text-emerald-800 dark:text-emerald-600 dark:hover:text-emerald-300"
      >
        <X size={16} />
      </button>

      <div className="mb-1 flex items-center gap-2 pr-6">
        <PartyPopper size={18} className="animate-celebrate-lg shrink-0 text-emerald-700 dark:text-emerald-400" />
        <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
          {paydays.length > 1 ? "Paydays" : "Payday"}
        </h2>
      </div>

      {paydays.length === 1 ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          {formatCents(paydays[0].amountCents)} from {paydays[0].name} landed {formatShortDate(paydays[0].receivedDate)}.
        </p>
      ) : (
        <>
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            {formatCents(totalCents)} landed across {paydays.length} paychecks:
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-sm text-emerald-700 dark:text-emerald-400">
            {paydays.map((p) => (
              <li key={p.key} className="flex items-center justify-between gap-2">
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 tabular-nums">
                  {formatCents(p.amountCents)} · {formatShortDate(p.receivedDate)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-3 flex justify-end">
        <Link href="/income" className="text-sm text-emerald-800 dark:text-emerald-300 underline">
          View Income
        </Link>
      </div>
    </div>
  );
}
