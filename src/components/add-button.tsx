"use client";

import { Plus } from "lucide-react";

// The consistent trigger for every "Add X" modal across the app (buckets,
// manual debts, assets, income, goals) — a small green circle up by the
// page title instead of a form sitting open (or behind a disclosure) at the
// bottom of the list, so "add something" reads the same way everywhere.
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600 dark:bg-emerald-700 text-white hover:bg-emerald-700 dark:hover:bg-emerald-500"
    >
      <Plus size={16} />
    </button>
  );
}
