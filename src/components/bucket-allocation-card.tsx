"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatDollars } from "@/lib/money";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

type AllocBucket = {
  id: string;
  name: string;
  monthlyCapCents: number;
  trackingMode: "SPEND" | "RECURRING" | "MIXED";
  onPaceToOvershoot: boolean;
};

const STORAGE_KEY = "flow:buckets:allocation-breakdown-expanded";

// Cycled segment fills — a calm multi-hue set that holds up in both themes.
// Order matters: the biggest buckets get the first, most-saturated hues.
const SEGMENT_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-lime-500",
  "bg-orange-500",
  "bg-teal-500",
  "bg-fuchsia-500",
  "bg-indigo-500",
  "bg-pink-500",
];

// Anything under a dollar either way is rounding dust, not an over/under.
const SLOP_CENTS = 100;

export function BucketAllocationCard({
  buckets,
  incomeCents,
  isEstimated,
}: {
  buckets: AllocBucket[];
  incomeCents: number;
  isEstimated: boolean;
}) {
  const [expanded, setExpanded] = useStoredBoolean(STORAGE_KEY, false);
  const [grown, setGrown] = useState(false);
  // Grow on mount, not on first expand — the collapsed desktop mini bar
  // uses the same widths, so it needs them while collapsed too.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const totalAllocatedCents = buckets.reduce((sum, b) => sum + b.monthlyCapCents, 0);
  const remainingCents = incomeCents - totalAllocatedCents;
  const overAllocated = remainingCents <= -SLOP_CENTS;
  const underAllocated = remainingCents >= SLOP_CENTS;
  const overPaceCount = buckets.filter((b) => b.onPaceToOvershoot).length;
  const pctOfIncomeAllocated = incomeCents > 0 ? Math.round((totalAllocatedCents / incomeCents) * 100) : 0;

  // The bar spans whichever is larger so both the "money left over" gap and
  // the "past what income covers" overflow are visible on the same scale.
  const denomCents = Math.max(totalAllocatedCents, incomeCents, 1);
  const incomeMarkerPct = (incomeCents / denomCents) * 100;

  const ordered = [...buckets].sort((a, b) => b.monthlyCapCents - a.monthlyCapCents);
  const segments = ordered.map((b, i) => ({
    ...b,
    color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
    widthPct: (b.monthlyCapCents / denomCents) * 100,
  }));

  // Recurring/bill dollars vs flexible-spend dollars.
  const recurringCents = buckets
    .filter((b) => b.trackingMode !== "SPEND")
    .reduce((sum, b) => sum + b.monthlyCapCents, 0);
  const flexibleCents = totalAllocatedCents - recurringCents;
  const recurringPct = totalAllocatedCents > 0 ? (recurringCents / totalAllocatedCents) * 100 : 0;

  return (
    <div className={`rounded-2xl border border-blue-100 dark:border-neutral-800 p-4 ${!expanded ? "lg:py-3" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={`flex w-full items-start justify-between gap-3 text-left ${!expanded ? "lg:items-center" : ""}`}
      >
        <div className={!expanded ? "lg:flex lg:shrink-0 lg:flex-wrap lg:items-baseline lg:gap-x-2.5" : ""}>
          <h2
            className={`text-base font-semibold text-emerald-700 dark:text-emerald-400 ${
              !expanded ? "lg:text-sm" : ""
            }`}
          >
            Bucket Caps vs. Monthly Income
          </h2>
          <p
            className={`mt-1 text-2xl font-semibold text-blue-900 dark:text-blue-300 ${
              !expanded ? "lg:mt-0 lg:text-base" : ""
            }`}
          >
            {formatDollars(totalAllocatedCents)}{" "}
            <span className={`text-sm font-normal text-gray-500 dark:text-neutral-400 ${!expanded ? "lg:text-xs" : ""}`}>
              allocated of
            </span>{" "}
            {formatDollars(incomeCents)}
          </p>
          {(overAllocated || underAllocated) && (
            <p
              className={`mt-0.5 text-xs ${!expanded ? "lg:hidden" : ""} ${
                overAllocated
                  ? "font-medium text-red-600 dark:text-red-400"
                  : "text-gray-500 dark:text-neutral-400"
              }`}
            >
              {overAllocated
                ? `${formatDollars(-remainingCents)} over income`
                : `${formatDollars(remainingCents)} left to allocate`}
            </p>
          )}
        </div>

        {/* Desktop-only collapsed mini bar — the same per-bucket segments as
            the expanded stacked bar, no legend, filling the gap between the
            headline and the summary (same "small picture of the expanded
            view" idea as /debts' Projected Payoff sparkline). */}
        {!expanded && (
          <div className="hidden lg:block lg:min-w-0 lg:flex-1 lg:px-2">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-blue-50 dark:bg-neutral-800">
              {segments.map((s, i) => (
                <div
                  key={s.id}
                  title={`${s.name}: ${formatDollars(s.monthlyCapCents)}`}
                  className={`${s.color} h-full`}
                  style={{
                    width: grown ? `${s.widthPct}%` : "0%",
                    transition: `width 600ms ease-out ${i * 40}ms`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Desktop-only collapsed summary — spreads the headline numbers
            across the row instead of leaving a gap before the chevron
            (hidden on mobile so it doesn't touch that layout, and dropped
            entirely when expanded since the stat grid below repeats it). */}
        {!expanded && (
          <div className="hidden lg:flex lg:items-center lg:gap-5 text-xs text-gray-500 dark:text-neutral-400">
            {(overAllocated || underAllocated) && (
              <span className={overAllocated ? "font-medium text-red-600 dark:text-red-400" : ""}>
                {overAllocated
                  ? `${formatDollars(-remainingCents)} Over Income`
                  : `${formatDollars(remainingCents)} Left To Allocate`}
              </span>
            )}
            <span>{pctOfIncomeAllocated}% Allocated</span>
            {overPaceCount > 0 && (
              <span className="font-medium text-amber-700 dark:text-amber-400">{overPaceCount} Over Pace</span>
            )}
          </div>
        )}

        <ChevronDown
          size={18}
          className={`mt-1 shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${
            expanded ? "rotate-180" : ""
          } ${!expanded ? "lg:mt-0" : ""}`}
        />
      </button>

      {isEstimated && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-neutral-400">
          Estimated from your synced deposits — confirm it on{" "}
          <Link href="/income" className="underline">
            Income
          </Link>
          .
        </p>
      )}

      {expanded && (
        <div className="mt-3 flex flex-col gap-4">
          {/* Stacked bar — one segment per bucket, widest first. */}
          <div>
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-blue-50 dark:bg-neutral-800">
              <div className="flex h-full w-full">
                {segments.map((s, i) => (
                  <div
                    key={s.id}
                    title={`${s.name}: ${formatDollars(s.monthlyCapCents)}`}
                    className={`${s.color} h-full`}
                    style={{
                      width: grown ? `${s.widthPct}%` : "0%",
                      transition: `width 600ms ease-out ${i * 40}ms`,
                    }}
                  />
                ))}
              </div>
              {/* Where income runs out — only meaningful when caps overshoot it. */}
              {overAllocated && incomeMarkerPct < 99 && (
                <div
                  className="absolute top-0 h-full w-0.5 bg-neutral-900 dark:bg-white"
                  style={{ left: `${incomeMarkerPct}%` }}
                  title="Monthly Income"
                />
              )}
            </div>

            {/* Legend — every bucket, widest first. */}
            <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600 dark:text-neutral-400">
              {segments.map((s) => (
                <span key={s.id} className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${s.color}`} />
                  {s.name} {formatDollars(s.monthlyCapCents)}
                </span>
              ))}
            </div>
          </div>

          {/* Headline stats + allocation by type — stacked on mobile, side
              by side on desktop instead of each stretched across the full
              card width. */}
          <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-center lg:gap-6">
          <div className="grid grid-cols-3 gap-2">
            <Stat value={`${pctOfIncomeAllocated}%`} label="Of Income Allocated" />
            <Stat value={String(buckets.length)} label={buckets.length === 1 ? "Bucket" : "Buckets"} />
            <Stat
              value={String(overPaceCount)}
              label={overPaceCount === 1 ? "Bucket Over Pace" : "Buckets Over Pace"}
              tone={overPaceCount > 0 ? "warn" : "ok"}
            />
          </div>

          {/* Allocation by type */}
          <div>
            <p className="mb-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Allocation By Type</p>
            <div className="chart-bar flex h-2.5 w-full overflow-hidden rounded-full bg-blue-50 dark:bg-neutral-800">
              <div className="h-full bg-blue-500" style={{ width: `${recurringPct}%` }} />
              <div className="h-full bg-emerald-500" style={{ width: `${100 - recurringPct}%` }} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600 dark:text-neutral-400">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-blue-500" />
                Bills &amp; Recurring {formatDollars(recurringCents)}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Flexible Spend {formatDollars(flexibleCents)}
              </span>
            </div>
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  value,
  label,
  tone = "neutral",
}: {
  value: string;
  label: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  const valueClass =
    tone === "warn"
      ? "text-amber-700 dark:text-amber-400"
      : tone === "ok"
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-blue-900 dark:text-blue-300";
  return (
    <div className="rounded-xl bg-blue-50/60 dark:bg-neutral-800/50 p-2 text-center">
      <p className={`text-base font-semibold ${valueClass}`}>{value}</p>
      <p className="mt-0.5 text-[10px] leading-tight text-gray-500 dark:text-neutral-400">{label}</p>
    </div>
  );
}
