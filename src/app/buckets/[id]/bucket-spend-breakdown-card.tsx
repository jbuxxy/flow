"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";
import { DonutChart } from "@/components/donut-chart";
import { ClearFiltersButton, useBucketEntryFilter, type FilterDim } from "@/components/bucket-entry-filter";
import { BreakdownList } from "./bucket-spend-breakdown-list";

// One spend-breakdown slide: the StatCard-shaped shell (same
// `rounded-2xl border p-4` box, blue header + text-2xl total) with a compact
// donut of this cycle's real spend pinned to the right of the title/total, and
// the interactive row list (bucket-spend-breakdown-list.tsx) below. Hover or
// focus is shared both ways — a wedge and its row light up together, the wedge
// thickens, and the donut center shows that row's share. Client-only so the
// shared highlight state can live here; the server card assembly stays in
// bucket-spend-breakdown.tsx.

// Same hue order as filter-colors.ts, so a row's dot always matches its wedge.
const WEDGE_STROKE = [
  "stroke-blue-500 dark:stroke-blue-400",
  "stroke-orange-500 dark:stroke-orange-400",
  "stroke-emerald-500 dark:stroke-emerald-400",
  "stroke-amber-500 dark:stroke-amber-400",
  "stroke-violet-500 dark:stroke-violet-400",
  "stroke-pink-500 dark:stroke-pink-400",
  "stroke-teal-500 dark:stroke-teal-400",
  "stroke-red-500 dark:stroke-red-400",
  "stroke-indigo-500 dark:stroke-indigo-400",
  "stroke-lime-500 dark:stroke-lime-400",
];
const WEDGE_DOT = [
  "bg-blue-500 dark:bg-blue-400",
  "bg-orange-500 dark:bg-orange-400",
  "bg-emerald-500 dark:bg-emerald-400",
  "bg-amber-500 dark:bg-amber-400",
  "bg-violet-500 dark:bg-violet-400",
  "bg-pink-500 dark:bg-pink-400",
  "bg-teal-500 dark:bg-teal-400",
  "bg-red-500 dark:bg-red-400",
  "bg-indigo-500 dark:bg-indigo-400",
  "bg-lime-500 dark:bg-lime-400",
];

export function BucketSpendBreakdownCard({
  dim,
  title,
  total,
  entries,
  filterable,
}: {
  dim: FilterDim;
  title: string;
  total: number;
  entries: { label: string; cents: number; excludedCents?: number }[];
  filterable: string[];
}) {
  const [active, setActive] = useState<string | null>(null);
  // 2+ rows selected (the persistent filter, not hover) locks the donut onto
  // all of them at once — every matching wedge widens and the center shows
  // their combined share, overriding whatever's currently hovered.
  const { state } = useBucketEntryFilter();
  const selectedForDim = state.dim === dim ? state.values : [];
  const selectedCents = entries.filter((e) => selectedForDim.includes(e.label)).reduce((sum, e) => sum + e.cents, 0);
  const donutActiveLabel = selectedForDim.length >= 2 ? selectedForDim : active;

  const segments = entries.map((e, i) => ({
    label: e.label,
    valueCents: e.cents,
    colorClass: WEDGE_STROKE[i % WEDGE_STROKE.length],
  }));
  const segmentColors = entries.map((_, i) => WEDGE_DOT[i % WEDGE_DOT.length]);

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-blue-900 dark:text-blue-300">
            {title}
            <span className="ml-auto">
              <ClearFiltersButton />
            </span>
          </h2>
          {/* With rows selected, the headline is their combined total —
              the visible "what am I looking at" for a multi-select (household
              request, 2026-09-29), with the full total kept beneath it. */}
          <p className="mt-1 text-2xl font-semibold text-blue-900 dark:text-blue-300">
            {formatCents(selectedForDim.length > 0 ? selectedCents : total)}
          </p>
          {selectedForDim.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              {selectedForDim.length} Selected of {formatCents(total)}
            </p>
          )}
        </div>
        <DonutChart
          segments={segments}
          size={104}
          stroke={16}
          hideTrack
          activeLabel={donutActiveLabel}
          onActiveLabelChange={setActive}
        />
      </div>
      <BreakdownList
        dim={dim}
        entries={entries}
        filterable={filterable}
        segmentColors={segmentColors}
        activeLabel={active}
        onActiveLabelChange={setActive}
      />
    </div>
  );
}
