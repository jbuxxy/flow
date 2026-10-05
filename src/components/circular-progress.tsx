"use client";

import { useEffect, useRef, useState } from "react";
import { baseRingColorAt, overageBlendColor, overageCoverageFraction, overageRedFraction } from "@/lib/bucket-status";
import { useFirstInView } from "@/lib/use-first-in-view";

// Where the base ring's green -> blue ease begins, as a fraction of whatever
// span the base ring currently has (see baseEndPct below) — flat green
// before this, easing into blue after it.
const BASE_TRANSITION_START_FRACTION = 0.75;
// How many conic-gradient stops sample each color ramp (green -> blue,
// orange -> red) so the gradient follows the ramp functions' own curves.
const RAMP_SAMPLES = 24;
// Intro timing (ms). Phase 1 fills the green -> blue gauge clockwise from
// the top up to the bucket's pct (capped at 100); an over-cap bucket then
// pauses briefly and plays phase 2 — the cap marker backs up
// counter-clockwise as the orange -> red overage arc grows in behind it —
// so the overage reads as its own distinct beat.
const FILL_MS = 700;
const OVERAGE_PAUSE_MS = 120;
const OVERAGE_MS = 650;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function CircularProgress({
  pct,
  size = 40,
  strokeWidth = 4,
  label,
}: {
  pct: number; // 0-100+
  size?: number;
  strokeWidth?: number;
  // Overrides the default "N%" text in the center — e.g. a checkmark icon
  // in place of "100%".
  label?: React.ReactNode;
}) {
  const display = Math.max(pct, 0);
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - strokeWidth) / 2;

  // Animate the ring in the first time it scrolls/swipes into view — not on
  // mount. The dashboard carousel keeps the "This Month's Buckets" slide
  // mounted offscreen, so a mount animation was always over before you
  // swiped to it (household report, 2026-09-08). The animation drives the
  // pct itself (0 -> min(pct, 100), then 100 -> pct): every frame is just
  // the ring as it'd look at that pct, so the marker recession and overage
  // growth fall straight out of the geometry below. `animPct` is null once
  // the intro has played (or under reduced motion) — the ring then tracks
  // `pct` directly, so a later data refresh doesn't replay it.
  const wrapRef = useRef<HTMLDivElement>(null);
  const inView = useFirstInView(() => wrapRef.current);
  const [animPct, setAnimPct] = useState<number | null>(() => (prefersReducedMotion() ? null : 0));
  const introDoneRef = useRef(false);
  useEffect(() => {
    if (!inView || introDoneRef.current || prefersReducedMotion()) return;
    const fillTo = Math.min(display, 100);
    const hasOver = display > 100;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed < FILL_MS) {
        setAnimPct(fillTo * easeOutCubic(elapsed / FILL_MS));
      } else if (hasOver && elapsed < FILL_MS + OVERAGE_PAUSE_MS) {
        setAnimPct(fillTo);
      } else if (hasOver && elapsed < FILL_MS + OVERAGE_PAUSE_MS + OVERAGE_MS) {
        const t = (elapsed - FILL_MS - OVERAGE_PAUSE_MS) / OVERAGE_MS;
        setAnimPct(100 + (display - 100) * easeOutCubic(t));
      } else {
        introDoneRef.current = true;
        setAnimPct(null);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, display]);
  // The pct the ring is drawn at this frame (the center label always shows
  // the real pct).
  const shown = animPct ?? display;
  const clamped = Math.min(shown, 100);

  // A "goal" marker always sits at the 100%-of-cap position — the top when
  // a bucket is at or under its cap. Once it runs over, that marker recedes
  // clockwise (visually leftward, since the ring reads clockwise from the
  // top) to make room for an overage arc that eventually replaces the base
  // ring entirely (overageCoverageFraction reaches 1 at 200% spent). The
  // base ring's own green -> blue gauge always fills whatever span remains
  // before that marker, so it "shrinks to fit" as the marker recedes instead
  // of staying pinned to the original 0-100 span.
  const overageSweepPct = overageCoverageFraction(shown) * 100;
  const baseEndPct = 100 - overageSweepPct;
  // How much of the base ring's own span is actually drawn: a partial reveal
  // (with bare track for the remainder) while under the cap, or the whole
  // thing once there's any overage — together the base + overage rings
  // always tile the full circle with no gap once a bucket runs over.
  const basePct = Math.min(clamped, baseEndPct);
  const relativePos = (posPct: number) => (posPct / baseEndPct) * 100;

  const greenEnd = Math.min(basePct, BASE_TRANSITION_START_FRACTION * baseEndPct);
  const blueLen = Math.max(basePct - greenEnd, 0);

  // The overage arc, from orange (nearest the marker, where it first crossed
  // 100%) to red (nearest the top, the fresh/current edge of the overage). A
  // small gap short of the top keeps red from touching green directly —
  // otherwise the ring's "safe" and "over" colors would abut with no seam at
  // all once a bucket runs over.
  const hasOverage = overageSweepPct > 0;
  const overageGapPct = 1.5;
  const overageEndPct = hasOverage ? 100 - overageGapPct : 100;
  // Orange's share of the arc (shrinking toward 0 as overageRedFraction — a
  // steady 0.5 through 200% spent, then accelerating toward 1 by 300% —
  // grows toward 1).
  const blendCenterPct = (1 - overageRedFraction(shown)) * 100;
  const blendHalfWidth = 10;
  const orangeStopPct = Math.max(blendCenterPct - blendHalfWidth, 0);
  const redStopPct = Math.min(blendCenterPct + blendHalfWidth, 100);

  // The whole colored ring is one CSS conic-gradient masked to the ring
  // shape — it interpolates along the actual arc, so it blends seamlessly.
  // (It used to be many flat-colored SVG slices, since an SVG linear
  // gradient interpolates along the straight chord rather than the curve;
  // the anti-aliased seams between slices read as visible blocks, household
  // report 2026-09-30.) Conic stops are positions around the circle
  // starting at 12 o'clock, clockwise — the ring's own reading order.
  const stops: string[] = [];
  const addRamp = (fromPct: number, toPct: number, colorAt: (t: number) => string) => {
    for (let i = 0; i <= RAMP_SAMPLES; i++) {
      const t = i / RAMP_SAMPLES;
      stops.push(`${colorAt(t)} ${(fromPct + (toPct - fromPct) * t).toFixed(3)}%`);
    }
  };
  if (greenEnd > 0) {
    stops.push(`${baseRingColorAt(0)} 0%`, `${baseRingColorAt(0)} ${greenEnd.toFixed(3)}%`);
  }
  if (blueLen > 0) {
    addRamp(greenEnd, basePct, (t) => baseRingColorAt(relativePos(greenEnd + (basePct - greenEnd) * t)));
  }
  if (hasOverage) {
    addRamp(baseEndPct, overageEndPct, (t) => {
      const rel = t * 100;
      const blend =
        rel <= orangeStopPct ? 0 : rel >= redStopPct ? 1 : (rel - orangeStopPct) / (redStopPct - orangeStopPct);
      return overageBlendColor(blend);
    });
  }
  const filledEndPct = hasOverage ? overageEndPct : basePct;
  stops.push(`transparent ${filledEndPct.toFixed(3)}%`);
  // The gap before the top (overage) or the bare track (under cap) shows
  // through as transparent.
  const ringGradient = `conic-gradient(${stops.join(", ")})`;
  // Ring-shaped mask: soft half-pixel edges so the ring anti-aliases the
  // same way the SVG track under it does.
  const innerR = size / 2 - strokeWidth;
  const ringMask = `radial-gradient(circle closest-side, transparent ${innerR - 0.5}px, #000 ${innerR + 0.5}px, #000 calc(100% - 0.75px), transparent 100%)`;
  const hasFill = filledEndPct > 0;

  const tickAngle = (baseEndPct / 100) * 2 * Math.PI;
  const tickDirX = Math.cos(tickAngle);
  const tickDirY = Math.sin(tickAngle);
  const tickInnerR = radius - strokeWidth / 2 - 1;
  const tickOuterR = radius + strokeWidth / 2 + 1;

  return (
    <div ref={wrapRef} className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-blue-50 dark:stroke-neutral-800"
        />
      </svg>
      {hasFill && (
        <div
          className="absolute inset-0 rounded-full"
          style={{
              background: ringGradient,
              maskImage: ringMask,
              WebkitMaskImage: ringMask,
            }}
        />
      )}
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        {/* The cap marker always renders last, on top of every colored
            segment, as a plain solid white line — no blend mode — so it
            never picks up a tint from whatever color is under it. */}
        <line
          x1={cx + tickDirX * tickInnerR}
          y1={cy + tickDirY * tickInnerR}
          x2={cx + tickDirX * tickOuterR}
          y2={cy + tickDirY * tickOuterR}
          strokeWidth={1.5}
          strokeLinecap="round"
          className="stroke-white"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-neutral-900 dark:text-neutral-100">
        {label ?? `${Math.round(display)}%`}
      </span>
    </div>
  );
}
