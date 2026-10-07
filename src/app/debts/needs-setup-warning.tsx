"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { dismissNeedsSetupWarning } from "./actions";
import { showToast } from "@/lib/toast";
import { CollapsibleWarningCard, type CollapseControlProps } from "@/components/collapsible-warning-card";
import type { DebtNeedingSetup } from "@/lib/debt-payments";

// Same card/dismiss pattern as MinPaymentWarning (min-payment-warning.tsx) —
// a debt missing terms/due date/etc. only ever showed as a small per-row
// pill before (debt-row.tsx, settings/accounts/page.tsx), easy to miss
// entirely when the actual "why does my profile have a red dot" question
// starts from Settings, not a specific debt row (real report, 2026-08-19).
// Yellow, not red (2026-08-19 follow-up, tuned from an initial amber that
// read too close to red) — red is reserved for the min-payment-won't-
// cover-interest warning, which is actually losing the household money; a
// missing due date/APR is administrative, not urgent.
export function NeedsSetupWarning({
  debts,
  collapsed,
  onToggle,
}: { debts: DebtNeedingSetup[] } & CollapseControlProps) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visible = debts.filter((d) => !dismissedIds.has(d.id));
  if (visible.length === 0) return null;

  function dismiss(id: string) {
    setDismissedIds((prev) => new Set(prev).add(id));
    startTransition(async () => {
      try {
        await dismissNeedsSetupWarning(id);
        showToast("Dismissed");
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  return (
    <CollapsibleWarningCard
      storageKey="needs-setup"
      color="yellow"
      title="Debts Need Setup"
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <p className="mt-1 text-xs text-neutral-900 dark:text-white">
        Edit these in{" "}
        <Link href="/settings/accounts" className="underline underline-offset-2">
          Account Settings
        </Link>{" "}
        to fill in what&apos;s missing.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {visible.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
            {/* Name and reason wrap together as one group (flex-wrap) so the
                dismiss button never gets crowded against the reason text on
                narrow screens — the reason used to run right up against the
                X as plain text, reading as one garbled fragment (real
                report, 2026-09-28). The reason is now its own pill, same
                "Needs Setup" badge treatment as the per-row link on
                debts/debt-row.tsx, so it reads as a distinct status rather
                than a trailing word. */}
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-yellow-900 dark:text-yellow-200">{d.name}</span>
              <span className="shrink-0 rounded-full bg-yellow-100 dark:bg-yellow-900/40 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:text-yellow-200">
                {d.reason}
              </span>
            </span>
            <button
              type="button"
              onClick={() => dismiss(d.id)}
              aria-label={`Dismiss Needs-Setup Warning for ${d.name}`}
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
