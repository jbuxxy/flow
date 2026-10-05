"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFirstInView } from "@/lib/use-first-in-view";

// Bottom-up "rise" reveal for an SVG line/area plot. Wrap the data marks
// (line, area fill, end dot, reference lines) — NOT the axes/gridlines:
//
//   <ChartRiseReveal width={WIDTH} height={HEIGHT} baselineY={MARGIN.top + PLOT_H}>
//     <path d={areaPath} … />
//     <path d={linePath} … />
//   </ChartRiseReveal>
//
// The whole line is drawn at full width, squished flat onto the baseline, and
// then the wrapping <g> scales vertically 0→1 about that baseline so it grows
// up into its real shape — you watch the trend take shape, not a wipe.
//
// It starts the reveal when the chart first scrolls/swipes into view (an
// IntersectionObserver), not on mount — the dashboard carousel keeps every
// slide mounted (translated offscreen), so a mount-time animation would be
// over before a household ever swiped to that card (household request,
// 2026-09-08). Fires once per page load; swiping back doesn't replay it.
//
// Three things learned the hard way (see globals.css .chart-rise-group):
//   • It's a CSS `transform` transition off a state flip (like DonutChart's
//     wedge draw-in), NOT an animated `clip-path` — an animated clip-path
//     silently does nothing on SVG in Safari.
//   • The transform is on the rendered <g>, NOT a <clipPath> child — a
//     `transform` + `transform-box` on a clipPath child renders nothing at
//     all in mobile Chrome.
//   • Once the reveal has finished, ALL inline transform styles are dropped
//     from the <g>. A lingering `transform` (even an identity scaleY(1))
//     makes mobile Chrome drop `vector-effect: non-scaling-stroke` on a
//     zero-area child — the Bucket Spending card's dashed budget line
//     vanished until this was removed.
//
// `width`/`height` are the chart's viewBox size; `baselineY` is the y (in
// viewBox units) of the plot's x-axis — defaults to `height` (correct when
// the area fill runs to the bottom edge, e.g. a full-bleed sparkline).
export function ChartRiseReveal({
  width,
  height,
  baselineY,
  children,
}: {
  width: number;
  height: number;
  baselineY?: number;
  children: ReactNode;
}) {
  const gRef = useRef<SVGGElement>(null);
  // seed → animating → done. `done` clears every inline transform style.
  const [phase, setPhase] = useState<"seed" | "animating" | "done">("seed");

  // Observe the enclosing <svg>, never this <g> — in the `seed` phase the <g>
  // is scaleY(0), a zero-height box that can never "intersect".
  const inView = useFirstInView(() => gRef.current?.ownerSVGElement ?? gRef.current, 0.35);

  useEffect(() => {
    if (!inView || phase !== "seed") return;
    // rAF so the seed (scaleY(0)) frame paints before the flip to scaleY(1).
    const raf = requestAnimationFrame(() => setPhase("animating"));
    return () => cancelAnimationFrame(raf);
  }, [inView, phase]);

  useEffect(() => {
    if (phase !== "animating") return;
    // Belt-and-braces alongside onTransitionEnd — a backgrounded tab never
    // fires the event, and we still want the transform gone eventually.
    const t = setTimeout(() => setPhase("done"), 1200);
    return () => clearTimeout(t);
  }, [phase]);

  const originY = baselineY ?? height;

  return (
    <g
      ref={gRef}
      className="chart-rise-group"
      style={
        phase === "done"
          ? undefined
          : {
              transformBox: "view-box",
              transformOrigin: `${width / 2}px ${originY}px`,
              transform: phase === "animating" ? "scaleY(1)" : "scaleY(0)",
            }
      }
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === "transform") {
          setPhase("done");
        }
      }}
    >
      {children}
    </g>
  );
}
