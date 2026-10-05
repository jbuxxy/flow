"use client";

import type { ReactNode } from "react";
import { useState, useTransition } from "react";
import { showToast } from "@/lib/toast";

export type QuickConfirmItem = {
  id: string;
  text: ReactNode;
  confirmLabel: string;
  // What the confirm toast says on success — decline is always "Dismissed"
  // (every existing caller already used that word for it).
  confirmToast: string;
  onConfirm: () => Promise<void>;
  declineLabel: string;
  onDecline: () => Promise<void>;
};

function ConfirmRow({ item, onGone }: { item: QuickConfirmItem; onGone: () => void }) {
  const [pending, startTransition] = useTransition();

  return (
    <li className="flex flex-col gap-2 text-sm">
      <p className="text-neutral-800 dark:text-neutral-200">{item.text}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={() =>
            startTransition(async () => {
              await item.onConfirm();
              onGone();
              showToast(item.confirmToast);
            })
          }
          disabled={pending}
          className="rounded-lg bg-amber-700 dark:bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {item.confirmLabel}
        </button>
        <button
          onClick={() =>
            startTransition(async () => {
              await item.onDecline();
              onGone();
              showToast("Dismissed");
            })
          }
          disabled={pending}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 disabled:opacity-50"
        >
          {item.declineLabel}
        </button>
      </div>
    </li>
  );
}

// Shared shell for every dashboard "needs a quick confirm" nudge —
// DebtAmountReviewCard, DebtBalanceReviewCard, and PatternPaymentReviewCard
// each reimplemented the identical "amber rounded-2xl card / icon + 'Needs a
// Quick Confirm' heading / <ul> of confirm-decline rows / useTransition +
// gone-state per row" shell, differing only in their icon and per-item
// text/labels/handlers (2026-09-12 code review finding — same convergence
// this diff already did for the seven *-usage-synopsis.tsx files via
// usage-synopsis.tsx). Each caller builds its own QuickConfirmItem[] from
// its own review list and renders this once.
export function QuickConfirmCard({ icon, items }: { icon: ReactNode; items: QuickConfirmItem[] }) {
  // Lifted here (rather than each row just hiding itself) so the whole card
  // — not just its rows — disappears the moment the last item resolves.
  // Rows used to track their own "gone" state in isolation, which left an
  // empty amber shell (icon + heading, no rows) standing in the dashboard's
  // grid until the next full server round-trip re-evaluated `items` — and
  // in the desktop grid that shell doesn't collapse via CSS `empty:hidden`
  // either, since it still has element children, so it kept stealing a
  // column from the cards next to it instead of the grid reflowing.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const visible = items.filter((item) => !dismissedIds.has(item.id));
  if (visible.length === 0) return null;

  return (
    <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">Needs a Quick Confirm</h2>
      </div>
      <ul className="flex flex-col gap-3">
        {visible.map((item) => (
          <ConfirmRow
            key={item.id}
            item={item}
            onGone={() => setDismissedIds((prev) => new Set(prev).add(item.id))}
          />
        ))}
      </ul>
    </div>
  );
}
