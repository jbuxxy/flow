"use client";

import { useEffect, useId, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { ChartRiseReveal } from "./chart-rise-reveal";
import { monotoneCurveSegments } from "./sparkline";
import { ChartHoverTooltip, useChartHover } from "./chart-hover";

export type NetWorthMiniPoint = { dateKey: string; netWorthCents: number };

// The dashboard Net Worth card's trend line — the same smooth monotone curve
// + gradient wash as the plain Sparkline it replaced, plus a hover/tap
// crosshair with a portaled $ + date readout (household request, 2026-09-08),
// matching the full NetWorthTrendChart on /networth. The card around it is a
// <Link> to /networth; useChartHover.suppressClick keeps a tap that's
// inspecting a point from also navigating.
//
// viewBox is built in real measured pixels (1 unit = 1px, same as Sparkline)
// so the curve stroke stays uniform and the hover math is a straight 1:1
// screen↔viewBox map.
export function NetWorthMiniChart({
  points,
  className = "text-blue-900 dark:text-blue-300",
}: {
  points: NetWorthMiniPoint[];
  className?: string;
}) {
  // useId, not a caller-supplied constant: the dashboard's SwipeCarousel
  // mounts every slide twice (a `lg:hidden` swipe copy + a `hidden lg:block`
  // masonry copy), so a hardcoded gradient id landed in the DOM twice and
  // every desktop `url(#id)` resolved to the hidden mobile copy — which Chrome
  // then refuses to paint, so the wash silently vanished on desktop.
  const gradientId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [height, setHeight] = useState(180);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.width) setWidth(rect.width);
      if (rect?.height) setHeight(rect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pad = 4;
  const values = points.map((p) => p.netWorthCents);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const range = max - min || 1;
  const xy = points.map((p, i) => ({
    x: points.length > 1 ? (i / (points.length - 1)) * width : width / 2,
    y: pad + (1 - (p.netWorthCents - min) / range) * (height - pad * 2),
  }));

  const { hoverIndex, svgRef, contentBox, pointerHandlers, suppressClick } = useChartHover(
    width,
    height,
    points.length,
    (i) => xy[i]?.x ?? 0,
  );

  if (points.length < 2) return null;

  const curve = `M ${xy[0].x},${xy[0].y}${monotoneCurveSegments(xy)}`;
  const area = `${curve} L ${width},${height} L 0,${height} Z`;
  const hovered = hoverIndex !== null ? { ...points[hoverIndex], ...xy[hoverIndex] } : null;

  return (
    <div ref={containerRef} className="h-full w-full" onClick={suppressClick}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className={`${className} touch-none select-none`}
        {...pointerHandlers}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.4} />
            <stop offset="55%" stopColor="currentColor" stopOpacity={0.12} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        <ChartRiseReveal width={width} height={height}>
          <path d={area} fill={`url(#${gradientId})`} stroke="none" />
          <path
            d={curve}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </ChartRiseReveal>

        {hovered && (
          <>
            <line
              x1={hovered.x}
              x2={hovered.x}
              y1={0}
              y2={height}
              className="stroke-neutral-400 dark:stroke-neutral-600"
              strokeWidth={1}
            />
            <circle cx={hovered.x} cy={hovered.y} r={3.5} fill="currentColor" stroke="var(--background)" strokeWidth={2} />
          </>
        )}
      </svg>

      {hovered && contentBox && (
        <ChartHoverTooltip
          contentBox={contentBox}
          viewBoxWidth={width}
          viewBoxHeight={height}
          anchorX={hovered.x}
          anchorY={hovered.y}
        >
          <div className="font-semibold text-neutral-900 dark:text-neutral-100">{formatCents(hovered.netWorthCents)}</div>
          <div className="text-gray-500 dark:text-neutral-400">
            {formatDate(new Date(`${hovered.dateKey}T00:00:00`), { month: "short", day: "numeric", year: "numeric" })}
          </div>
        </ChartHoverTooltip>
      )}
    </div>
  );
}
