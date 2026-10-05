"use client";

import { useEffect, useRef, useState } from "react";
import { ChartRiseReveal } from "./chart-rise-reveal";

// Fritsch-Carlson monotone cubic interpolation (same family as d3's
// curveMonotoneX) — smooths the line between points without letting the
// curve overshoot past a real local min/max, which a plain Catmull-Rom
// spline can do (implying a bump/dip the data never had). Returns the
// tangent slope at each point.
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));

  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] === 0 || d[i] === 0 || (d[i - 1] < 0) !== (d[i] < 0) ? 0 : (d[i - 1] + d[i]) / 2;
  }
  return m;
}

// Builds the "C ..." cubic-bezier segments (no leading "M") for a smooth
// monotone curve through the given points. Exported for NetWorthMiniChart,
// which draws the same curve shape with a hover scrubber on top.
export function monotoneCurveSegments(points: { x: number; y: number }[]): string {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const tangents = monotoneTangents(xs, ys);
  let d = "";
  for (let i = 0; i < points.length - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    const cp1x = xs[i] + dx;
    const cp1y = ys[i] + tangents[i] * dx;
    const cp2x = xs[i + 1] - dx;
    const cp2y = ys[i + 1] - tangents[i + 1] * dx;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}

// Minimal inline trend line for a stat tile/card — no axes, no
// interactivity, unlike the full NetWorthTrendChart on /networth. Just
// enough to read "up" vs "down" at a glance. A faint area fill under the
// line gives it a little more presence in a card without adding a legend or
// gridlines. `className` sets `currentColor` (a `text-*` class) — both the
// stroke and the fill derive from it.
//
// A client component so it can measure its own rendered pixel width
// (ResizeObserver) and build the viewBox in real 1:1 pixel units instead of
// a fixed 100-unit box stretched to fill the card via
// preserveAspectRatio="none". That stretch used to be wildly anisotropic
// (full card width vs. a fixed 28px height, often 5-8x more scaling on the
// x axis than y), which visibly distorted the stroke — round joins came out
// squashed into flat ellipses, and the constant strokeWidth rendered
// thicker or thinner along the line depending on local slope. Measuring the
// real width and drawing 1 unit = 1 pixel on both axes makes the transform
// a no-op, so the stroke is uniform everywhere and round joins/caps render
// as actual circles again.
export function Sparkline({
  values,
  className = "text-blue-900 dark:text-blue-300",
  gradientId,
  height: heightProp = 28,
  fill = false,
}: {
  values: number[];
  className?: string;
  // Rendered pixel height of the strip when NOT `fill` — 28 is the inline
  // stat-tile size.
  height?: number;
  // Stretch to the parent's height instead of a fixed one (the parent must
  // give it a bounded height — e.g. a flex-1 track). Used by the dashboard's
  // Net Worth carousel card so its trend fills the card and all three
  // carousel cards come out exactly the same height.
  fill?: boolean;
  // Pass a unique id to render the area as a top-down gradient wash (the
  // fill fades from the line down to transparent) instead of the flat
  // low-opacity fill — SVG gradients resolve by DOM id, so two gradient
  // sparklines on the same page need distinct ids. `stop-color="currentColor"`
  // still inherits from `className`, same as the stroke.
  gradientId?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Arbitrary fallback for the first paint before ResizeObserver reports a
  // real width — replaced within a frame, so the only cost is a brief
  // reflow of the curve's shape, not the card's layout (the wrapper div is
  // already sized by CSS regardless of this value).
  const [width, setWidth] = useState(320);
  // Only meaningful when `fill` — otherwise the viewBox height is the fixed
  // `height` prop and this stays at its seed value, unused.
  const [measuredHeight, setMeasuredHeight] = useState(heightProp);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.width) setWidth(rect.width);
      if (fill && rect?.height) setMeasuredHeight(rect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fill]);

  if (values.length < 2) return null;

  const height = fill ? measuredHeight : heightProp;

  // Keeps the highest/lowest point off the SVG's exact top/bottom edge — the
  // stroke's own width and the point dots both extend past the path's
  // center line, so a peak sitting at y=0 (or a trough at y=height) got its
  // top (or bottom) sliced off by the viewport, reading as a flattened cap
  // rather than the actual peak/dot shape.
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: pad + (1 - (v - min) / range) * (height - pad * 2),
  }));
  const curve = `M ${points[0].x},${points[0].y}${monotoneCurveSegments(points)}`;
  const area = `${curve} L ${width},${height} L 0,${height} Z`;

  return (
    <div
      ref={containerRef}
      className={fill ? "h-full w-full" : "w-full"}
      style={fill ? undefined : { height }}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
        {gradientId && (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.4} />
              <stop offset="55%" stopColor="currentColor" stopOpacity={0.12} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
        )}
        <ChartRiseReveal width={width} height={height}>
          <path
            d={area}
            fill={gradientId ? `url(#${gradientId})` : "currentColor"}
            stroke="none"
            className={gradientId ? undefined : "opacity-[0.08]"}
          />
          <path
            d={curve}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </ChartRiseReveal>
      </svg>
    </div>
  );
}
