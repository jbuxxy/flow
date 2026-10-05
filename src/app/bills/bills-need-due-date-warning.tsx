"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { dismissBillNeedsDueDateWarning } from "./actions";
import { showToast } from "@/lib/toast";
import { CollapsibleWarningCard, type CollapseControlProps } from "@/components/collapsible-warning-card";
import type { BillNeedingDueDate } from "@/lib/recurring-bills";

// Same card/dismiss pattern as NeedsSetupWarning (src/app/debts/) — a bill
// whose due date is still just the app's own approximation only ever fed a
// generic boolean AttentionLinkCard on the dashboard before ("Bills need a
// due date," no names), same gap the debts card had (2026-08-19 follow-up).
// Yellow, matching NeedsSetupWarning/UnlabeledP2PWarning — administrative,
// not urgent, so not the red reserved for the min-payment warning.
export function BillsNeedDueDateWarning({
  bills,
  collapsed,
  onToggle,
}: { bills: BillNeedingDueDate[] } & CollapseControlProps) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visible = bills.filter((b) => !dismissedIds.has(b.id));
  if (visible.length === 0) return null;

  function dismiss(id: string) {
    setDismissedIds((prev) => new Set(prev).add(id));
    startTransition(async () => {
      try {
        await dismissBillNeedsDueDateWarning(id);
        showToast("Dismissed");
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  return (
    <CollapsibleWarningCard
      storageKey="bills-need-due-date"
      color="yellow"
      title="Bills Need a Due Date"
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <p className="mt-1 text-xs text-neutral-900 dark:text-white">
        Confirm the real due date on these in Buckets — until then it&apos;s just the app&apos;s own guess.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {visible.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-yellow-900 dark:text-yellow-200">{b.name}</span>
            <button
              type="button"
              onClick={() => dismiss(b.id)}
              aria-label={`Dismiss Needs-Due-Date Warning for ${b.name}`}
              title="Dismiss"
              className="shrink-0 text-yellow-400 hover:text-yellow-700 dark:text-yellow-500 dark:hover:text-yellow-300"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </CollapsibleWarningCard>
  );
}
