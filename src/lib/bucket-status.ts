export type BucketStatus = "ok" | "warning" | "exceeded";

export function bucketStatus(spentPct: number, warningThresholdPct: number): BucketStatus {
  if (spentPct >= 100) return "exceeded";
  if (spentPct >= warningThresholdPct) return "warning";
  return "ok";
}

export const STATUS_BAR_CLASS: Record<BucketStatus, string> = {
  exceeded: "bg-red-600",
  warning: "bg-amber-500",
  ok: "bg-emerald-600",
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rampColorAt(ramp: { pct: number; rgb: [number, number, number] }[], pct: number): string {
  const min = ramp[0].pct;
  const max = ramp[ramp.length - 1].pct;
  const clamped = Math.min(Math.max(pct, min), max);
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i];
    const b = ramp[i + 1];
    if (clamped <= b.pct) {
      const t = (clamped - a.pct) / (b.pct - a.pct);
      const [r, g, bl] = a.rgb.map((c, idx) => Math.round(lerp(c, b.rgb[idx], t)));
      return `rgb(${r}, ${g}, ${bl})`;
    }
  }
  const [r, g, bl] = ramp[ramp.length - 1].rgb;
  return `rgb(${r}, ${g}, ${bl})`;
}

// The bucket status ring (CircularProgress) is a gauge, not a flat-color
// fill. This ramp is keyed by *position around the full circle* (0-100%),
// not by a bucket's live spentPct: a bucket at 40% only ever reveals the
// still-green start of this sweep, while one that lands exactly on its cap
// reveals the whole loop, ending in blue where it closes back at the top.
// Flat green through 75% (no shift until you're actually close to the cap),
// then easing into blue over the last quarter.
const BASE_RING_RAMP: { pct: number; rgb: [number, number, number] }[] = [
  { pct: 0, rgb: [16, 185, 129] }, // emerald-500
  { pct: 75, rgb: [16, 185, 129] }, // still emerald-500 — flat until the last quarter
  { pct: 100, rgb: [59, 130, 246] }, // blue-500
];

export function baseRingColorAt(positionPct: number): string {
  return rampColorAt(BASE_RING_RAMP, positionPct);
}

// Once a bucket runs over its cap, an overage arc grows to eventually
// replace the base ring entirely, reaching a full ring at
// OVERAGE_FULL_RING_PCT.
const OVERAGE_FULL_RING_PCT = 200; // spentPct at which the overage arc fully replaces the base ring

// 0-1: how much of the full ring the overage arc occupies (pushing the base
// ring's own green/blue gauge out of the way), reaching 1 (the whole ring,
// no green/blue left) at OVERAGE_FULL_RING_PCT. Linear/proportional — a
// bucket 72 of the 100 points over that it takes to reach
// OVERAGE_FULL_RING_PCT should visibly take over 72% of the ring, not some
// eased fraction of it — the marker's position is meant to read directly as
// "how far over," at a glance.
export function overageCoverageFraction(spentPct: number): number {
  if (spentPct <= 100) return 0;
  return Math.min((spentPct - 100) / (OVERAGE_FULL_RING_PCT - 100), 1);
}

// Red's share of the overage arc (0-1; the rest is orange). Holds steady at
// 50/50 for the whole 100-200% range — while the overage arc itself is busy
// growing to replace the base ring, that's the only signal that needs to
// move — then accelerates from half red toward solid red (no orange left)
// as a bucket runs from 200% up to OVERAGE_ALL_RED_PCT.
const OVERAGE_ALL_RED_PCT = 300;

export function overageRedFraction(spentPct: number): number {
  if (spentPct <= OVERAGE_FULL_RING_PCT) return 0.5;
  const t = Math.min((spentPct - OVERAGE_FULL_RING_PCT) / (OVERAGE_ALL_RED_PCT - OVERAGE_FULL_RING_PCT), 1);
  return 0.5 + 0.5 * t ** 2;
}

const OVERAGE_ORANGE_RGB: [number, number, number] = [249, 115, 22]; // orange-500
const OVERAGE_RED_RGB: [number, number, number] = [220, 38, 38]; // red-600

export const OVERAGE_ORANGE = "rgb(249, 115, 22)";
export const OVERAGE_RED = "rgb(220, 38, 38)";

// Interpolates orange -> red at fraction t (0-1, clamped). Used to paint the
// overage arc as many small flat-colored slices rather than a single SVG
// gradient — a gradient's color stops interpolate along a *straight line*
// between two points, but the overage arc can sweep almost the entire
// circle, so a straight chord between its two ends bears little relation to
// the curved path being painted and produces a distorted blend. Many small
// solid-color slices sidestep that entirely.
export function overageBlendColor(t: number): string {
  const clamped = Math.min(Math.max(t, 0), 1);
  const [r, g, b] = OVERAGE_ORANGE_RGB.map((c, i) => Math.round(lerp(c, OVERAGE_RED_RGB[i], clamped)));
  return `rgb(${r}, ${g}, ${b})`;
}
