"use client";

import { formatCents } from "@/lib/money";
import { filterColor } from "@/lib/filter-colors";
import { useBucketEntryFilter, type FilterDim } from "@/components/bucket-entry-filter";

// The interactive body of a spend-breakdown slide (see bucket-spend-breakdown.tsx
// for the server-side card assembly). A row toggles itself as a filter on the
// bucket page's entry cards via BucketEntryFilterProvider — but only if some
// entry below actually carries that category/merchant (`filterable`). A row
// that doesn't (e.g. spend attributed to a category that lives in another
// bucket, so nothing on this page matches it) still shows for the breakdown
// but isn't a button — clicking it would only ever yield an empty list.
// A selected row stays in the list so it can be toggled back off; when 2+ rows
// in the same dimension are selected each gets its palette color (dot + the
// entry cards' left edge).
export function BreakdownList({
  dim,
  entries,
  filterable,
  // Wedge color per entry (same index order), and the shared donut-hover
  // channel — a row highlights its wedge on hover/focus and vice versa. All
  // three are passed together by BucketSpendBreakdownBody; omitted elsewhere.
  segmentColors,
  activeLabel = null,
  onActiveLabelChange,
}: {
  dim: FilterDim;
  entries: { label: string; cents: number; excludedCents?: number }[];
  filterable: string[];
  segmentColors?: string[];
  activeLabel?: string | null;
  onActiveLabelChange?: (label: string | null) => void;
}) {
  const { toggle, isSelected, colorIndexOf, state } = useBucketEntryFilter();
  const showColors = state.dim === dim && state.values.length >= 2;

  return (
    <ul className="mt-3 flex flex-col border-t border-blue-100 dark:border-neutral-800 pt-3">
      {entries.map((c, idx) => {
        const canFilter = filterable.includes(c.label);
        const selected = canFilter && isSelected(dim, c.label);
        const color = filterColor(colorIndexOf(dim, c.label));
        const highlighted = activeLabel === c.label;
        const dotClass = selected && showColors ? color.dot : segmentColors?.[idx];
        const hoverProps = onActiveLabelChange
          ? {
              onMouseEnter: () => onActiveLabelChange(c.label),
              onMouseLeave: () => onActiveLabelChange(null),
              onFocus: () => onActiveLabelChange(c.label),
              onBlur: () => onActiveLabelChange(null),
            }
          : {};
        const amount = <span className="shrink-0 font-medium text-neutral-800 dark:text-neutral-200">{formatCents(c.cents)}</span>;
        const name = (
          <span className="flex min-w-0 items-center gap-1.5">
            {dotClass && <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden />}
            <span className={`line-clamp-1 ${selected ? "font-medium" : "text-gray-600 dark:text-neutral-400"}`}>{c.label}</span>
          </span>
        );

        return (
          <li key={c.label}>
            {canFilter ? (
              <button
                type="button"
                onClick={() => toggle(dim, c.label)}
                aria-pressed={selected}
                {...hoverProps}
                className={`-mx-2 flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm transition-colors ${
                  selected
                    ? color.chipActive
                    : highlighted
                      ? "bg-blue-50 dark:bg-neutral-800/60"
                      : "hover:bg-blue-50/60 dark:hover:bg-neutral-800/60"
                }`}
              >
                {name}
                {amount}
              </button>
            ) : (
              // Same box geometry as the button branch (-mx-2/px-2/w-full) so
              // a non-filterable row's label and amount line up with the
              // filterable ones instead of sitting 8px inset on each side.
              <div
                {...hoverProps}
                className={`-mx-2 flex w-full items-center justify-between gap-2 px-2 py-1.5 text-sm transition-colors ${
                  highlighted ? "bg-blue-50 dark:bg-neutral-800/60" : ""
                }`}
              >
                {name}
                {amount}
              </div>
            )}
            {c.excludedCents ? (
              // Part of this row's total is extra debt paydown past the
              // cycle's minimum + planned payoff extra — it's real spend
              // (shown here) but deliberately kept out of the bucket total /
              // pace / alerts.
              <p className="px-2 pb-1 text-xs text-gray-400 dark:text-neutral-500">
                Incl. {formatCents(c.excludedCents)} Extra Debt Paydown — Not Counted In Bucket Total
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
