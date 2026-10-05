"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { CollapsibleWarningCard, type CollapseControlProps } from "@/components/collapsible-warning-card";
import { showToast } from "@/lib/toast";

// Generic list-style warning card for any dashboard array of named items,
// each dismissible individually. For a suggestion that already carries its
// own dismiss action elsewhere (BnplSuggestion/BillSuggestion/
// IncomeSuggestion, keyed by `.key`) the caller passes that same action in
// — reused directly instead of inventing a parallel dashboard-only
// dismissal, so dismissing here and dismissing from the real page
// (Buckets/Debts/Income) stay in sync; they're the same SuggestionDismissal
// row. For an item with no existing per-row dismiss (untracked liability
// accounts, stale assets — identified by `.id`), the caller passes a new
// dashboard-only snooze instead (2026-08-20).
// items carry their own bound dismiss action (built with the real "use
// server" action's .bind on the server side) rather than generic
// getKey/getLabel/dismiss(item) mapper props — a plain closure defined in a
// Server Component can't cross into a Client Component (only a real Server
// Action reference can), so the caller pre-normalizes each item into this
// shape instead of this component calling arbitrary functions on raw T.
export function SuggestionListWarning({
  items,
  title,
  subtitle,
  href,
  linkLabel,
  storageKey,
  collapsed,
  onToggle,
}: {
  items: { key: string; label: string; dismiss: () => Promise<void> }[];
  title: string;
  subtitle?: string;
  // Where "act on this" actually happens — dismissing here is just
  // "ignore," not "accept," so a link to the real page is what makes the
  // card useful, not just a decoration.
  href: string;
  linkLabel: string;
  storageKey: string;
} & CollapseControlProps) {
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visible = items.filter((item) => !dismissedKeys.has(item.key));
  if (visible.length === 0) return null;

  function dismissItem(item: (typeof items)[number]) {
    setDismissedKeys((prev) => new Set(prev).add(item.key));
    startTransition(async () => {
      try {
        await item.dismiss();
        showToast("Dismissed");
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  return (
    <CollapsibleWarningCard storageKey={storageKey} color="yellow" title={title} collapsed={collapsed} onToggle={onToggle}>
      {subtitle && <p className="mt-1 text-xs text-neutral-900 dark:text-white">{subtitle}</p>}
      <ul className="mt-3 flex flex-col gap-1.5">
        {visible.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-yellow-900 dark:text-yellow-200">{item.label}</span>
            <button
              type="button"
              onClick={() => dismissItem(item)}
              aria-label={`Dismiss: ${item.label}`}
              title="Dismiss"
              className="shrink-0 text-yellow-400 hover:text-yellow-700 dark:text-yellow-500 dark:hover:text-yellow-300"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end">
        <Link
          href={href}
          className="text-xs font-medium text-yellow-800 dark:text-yellow-300 underline underline-offset-2"
        >
          {linkLabel}
        </Link>
      </div>
    </CollapsibleWarningCard>
  );
}
