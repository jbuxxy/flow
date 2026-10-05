import { formatResultCount } from "@/lib/result-count-format";

// The "12 of 340 Transactions" line above a filterable list. It's an aria-live
// region, so when the page re-renders after a filter/search/sort change the new
// count is announced — that's the whole a11y-announcement mechanism, no
// separate visually-hidden node.
export function ResultCount({
  count,
  noun,
  total,
  className = "",
}: {
  count: number;
  noun?: string;
  total?: number;
  className?: string;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`text-sm text-gray-500 dark:text-neutral-400 ${className}`}
    >
      {formatResultCount(count, { noun, total })}
    </p>
  );
}
