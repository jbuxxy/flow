import { Clock } from "lucide-react";

// SimpleFIN's "not settled yet" flag, shown as the same small amber clock
// everywhere a transaction is listed — /transactions, a bucket's Singles,
// and a bill/debt/pattern card's paid line — so a hold reads as one at a
// glance without expanding the row (household request, 2026-10-06: a
// pending Sam's Club charge on the Groceries bucket gave no hint of it).
export function PendingIcon({ size = 12 }: { size?: number }) {
  return (
    <span className="flex shrink-0" title="Pending">
      <Clock size={size} className="text-amber-700 dark:text-amber-400" aria-label="Pending" />
    </span>
  );
}
