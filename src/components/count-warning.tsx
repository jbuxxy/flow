"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { showToast } from "@/lib/toast";
import { CollapsibleWarningCard, type CollapseControlProps } from "@/components/collapsible-warning-card";

// A count-based warning card — one line of "N things need a look" instead
// of a per-item list (UnlabeledP2P activity, Uncategorized transactions) —
// same icon+heading/collapse shell as MinPaymentWarning/NeedsSetupWarning
// (src/app/debts/), which do list items individually. Dismissing isn't
// "stop telling me forever," just "I've seen this batch": the count this
// gets fed comes back to > 0 the moment something newer than the dismissal
// shows up (see getActiveUnlabeledP2PTransfers/getActiveUncategorizedCount
// for the two current callers' own "newer than" definitions).
// Yellow — red is reserved for the min-payment-won't-cover-interest
// warning (min-payment-warning.tsx), the one signal that's actually costing
// the household money; these are filing tasks, not urgent.
export function CountWarning({
  count,
  title,
  subtitle,
  href,
  linkLabel,
  storageKey,
  dismiss,
  collapsed,
  onToggle,
}: {
  count: number;
  title: string;
  subtitle: string;
  href: string;
  linkLabel: string;
  // Per rendered instance, not per card type (unlike NeedsSetupWarning/
  // MinPaymentWarning's shared, type-wide key) — this component gets reused
  // for genuinely different data across pages (P2P debit vs. credit vs.
  // combined, uncategorized transactions, ...), so each caller passes its
  // own to collapse independently.
  storageKey: string;
  dismiss: () => Promise<void>;
} & CollapseControlProps) {
  const [dismissed, setDismissed] = useState(false);
  const [, startTransition] = useTransition();

  if (dismissed || count === 0) return null;

  return (
    <CollapsibleWarningCard storageKey={storageKey} color="yellow" title={title} collapsed={collapsed} onToggle={onToggle}>
      <p className="mt-1 text-xs text-neutral-900 dark:text-white">{subtitle}</p>
      <div className="mt-3 flex items-center justify-end gap-4">
        <Link href={href} className="text-xs font-medium text-yellow-800 dark:text-yellow-300 underline underline-offset-2">
          {linkLabel}
        </Link>
        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            startTransition(async () => {
              try {
                await dismiss();
                showToast("Dismissed");
              } catch {
                showToast("Something Went Wrong", "error");
              }
            });
          }}
          aria-label="Dismiss"
          title="Dismiss"
          className="text-yellow-400 hover:text-yellow-700 dark:text-yellow-500 dark:hover:text-yellow-300"
        >
          <X size={14} />
        </button>
      </div>
    </CollapsibleWarningCard>
  );
}
