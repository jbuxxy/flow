"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatCents } from "@/lib/money";
import { SERIES_COLORS, OTHER_COLOR } from "@/lib/chart-colors";

export type CompositionSlice = { id: string; name: string; valueCents: number };

// Part-to-whole ("where is the debt from") is a stacked-bar job per the
// dataviz skill, not a pie/donut — a single horizontal 100%-stacked bar
// reads accurately at any width, unlike angle judgment on a pie. Slices
// beyond the categorical palette's 5 slots fold into "Other" rather than
// generating a new hue.
export function DebtCompositionChart({ slices }: { slices: CompositionSlice[] }) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  // "Other" folds every slice past the 5-hue categorical palette into one bar
  // segment — but this chart already lives inside an expandable card, so the
  // household can drill the rest open right here instead of it being a dead
  // "and 8 more" label (request, 2026-09-03).
  const [otherExpanded, setOtherExpanded] = useState(false);

  const sorted = [...slices].filter((s) => s.valueCents > 0).sort((a, b) => b.valueCents - a.valueCents);
  const shown = sorted.slice(0, SERIES_COLORS.length);
  const rest = sorted.slice(SERIES_COLORS.length);
  const otherCents = rest.reduce((s, r) => s + r.valueCents, 0);
  const total = sorted.reduce((s, r) => s + r.valueCents, 0);

  const segments = [
    ...shown.map((s, i) => ({ id: s.id, name: s.name, valueCents: s.valueCents, color: SERIES_COLORS[i] })),
    ...(otherCents > 0 ? [{ id: "__other", name: `Other (${rest.length})`, valueCents: otherCents, color: OTHER_COLOR }] : []),
  ];

  if (total === 0 || segments.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-neutral-400">Nothing to show yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="chart-bar flex h-7 w-full gap-0.5 overflow-hidden rounded-full">
        {segments.map((seg) => {
          const pct = (seg.valueCents / total) * 100;
          return (
            <button
              key={seg.id}
              type="button"
              onPointerEnter={() => setHoverId(seg.id)}
              onPointerLeave={() => setHoverId((v) => (v === seg.id ? null : v))}
              onFocus={() => setHoverId(seg.id)}
              onBlur={() => setHoverId((v) => (v === seg.id ? null : v))}
              style={{ width: `${pct}%` }}
              className={`min-w-[3px] transition-opacity ${seg.color.fill} ${
                hoverId && hoverId !== seg.id ? "opacity-50" : "opacity-100"
              }`}
              aria-label={`${seg.name}: ${formatCents(seg.valueCents)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      <ul className="flex flex-col gap-1.5">
        {segments.map((seg) => {
          const pct = (seg.valueCents / total) * 100;

          if (seg.id === "__other") {
            return (
              <li key={seg.id} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => setOtherExpanded((v) => !v)}
                  onPointerEnter={() => setHoverId(seg.id)}
                  onPointerLeave={() => setHoverId((v) => (v === seg.id ? null : v))}
                  aria-expanded={otherExpanded}
                  className={`flex items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left text-sm transition-colors ${
                    hoverId === seg.id ? "bg-blue-50 dark:bg-neutral-800" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-neutral-700 dark:text-neutral-300">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${seg.color.dot}`} />
                    <span className="truncate">{seg.name}</span>
                    <ChevronDown
                      size={13}
                      className={`shrink-0 text-neutral-400 transition-transform ${otherExpanded ? "rotate-180" : ""}`}
                    />
                  </span>
                  <span className="shrink-0 text-right text-gray-500 dark:text-neutral-400">
                    <span className="font-medium text-neutral-900 dark:text-neutral-100">{formatCents(seg.valueCents)}</span>{" "}
                    <span className="text-xs">({pct.toFixed(0)}%)</span>
                  </span>
                </button>

                {otherExpanded && (
                  <ul className="ml-1.5 mt-1 flex flex-col gap-1 border-l border-blue-100 pl-3 dark:border-neutral-800">
                    {rest.map((r) => {
                      const rpct = (r.valueCents / total) * 100;
                      return (
                        <li key={r.id} className="flex items-center justify-between gap-3 px-1.5 py-0.5 text-xs">
                          <span className="flex min-w-0 items-center gap-1.5 text-neutral-600 dark:text-neutral-400">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400 dark:bg-neutral-500" />
                            <span className="truncate">{r.name}</span>
                          </span>
                          <span className="shrink-0 text-right text-gray-500 dark:text-neutral-400">
                            <span className="font-medium text-neutral-800 dark:text-neutral-200">
                              {formatCents(r.valueCents)}
                            </span>{" "}
                            <span>({rpct < 0.1 ? "<0.1" : rpct.toFixed(1)}%)</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          }

          return (
            <li
              key={seg.id}
              onPointerEnter={() => setHoverId(seg.id)}
              onPointerLeave={() => setHoverId((v) => (v === seg.id ? null : v))}
              className={`flex items-center justify-between gap-3 rounded-md px-1.5 py-1 text-sm transition-colors ${
                hoverId === seg.id ? "bg-blue-50 dark:bg-neutral-800" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-neutral-700 dark:text-neutral-300">
                <span className={`h-2 w-2 shrink-0 rounded-full ${seg.color.dot}`} />
                <span className="truncate">{seg.name}</span>
              </span>
              <span className="shrink-0 text-right text-gray-500 dark:text-neutral-400">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{formatCents(seg.valueCents)}</span>{" "}
                <span className="text-xs">({pct.toFixed(0)}%)</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
