"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissOnScroll } from "@/lib/use-dismiss-on-scroll";

// Shared hover/tap "scrubber" for the small line charts (NetWorthMiniChart,
// SpendingTrendCard) — a vertical crosshair snapped to the nearest data
// point plus a portaled readout, the same interaction the full
// NetWorthTrendChart on /networth already has. Factored out so the two
// dashboard cards stay identical and the viewport-clamp / meet-fit math
// lives in one place.

// Rough half-width of the readout, used to keep it clamped on-screen once
// it's portaled out to a fixed position.
const TOOLTIP_HALF_W = 90;
const TOOLTIP_MARGIN = 8;

type Box = { left: number; top: number; width: number; height: number };

export type ChartHover = {
  hoverIndex: number | null;
  svgRef: React.RefObject<SVGSVGElement | null>;
  // Screen-space box of the *rendered* viewBox content (accounting for
  // preserveAspectRatio letterboxing) — the anchor frame for the tooltip.
  contentBox: Box | null;
  pointerHandlers: {
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerLeave: () => void;
  };
  // For a chart wrapped in a <Link>: a tap/drag to inspect a point must not
  // also follow the link.
  suppressClick: (e: React.MouseEvent) => void;
  clear: () => void;
};

export function useChartHover(
  viewBoxWidth: number,
  viewBoxHeight: number,
  count: number,
  xAtIndex: (i: number) => number,
): ChartHover {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [contentBox, setContentBox] = useState<Box | null>(null);
  const clear = useCallback(() => setHoverIndex(null), []);
  useDismissOnScroll(hoverIndex !== null, clear);

  const onPointer = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg || count === 0) return;
    const rect = svg.getBoundingClientRect();
    // preserveAspectRatio="xMidYMid meet": the viewBox scales uniformly to
    // fit and is centered, so screen space and viewBox space differ by this
    // scale plus a centering offset. A chart whose viewBox already matches
    // its own pixel size lands on scale ~1 / offsets ~0, so this is a no-op
    // there.
    const scale = Math.min(rect.width / viewBoxWidth, rect.height / viewBoxHeight);
    const offsetX = (rect.width - viewBoxWidth * scale) / 2;
    const offsetY = (rect.height - viewBoxHeight * scale) / 2;
    setContentBox({
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      width: viewBoxWidth * scale,
      height: viewBoxHeight * scale,
    });
    const localX = (clientX - rect.left - offsetX) / scale;
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(xAtIndex(i) - localX);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  };

  return {
    hoverIndex,
    svgRef,
    contentBox,
    pointerHandlers: {
      onPointerMove: (e) => onPointer(e.clientX),
      onPointerDown: (e) => onPointer(e.clientX),
      onPointerLeave: clear,
    },
    suppressClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    clear,
  };
}

export function ChartHoverTooltip({
  contentBox,
  viewBoxWidth,
  viewBoxHeight,
  anchorX,
  anchorY,
  children,
}: {
  contentBox: Box;
  viewBoxWidth: number;
  viewBoxHeight: number;
  // Anchor point, in viewBox units.
  anchorX: number;
  anchorY: number;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;
  const px = contentBox.left + (anchorX / viewBoxWidth) * contentBox.width;
  const py = contentBox.top + (anchorY / viewBoxHeight) * contentBox.height;
  const left = Math.min(
    Math.max(px, TOOLTIP_MARGIN + TOOLTIP_HALF_W),
    window.innerWidth - TOOLTIP_MARGIN - TOOLTIP_HALF_W,
  );
  // Flip below the anchor when sitting above it would run off the top.
  const below = py < 90;
  return createPortal(
    <div
      role="tooltip"
      className={`pointer-events-none fixed z-[var(--z-overlay)] -translate-x-1/2 whitespace-nowrap rounded-lg border border-blue-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-xs shadow-lg ${
        below ? "" : "-translate-y-full"
      }`}
      style={{ left: Math.round(left), top: Math.round(py + (below ? 12 : -10)) }}
    >
      {children}
    </div>,
    document.body,
  );
}
