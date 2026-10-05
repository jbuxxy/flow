"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { dismissMinPaymentWarning } from "./actions";
import { showToast } from "@/lib/toast";
import { CollapsibleWarningCard, type CollapseControlProps } from "@/components/collapsible-warning-card";
import { CollapseOnExit } from "@/components/collapse-on-exit";
import type { InsufficientMinimumDebt } from "@/lib/debt-payoff";

// Surfaced regardless of the household's chosen payoff strategy — a minimum
// that doesn't cover its own interest is a data-quality signal (wrong
// minimum/APR on file, or a genuine "this needs extra payments" situation),
// not something tied to one simulation scenario. See
// debtsWithInsufficientMinimum in debt-payoff.ts.
export function MinPaymentWarning({
  debts,
  collapsed,
  onToggle,
}: { debts: InsufficientMinimumDebt[] } & CollapseControlProps) {
  // Two-stage removal so each dismissal animates out instead of popping:
  // `exiting` starts a row's collapse transition, `removed` unmounts it
  // once that finishes. The whole card collapses the same way once every
  // debt is on its way out — dismissing the last row shouldn't just blink
  // the card away, and (before this) an emptied card that lingered in the
  // dashboard warning carousel's slide list dragged the carousel's shared
  // height to zero and hid every other card until a manual refresh.
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [cardRemoved, setCardRemoved] = useState(false);
  const [, startTransition] = useTransition();

  const rows = debts.filter((d) => !removedIds.has(d.id));
  const allExiting = debts.every((d) => exitingIds.has(d.id) || removedIds.has(d.id));

  if (cardRemoved || rows.length === 0) return null;

  function dismiss(id: string) {
    setExitingIds((prev) => new Set(prev).add(id));
    startTransition(async () => {
      try {
        await dismissMinPaymentWarning(id);
        showToast("Dismissed");
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  return (
    <CollapseOnExit show={!allExiting} onExited={() => setCardRemoved(true)}>
      <CollapsibleWarningCard
        storageKey="min-payment"
        color="red"
        title="Minimum Payment Won't Cover Interest"
        collapsed={collapsed}
        onToggle={onToggle}
      >
        <p className="mt-1 text-xs text-neutral-900 dark:text-white">
          The balance on these will grow every month at the minimum payment on file — it doesn&apos;t even cover a
          month&apos;s interest. Double-check the minimum payment and APR in Account Settings, or plan on extra
          payments to actually make progress.
        </p>
        <ul className="mt-3 flex flex-col gap-1.5">
          {rows.map((d) => (
            <li key={d.id}>
              <CollapseOnExit
                show={!exitingIds.has(d.id)}
                onExited={() => setRemovedIds((prev) => new Set(prev).add(d.id))}
              >
                <div className="flex items-start justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-red-900 dark:text-red-200">{d.name}</span>
                  <span className="flex shrink-0 items-start gap-2">
                    <span className="text-xs text-neutral-900 dark:text-white">
                      {formatCents(d.minPaymentCents)} min &lt; {formatCents(d.monthlyInterestCents)} interest/mo
                    </span>
                    <button
                      type="button"
                      onClick={() => dismiss(d.id)}
                      aria-label={`Dismiss Warning for ${d.name}`}
                      title="Dismiss"
                      className="text-red-400 hover:text-red-700 dark:text-red-500 dark:hover:text-red-300"
                    >
                      <X size={14} />
                    </button>
                  </span>
                </div>
              </CollapseOnExit>
            </li>
          ))}
        </ul>
      </CollapsibleWarningCard>
    </CollapseOnExit>
  );
}
