import type { ReactNode } from "react";

// Canonical "label / big number / caption" card — the same
// `rounded-2xl border border-blue-100 dark:border-neutral-800 p-4` box used
// for the Buckets caps-vs-income, Income total, Net Worth, and bucket
// bills-total cards. Was hand-rolled independently in each spot with
// drifting number sizes (text-lg/2xl/3xl) before being unified here
// (2026-08-22) — always text-2xl now, matching what most of those callers
// already used.
export function StatCard({
  label,
  labelExtra,
  // Matches the app's existing 3-color card-header idiom (emerald for
  // money you have/receive — see ExpectedIncomeThisMonth/AdHocIncomeCard —
  // blue for planning/spend cards, both drawn from the brand palette in
  // WORKING_ON.md). Defaults to the brand blue rather than a neutral
  // gray/white, since every caller so far is one or the other, never truly
  // neutral.
  labelClassName = "text-blue-900 dark:text-blue-300",
  value,
  valueClassName = "text-blue-900 dark:text-blue-300",
  caption,
  children,
}: {
  label: ReactNode;
  labelExtra?: ReactNode;
  labelClassName?: string;
  value: ReactNode;
  valueClassName?: string;
  caption?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <h2 className={`flex items-center gap-1.5 text-sm font-semibold ${labelClassName}`}>
        {label}
        {labelExtra}
      </h2>
      <p className={`mt-1 text-2xl font-semibold ${valueClassName}`}>{value}</p>
      {caption}
      {children}
    </div>
  );
}
