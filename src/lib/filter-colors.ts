// Fixed Tailwind-class palette for the bucket page's in-page spend filters
// (see src/components/bucket-entry-filter.tsx). Same hue order as
// src/lib/chart-colors.ts (blue/orange/emerald/amber/violet, then the extra
// LINE_SERIES_COLORS hues) so a selected filter chip reads the same as every
// other categorical color in the app. Classes are spelled out literally —
// Tailwind's scanner can't see an interpolated `bg-${hue}-500`.
//
// `dot`        — small swatch shown next to a selected chip / entry badge
// `bar`        — the entry card's left edge, applied only when 2+ values are
//                selected (a single selection just filters, no recolor).
//                Marked `!important` (trailing `!`) because every entry card
//                already composes its own `border …-100` utility for the full
//                border, which would otherwise win the left side by emit order.
// `chipActive` — selected-chip / entry-badge background + text
export type FilterColor = { dot: string; bar: string; chipActive: string };

const FILTER_COLORS: FilterColor[] = [
  { dot: "bg-blue-500", bar: "border-l-blue-500!", chipActive: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300" },
  { dot: "bg-orange-500", bar: "border-l-orange-500!", chipActive: "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300" },
  { dot: "bg-emerald-500", bar: "border-l-emerald-500!", chipActive: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" },
  { dot: "bg-amber-500", bar: "border-l-amber-500!", chipActive: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  { dot: "bg-violet-500", bar: "border-l-violet-500!", chipActive: "bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300" },
  { dot: "bg-pink-500", bar: "border-l-pink-500!", chipActive: "bg-pink-100 text-pink-800 dark:bg-pink-950/50 dark:text-pink-300" },
  { dot: "bg-teal-500", bar: "border-l-teal-500!", chipActive: "bg-teal-100 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300" },
  { dot: "bg-red-500", bar: "border-l-red-500!", chipActive: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300" },
  { dot: "bg-indigo-500", bar: "border-l-indigo-500!", chipActive: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300" },
  { dot: "bg-lime-500", bar: "border-l-lime-500!", chipActive: "bg-lime-100 text-lime-800 dark:bg-lime-950/50 dark:text-lime-300" },
];

// A list with more distinct values than slots cycles rather than running out.
export function filterColor(index: number): FilterColor {
  return FILTER_COLORS[((index % FILTER_COLORS.length) + FILTER_COLORS.length) % FILTER_COLORS.length];
}
