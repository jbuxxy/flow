"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { formatCents } from "@/lib/money";

export type DonutSegment = { label: string; valueCents: number; colorClass: string };

// How much wider the active wedge's stroke gets on hover/focus — the ring
// keeps this much clear space on each side so the grow never clips the box.
const HOVER_GROW = 6;

// Each wedge is a full circle whose visible arc is a `pathLength`-normalised
// dash, rotated into place around the centre — so the wedges always tile the
// full 360° with no seams or leftover rail. Each grows in from a point on
// mount, staggered by index (a lightweight SVG + CSS "draw-in", no charting
// library). The hovered/focused wedge thickens outward and is repainted last
// so nothing clips its edge.
export function DonutChart({
  segments,
  centerLabel,
  centerSubLabel,
  size = 168,
  stroke = 20,
  // The faint rail behind the wedges — the ring's unfilled remainder. Only
  // meaningful when the wedges don't add up to the whole (a progress ring);
  // hide it for a pure part-of-whole breakdown, where they always total 100%.
  hideTrack = false,
  activeLabel,
  onActiveLabelChange,
}: {
  segments: DonutSegment[];
  centerLabel?: string;
  centerSubLabel?: string;
  size?: number;
  stroke?: number;
  hideTrack?: boolean;
  // Hover/focus coordination (a single label), or a persistent multi-select
  // filter (an array) — pass 2+ labels to widen and combine several wedges
  // at once, e.g. when a sibling row list has 2+ merchants picked. Omit both
  // for a self-contained chart (internal single-label hover state).
  activeLabel?: string | string[] | null;
  onActiveLabelChange?: (label: string | null) => void;
}) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Sum of the positive wedges only — a net-negative entry (a refund past its
  // charge) is dropped from the ring, and the rest still fill it exactly.
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.valueCents), 0);
  const radius = (size - stroke - HOVER_GROW * 2) / 2;
  const roomy = size >= 140;

  const [internalActive, setInternalActive] = useState<string | null>(null);
  const activeLabels: string[] = onActiveLabelChange
    ? activeLabel == null
      ? []
      : Array.isArray(activeLabel)
        ? activeLabel
        : [activeLabel]
    : internalActive != null
      ? [internalActive]
      : [];
  const setActive = (label: string | null) => {
    if (onActiveLabelChange) onActiveLabelChange(label);
    else setInternalActive(label);
  };

  const activeSegs = segments.filter((s) => activeLabels.includes(s.label) && s.valueCents > 0);
  const activeValueCents = activeSegs.reduce((sum, s) => sum + s.valueCents, 0);
  const hovered =
    activeSegs.length > 0 && total > 0
      ? {
          label: activeSegs.length === 1 ? activeSegs[0].label : `${activeSegs.length} Selected`,
          valueCents: activeValueCents,
          pct: (activeValueCents / total) * 100,
        }
      : null;

  const wedges: ReactNode[] = [];
  if (total > 0) {
    let acc = 0;
    segments.forEach((seg, i) => {
      if (seg.valueCents <= 0) return;
      const pct = (seg.valueCents / total) * 100;
      const rotate = acc * 3.6; // percent → degrees
      acc += pct;
      const isActive = activeLabels.includes(seg.label);
      wedges.push(
        <circle
          key={seg.label}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          pathLength={100}
          strokeWidth={isActive ? stroke + HOVER_GROW : stroke}
          strokeDasharray={`${animated ? pct : 0} 100`}
          transform={`rotate(${rotate} ${size / 2} ${size / 2})`}
          tabIndex={0}
          role="img"
          aria-label={`${seg.label}: ${formatCents(seg.valueCents)}, ${Math.round(pct)}%`}
          onMouseEnter={() => setActive(seg.label)}
          onMouseLeave={() => setActive(null)}
          onFocus={() => setActive(seg.label)}
          onBlur={() => setActive(null)}
          className={`chart-wedge ${seg.colorClass} cursor-pointer focus:outline-none`}
          style={{
            // Staggered draw-in for the arc length, on the app-wide chart
            // motion tokens (see globals.css) so the donut draws in on the
            // same curve/cadence as every other chart; the hover thicken
            // stays snappy (no per-index delay). `.chart-wedge` also gets
            // `transition: none` under prefers-reduced-motion.
            transition: `stroke-dasharray var(--chart-motion-duration, 620ms) var(--chart-motion-ease, ease-out) calc(${i} * var(--chart-motion-stagger, 65ms)), stroke-width 150ms ease-out`,
          }}
        >
          <title>
            {seg.label}: {formatCents(seg.valueCents)} ({Math.round(pct)}%)
          </title>
        </circle>,
      );
    });
    // SVG has no z-index — repaint every active wedge last (in their original
    // relative order) so each widened stroke sits on top of its neighbours
    // instead of being clipped at the seams.
    if (activeLabels.length > 0) {
      const isActiveWedge = (w: ReactNode) => activeLabels.includes((w as ReactElement).key as string);
      const ordered = [...wedges.filter((w) => !isActiveWedge(w)), ...wedges.filter(isActiveWedge)];
      wedges.length = 0;
      wedges.push(...ordered);
    }
  }

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {!hideTrack && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className="stroke-blue-50 dark:stroke-neutral-800"
          />
        )}
        {wedges}
      </svg>
      <div
        className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center ${
          roomy ? "px-4" : "px-1"
        }`}
      >
        {hovered ? (
          roomy ? (
            <>
              <span className="max-w-full truncate text-sm font-bold text-neutral-900 dark:text-neutral-100">
                {hovered.label}
              </span>
              <span className="text-xs text-gray-500 dark:text-neutral-400">
                {formatCents(hovered.valueCents)} · {Math.round(hovered.pct)}%
              </span>
            </>
          ) : (
            <span className="text-sm font-bold text-neutral-900 dark:text-neutral-100">{Math.round(hovered.pct)}%</span>
          )
        ) : centerLabel || centerSubLabel ? (
          <>
            {centerLabel && (
              <span
                className={`font-bold text-neutral-900 dark:text-neutral-100 ${roomy ? "text-lg" : "text-sm"}`}
              >
                {centerLabel}
              </span>
            )}
            {centerSubLabel && (
              <span className="text-xs text-gray-500 dark:text-neutral-400">{centerSubLabel}</span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
