"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ChartColumnStacked, SquareSplitHorizontal } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { ChartRiseReveal } from "./chart-rise-reveal";
import { ChartHoverTooltip, useChartHover } from "./chart-hover";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

// Fallback viewBox width used only for the very first paint, before the
// ResizeObserver below (mirrors NetWorthMiniChart's own width/height state)
// reports the real track size — never rendered for more than a frame.
const FALLBACK_WIDTH = 300;
// The card itself is locked to a fixed height (see the Link className) so all
// three dashboard-carousel cards — Payment Calendar, Net Worth, Bucket
// Spending — come out identical and a swipe never jumps the carousel. Width
// is measured instead of guessed (see the `width` state below): a fixed
// guess here left the chart letterboxed with dead space on both sides
// whenever the real track wasn't close to that guess's aspect ratio (real
// household report, 2026-09-17).
const HEIGHT = 280;
const MARGIN = { top: 8, right: 4, bottom: 24, left: 32 };
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

// Remembers the household's stacked-vs-split preference across visits (same
// idea as every other useStoredBoolean toggle on this dashboard) — a global
// key, not per-period, since it's a display preference, not data.
const SPLIT_VIEW_KEY = "flow:dashboard:spend-trend-split-view";

// Compact axis tick text ($1K / $2K) — same idea as NetWorthTrendChart's own
// formatCompact, just without the $M tier: a household's monthly spend never
// gets there, and unlike that chart's y-axis (net worth, which can go
// negative), this one's min is pinned at 0.
function formatCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}K`;
  return `$${Math.round(dollars)}`;
}

// ~3 evenly-spaced, round-number ticks (1/2/5 x a power of 10, same idea as
// NetWorthTrendChart's own niceTicks) from 0 up to — but never past — a
// given ceiling. Unlike that chart's version, this doesn't get to round the
// *max* itself up to the next nice number: the axis top is fixed by the
// caller (household request, 2026-09-06 — pinned a set amount above last
// month's total rather than wherever a "nice" rounding happened to land), so
// the ticks have to fit inside it instead of defining it.
function niceTicksWithinMax(maxValue: number, count = 3): number[] {
  if (maxValue <= 0) return [0];
  const rawStep = maxValue / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual >= 5 ? 5 : residual >= 2 ? 2 : 1) * magnitude;
  const ticks: number[] = [0];
  for (let v = step; v <= maxValue; v += step) ticks.push(Math.round(v));
  return ticks;
}

// Dashboard carousel card: cumulative household spend this month vs. last,
// lined up by day-of-month (not calendar date) so a 28- and a 31-day month
// still compare fairly at the same point in each. "This month" is drawn
// only through today — the rest of that line just has no data yet, so
// extending it flat would misread as "spending stopped." "Last month" draws
// its full length as a de-emphasized (dashed, uncolored) reference line —
// same "current period in the accent, comparison period muted" convention
// as the stat-tile sparklines elsewhere on this dashboard.
//
// Hover/tap anywhere on the plot for a crosshair snapped to that day-of-month
// plus a portaled readout of both months' running totals there (household
// request, 2026-09-08) — the same interaction the /networth trend chart has.
// The card is a <Link> to /transactions; useChartHover.suppressClick keeps a
// tap that's inspecting a day from also following the link.
//
// This month's total is split into two series (household request,
// 2026-09-16, redefined 2026-09-17 to match the /buckets page — see
// spend.ts's own comment on DailySpendTrend for why): "Bills" (every
// RECURRING-bucket transaction, a MIXED bucket's billId-matched/recurring
// portion, and every bucket-assigned debt/BNPL payment routed to a
// RECURRING/MIXED bucket) vs "One-Time" (everything else — SPEND-bucket or
// unbucketed spend, and a MIXED bucket's un-billed portion). See
// getSpendTrend/dailySpendTrendFromTxns/recurringDebtPaymentCentsByDay in
// spend.ts for exactly how a dollar lands in one series or the other. A
// household toggle (default stacked) swaps between two ways of showing that
// split, both rendered inline below (no separate render functions).
export function SpendingTrendCard({
  thisMonthRecurringCumulativeCents,
  thisMonthOneTimeCumulativeCents,
  thisMonthDaysInMonth,
  lastMonthCumulativeCents,
  lastMonthAtSameDayCents,
  // "YYYY-MM" of the month "this month" refers to — only used to label the
  // hover readout ("Sep 14").
  periodKey,
  // Sum of every SPEND-only bucket's monthly cap (see getSpendCeilingCents)
  // — 0 when the household hasn't set any bucket caps, in which case the
  // ceiling line/red-overage rendering below is simply skipped. Compared
  // against the one-time series specifically, not the combined total (see
  // getSpendCeilingCents's own comment on the 2026-09-16 fix) — bills are
  // already locked in by the time they post, so they can't be "over
  // budget" the way discretionary spend can.
  ceilingCents,
}: {
  thisMonthRecurringCumulativeCents: number[];
  thisMonthOneTimeCumulativeCents: number[];
  thisMonthDaysInMonth: number;
  lastMonthCumulativeCents: number[];
  lastMonthAtSameDayCents: number;
  periodKey: string;
  ceilingCents: number;
}) {
  // useId-scoped, never hardcoded: the dashboard's SwipeCarousel mounts every
  // slide twice (a `lg:hidden` swipe copy + a `hidden lg:block` masonry copy),
  // so a fixed id landed in the DOM twice and every desktop `url(#id)`
  // resolved to the hidden mobile copy. Chrome won't apply a paint server or
  // clipPath from a `display:none` subtree, so on desktop the gradient wash
  // disappeared and the over-budget clip was dropped — painting the whole
  // "this month" line red instead of just the sliver above the ceiling.
  const uid = useId();
  const oneTimeGradientId = `${uid}-onetime-fill`;
  const recurringGradientId = `${uid}-recurring-fill`;
  const overGradientId = `${uid}-over`;
  const ceilingClipId = `${uid}-clip`;

  // Measured, not guessed (see FALLBACK_WIDTH's comment) — keeps HEIGHT's
  // per-unit scale (and every absolute size derived from it: margins, tick
  // font sizes, dot radii) exactly as tuned, while the viewBox's own aspect
  // ratio always matches the real track, so `meet` fills it edge to edge on
  // both axes instead of only the constraining one.
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const PLOT_W = width - MARGIN.left - MARGIN.right;

  const [splitView, setSplitView] = useStoredBoolean(SPLIT_VIEW_KEY, false);

  const thisMonthCumulativeCents = thisMonthRecurringCumulativeCents.map(
    (v, i) => v + thisMonthOneTimeCumulativeCents[i],
  );
  const thisMonthTotalCents = thisMonthCumulativeCents.at(-1) ?? 0;
  const recurringTotalCents = thisMonthRecurringCumulativeCents.at(-1) ?? 0;
  const oneTimeTotalCents = thisMonthOneTimeCumulativeCents.at(-1) ?? 0;
  const lastMonthTotalCents = lastMonthCumulativeCents.at(-1) ?? 0;
  const hasCeiling = ceilingCents > 0;
  const isOverBudget = hasCeiling && oneTimeTotalCents > ceilingCents;

  // Axis top: $2,000 above last month's total (household request,
  // 2026-09-06 — enough headroom to see this month pull ahead or fall behind
  // without a mostly-empty chart), still widened to fit anything that
  // genuinely exceeds it (this month's own running total, or the budget
  // ceiling riding on top of this month's bills) so nothing is ever clipped
  // off the top.
  const maxValue = Math.max(
    lastMonthTotalCents + 200_000,
    thisMonthTotalCents,
    recurringTotalCents + ceilingCents,
    1,
  );
  const yTicks = niceTicksWithinMax(maxValue);

  const xScale = (day: number, daysInMonth: number) =>
    MARGIN.left + (day / Math.max(daysInMonth - 1, 1)) * PLOT_W;
  const yScale = (v: number) => MARGIN.top + PLOT_H - (v / maxValue) * PLOT_H;
  const baselineY = MARGIN.top + PLOT_H;

  const pointsFor = (values: number[], daysInMonth: number) =>
    values.map((v, i) => `${xScale(i, daysInMonth)},${yScale(v)}`);

  // Step-after points for the bills line (split view only): holds flat at
  // the prior day's cumulative value right up until the day a bill posts,
  // then jumps — bills land in lumps on a due date, so smoothly
  // interpolating between them like organic day-to-day spend would
  // misrepresent them as accruing gradually.
  const stepPointsFor = (values: number[], daysInMonth: number) => {
    const pts: string[] = [];
    values.forEach((v, i) => {
      const x = xScale(i, daysInMonth);
      if (i > 0) pts.push(`${x},${yScale(values[i - 1])}`);
      pts.push(`${x},${yScale(v)}`);
    });
    return pts;
  };

  const areaUnder = (linePoints: string[]) => [
    `${linePoints[0].split(",")[0]},${baselineY}`,
    ...linePoints,
    `${linePoints.at(-1)!.split(",")[0]},${baselineY}`,
  ];
  // Fill between two curves sampled at the same x positions — the top curve
  // forward, then the bottom curve backward, closing the polygon.
  const areaBetween = (topPoints: string[], bottomPoints: string[]) => [
    ...topPoints,
    ...[...bottomPoints].reverse(),
  ];

  const thisMonthPoints = pointsFor(thisMonthCumulativeCents, thisMonthDaysInMonth);
  const oneTimePoints = pointsFor(thisMonthOneTimeCumulativeCents, thisMonthDaysInMonth);
  const recurringSmoothPoints = pointsFor(thisMonthRecurringCumulativeCents, thisMonthDaysInMonth);
  const recurringStepPoints = stepPointsFor(thisMonthRecurringCumulativeCents, thisMonthDaysInMonth);
  const lastMonthPoints = pointsFor(lastMonthCumulativeCents, lastMonthCumulativeCents.length);

  // Ruler-style x-axis (household request, 2026-09-06): a small tick for
  // every day, a taller one every 5th, and labels only at 1/10/20/30 (each
  // dropped once it'd fall past the month's own last day, e.g. no "30" tick
  // in February).
  const rulerDays = Array.from({ length: thisMonthDaysInMonth }, (_, i) => i + 1);
  const xLabelDays = [1, 10, 20, 30].filter((d) => d <= thisMonthDaysInMonth);

  const { hoverIndex, svgRef, contentBox, pointerHandlers, suppressClick } = useChartHover(
    width,
    HEIGHT,
    thisMonthDaysInMonth,
    (i) => xScale(i, thisMonthDaysInMonth),
  );

  // Same ResizeObserver-on-the-svg-element pattern as NetWorthMiniChart —
  // the <svg> is already `w-full h-full` of the flex track under the
  // legend, so its own content-box IS the track size to match.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.width && rect?.height) setWidth(HEIGHT * (rect.width / rect.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [svgRef]);

  const hoverDay = hoverIndex; // 0-based day index
  const hoverTotalCents = hoverDay !== null ? thisMonthCumulativeCents[hoverDay] : undefined;
  const hoverRecurringCents = hoverDay !== null ? thisMonthRecurringCumulativeCents[hoverDay] : undefined;
  const hoverOneTimeCents = hoverDay !== null ? thisMonthOneTimeCumulativeCents[hoverDay] : undefined;
  const hoverLastCents = hoverDay !== null ? lastMonthCumulativeCents[hoverDay] : undefined;
  const hoverX = hoverDay !== null ? xScale(hoverDay, thisMonthDaysInMonth) : 0;
  // Anchors near whichever line sits highest on screen at that day — the
  // combined total is always >= either individual series, so it (or last
  // month, if that's ahead) is always the topmost, in both view modes.
  const hoverAnchorY =
    hoverTotalCents !== undefined && hoverLastCents !== undefined
      ? Math.min(yScale(hoverTotalCents), yScale(hoverLastCents))
      : hoverTotalCents !== undefined
        ? yScale(hoverTotalCents)
        : hoverLastCents !== undefined
          ? yScale(hoverLastCents)
          : MARGIN.top;
  const monthShort = formatDate(new Date(`${periodKey}-01T00:00:00`), { month: "short" });

  function toggleSplitView(e: React.MouseEvent | React.KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSplitView(!splitView);
  }

  return (
    // Matches Payment Calendar/the Net Worth carousel card's own 340px
    // mobile target (400 at lg:) — the three fixed-height carousel cards
    // were designed to match each other, so all three trim together
    // (household request, 2026-09-12). A chart, unlike a list, has no
    // item-density concern shrinking it — the flex-1 svg wrapper below just
    // gets a smaller share of the box.
    <Link
      href="/transactions?status=notIncome"
      className="flex h-[340px] lg:h-[400px] flex-col rounded-2xl border border-blue-100 p-3 lg:p-4 transition-colors hover:border-blue-300 dark:border-neutral-800 dark:hover:border-neutral-700"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Bucket Spending</h2>
        {/* Stacked-vs-split toggle — plain clickable spans, not nested
            <button>s: this whole card is itself a <Link>'s <a>, and
            interactive content can't legally nest inside one. Same
            role="button"/tabIndex/onKeyDown idiom as TransactionRow's own
            expand toggle; preventDefault+stopPropagation keeps a tap here
            from also following the card to /transactions. */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-full border border-blue-100 p-0.5 dark:border-neutral-800">
          {(
            [
              ["Stacked", false, ChartColumnStacked],
              ["Split", true, SquareSplitHorizontal],
            ] as const
          ).map(([label, value, Icon]) => (
            <span
              key={label}
              role="button"
              tabIndex={0}
              aria-pressed={splitView === value}
              aria-label={label}
              title={label}
              onClick={toggleSplitView}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") toggleSplitView(e);
              }}
              className={`flex items-center rounded-full p-1 transition-colors ${
                splitView === value
                  ? "bg-blue-900 text-white dark:bg-blue-300 dark:text-blue-950"
                  : "text-gray-500 dark:text-neutral-400"
              }`}
            >
              <Icon size={13} />
            </span>
          ))}
        </div>
      </div>

      {/* Legend — a swatch/dash key per series, required once there's more
          than one; each also carries its total so the legend doubles as the
          figure, not just an identity key. Bills/One-Time always both show
          (regardless of which chart view is active below) so the split is
          legible even before you look at the shape of the chart. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <div className="flex items-center gap-1.5">
          {/* Swatch only in split view, where Total is its own drawn line
              (neutral "ink," not an accent — a summary of Bills + One-Time,
              not a third category competing with their own hues). In
              stacked view this figure isn't a distinct series: the top
              edge of the stack already *is* the One-Time boundary, so a
              dot here would claim a line that isn't really separate. */}
          {splitView && <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-900 dark:bg-neutral-100" />}
          <span className="text-gray-500 dark:text-neutral-400">This Month</span>
          <span
            className={`font-semibold ${
              isOverBudget ? "text-red-600 dark:text-red-400" : "text-neutral-900 dark:text-neutral-100"
            }`}
          >
            {formatCents(thisMonthTotalCents)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-0 w-3 shrink-0 border-t-2 border-dashed border-neutral-400 dark:border-neutral-500" />
          <span className="text-gray-500 dark:text-neutral-400">Last Month</span>
          <span className="font-medium text-neutral-500 dark:text-neutral-400">{formatCents(lastMonthAtSameDayCents)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-sm bg-amber-500 dark:bg-amber-400" />
          <span className="text-gray-500 dark:text-neutral-400">Bills</span>
          <span className="font-medium text-amber-700 dark:text-amber-400">{formatCents(recurringTotalCents)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-sm bg-blue-900 dark:bg-blue-500" />
          <span className="text-gray-500 dark:text-neutral-400">One-Time</span>
          <span
            className={`font-medium ${
              isOverBudget ? "text-red-600 dark:text-red-400" : "text-neutral-700 dark:text-neutral-300"
            }`}
          >
            {formatCents(oneTimeTotalCents)}
          </span>
        </div>
        {hasCeiling && (
          <div className="flex items-center gap-1.5">
            <span className="h-0 w-3 shrink-0 border-t-2 border-dashed border-emerald-500 dark:border-emerald-400" />
            <span className="text-gray-500 dark:text-neutral-400">One-Time Budget</span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{formatCents(ceilingCents)}</span>
          </div>
        )}
      </div>

      {/* Wrapper owns the flex sizing; its onClick swallows a tap that was
          only meant to inspect a day so it doesn't also follow the card's
          <Link>. */}
      <div className="mt-2 min-h-0 flex-1" onClick={suppressClick}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          className="h-full w-full touch-none select-none overflow-visible"
          {...pointerHandlers}
        >
          <defs>
            <linearGradient id={oneTimeGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.35} className="text-blue-900 dark:text-blue-500" />
              <stop offset="55%" stopColor="currentColor" stopOpacity={0.1} className="text-blue-900 dark:text-blue-500" />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} className="text-blue-900 dark:text-blue-500" />
            </linearGradient>
            <linearGradient id={recurringGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.4} className="text-amber-500 dark:text-amber-400" />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0.15} className="text-amber-500 dark:text-amber-400" />
            </linearGradient>
            {hasCeiling && (
              <>
                <linearGradient id={overGradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity={0.45} className="text-red-600 dark:text-red-500" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity={0.15} className="text-red-600 dark:text-red-500" />
                </linearGradient>
                {splitView ? (
                  // Split view: the ceiling is a fixed horizontal line, so a
                  // simple rect clip (everything above its y) is enough —
                  // same technique the single-series chart always used.
                  <clipPath id={ceilingClipId}>
                    <rect x={0} y={0} width={width} height={Math.max(0, yScale(ceilingCents))} />
                  </clipPath>
                ) : (
                  // Stacked view: the ceiling rides on top of this month's
                  // bills-so-far, so it's a curve, not a flat line — the clip
                  // is the polygon from the top of the chart down to that
                  // curve (everything with y less than the ceiling curve's,
                  // i.e. everything above it).
                  <clipPath id={ceilingClipId}>
                    <polygon
                      points={[
                        `${MARGIN.left},0`,
                        `${width - MARGIN.right},0`,
                        ...[...pointsFor(thisMonthRecurringCumulativeCents.map((v) => v + ceilingCents), thisMonthDaysInMonth)].reverse(),
                      ].join(" ")}
                    />
                  </clipPath>
                )}
              </>
            )}
          </defs>

          {/* Y axis — hairline gridlines at clean round-number ticks, recessive
              (one step off the card's own border color) so the data stays the
              loud thing on the card. */}
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={yScale(t)}
                y2={yScale(t)}
                className="stroke-blue-100 dark:stroke-neutral-800"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 6}
                y={yScale(t)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-gray-500 dark:fill-neutral-400 text-[9px]"
              >
                {formatCompact(t)}
              </text>
            </g>
          ))}

          {/* X axis — a ruler: a small tick every day, a taller one every 5th,
              labels only at 1/10/20/30. */}
          {rulerDays.map((day) => {
            const isMajor = day % 5 === 0;
            const x = xScale(day - 1, thisMonthDaysInMonth);
            return (
              <line
                key={day}
                x1={x}
                x2={x}
                y1={MARGIN.top + PLOT_H}
                y2={MARGIN.top + PLOT_H + (isMajor ? 5 : 2.5)}
                className={isMajor ? "stroke-gray-400 dark:stroke-neutral-500" : "stroke-blue-100 dark:stroke-neutral-800"}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {xLabelDays.map((day) => (
            <text
              key={day}
              x={xScale(day - 1, thisMonthDaysInMonth)}
              y={HEIGHT - 1}
              textAnchor="middle"
              className="fill-gray-500 dark:fill-neutral-400 text-[9px]"
            >
              {day}
            </text>
          ))}

          {/* Everything data-driven rises up out of the x-axis together on
              mount (see ChartRiseReveal); gridlines/axis stay put. */}
          <ChartRiseReveal width={width} height={HEIGHT} baselineY={MARGIN.top + PLOT_H}>
            <polyline
              points={lastMonthPoints.join(" ")}
              fill="none"
              className="text-neutral-400 dark:text-neutral-600"
              stroke="currentColor"
              strokeWidth={2}
              strokeDasharray="5 4"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />

            {splitView ? (
              <>
                {/* Bills — a step line only (no fill): it's a discrete,
                    already-committed amount, not an area competing for the
                    same visual weight as discretionary spend. */}
                <polyline
                  points={recurringStepPoints.join(" ")}
                  fill="none"
                  className="text-amber-500 dark:text-amber-400"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {/* One-time — smooth area + line, same treatment the combined
                    total always had. */}
                <polygon points={areaUnder(oneTimePoints).join(" ")} fill={`url(#${oneTimeGradientId})`} stroke="none" />
                <polyline
                  points={oneTimePoints.join(" ")}
                  fill="none"
                  className="text-blue-900 dark:text-blue-500"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Total — split view otherwise has no single line answering
                    "how much, all in," the way stacked's top edge does for
                    free. No fill (would just restate the two areas above) and
                    a neutral "ink" color, not another accent — it's a
                    summary of the two category lines, not a third category
                    competing with Bills/One-Time for its own hue. */}
                <polyline
                  points={thisMonthPoints.join(" ")}
                  fill="none"
                  className="text-neutral-900 dark:text-neutral-100"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />

                {hasCeiling && (
                  <>
                    <line
                      x1={MARGIN.left}
                      x2={width - MARGIN.right}
                      y1={yScale(ceilingCents)}
                      y2={yScale(ceilingCents)}
                      className="text-emerald-500 dark:text-emerald-400"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                    <g clipPath={`url(#${ceilingClipId})`}>
                      <polygon points={areaUnder(oneTimePoints).join(" ")} fill={`url(#${overGradientId})`} stroke="none" />
                      <polyline
                        points={oneTimePoints.join(" ")}
                        fill="none"
                        className="text-red-600 dark:text-red-500"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  </>
                )}
              </>
            ) : (
              <>
                {/* Stacked — bills fill the bottom of the column, one-time
                    spend stacks on top of them; the top edge of the whole
                    stack is this month's real combined total. */}
                <polygon points={areaUnder(recurringSmoothPoints).join(" ")} fill={`url(#${recurringGradientId})`} stroke="none" />
                <polyline
                  points={recurringSmoothPoints.join(" ")}
                  fill="none"
                  className="text-amber-500 dark:text-amber-400"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                <polygon
                  points={areaBetween(thisMonthPoints, recurringSmoothPoints).join(" ")}
                  fill={`url(#${oneTimeGradientId})`}
                  stroke="none"
                />
                <polyline
                  points={thisMonthPoints.join(" ")}
                  fill="none"
                  className="text-blue-900 dark:text-blue-300"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />

                {hasCeiling && (
                  <>
                    {/* The budget band rides on top of this month's bills —
                        it visibly steps up the moment a bill posts, since
                        the discretionary allowance above it hasn't changed,
                        only where "on top of bills" now sits. */}
                    <polyline
                      points={pointsFor(
                        thisMonthRecurringCumulativeCents.map((v) => v + ceilingCents),
                        thisMonthDaysInMonth,
                      ).join(" ")}
                      fill="none"
                      className="text-emerald-500 dark:text-emerald-400"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    <g clipPath={`url(#${ceilingClipId})`}>
                      <polygon
                        points={areaBetween(thisMonthPoints, recurringSmoothPoints).join(" ")}
                        fill={`url(#${overGradientId})`}
                        stroke="none"
                      />
                      <polyline
                        points={thisMonthPoints.join(" ")}
                        fill="none"
                        className="text-red-600 dark:text-red-500"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  </>
                )}
              </>
            )}
          </ChartRiseReveal>

          {/* Hover scrubber — outside ChartRiseReveal so it never animates. */}
          {hoverDay !== null && (
            <>
              <line
                x1={hoverX}
                x2={hoverX}
                y1={MARGIN.top}
                y2={MARGIN.top + PLOT_H}
                className="stroke-neutral-400 dark:stroke-neutral-600"
                strokeWidth={1}
              />
              {hoverLastCents !== undefined && (
                <circle
                  cx={hoverX}
                  cy={yScale(hoverLastCents)}
                  r={3}
                  className="fill-neutral-400 dark:fill-neutral-500"
                  stroke="var(--background)"
                  strokeWidth={1.5}
                />
              )}
              {hoverTotalCents !== undefined && (
                <circle
                  cx={hoverX}
                  cy={yScale(hoverTotalCents)}
                  r={3.5}
                  className={splitView ? "fill-neutral-900 dark:fill-neutral-100" : "fill-blue-900 dark:fill-blue-300"}
                  stroke="var(--background)"
                  strokeWidth={2}
                />
              )}
            </>
          )}
        </svg>
      </div>

      {hoverDay !== null && contentBox && (
        <ChartHoverTooltip
          contentBox={contentBox}
          viewBoxWidth={width}
          viewBoxHeight={HEIGHT}
          anchorX={hoverX}
          anchorY={hoverAnchorY}
        >
          <div className="min-w-[9.5rem]">
            <div className="font-semibold text-neutral-900 dark:text-neutral-100">
              {monthShort} {hoverDay + 1}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  splitView ? "bg-neutral-900 dark:bg-neutral-100" : "bg-blue-900 dark:bg-blue-300"
                }`}
              />
              <span className="text-gray-500 dark:text-neutral-400">Total</span>
              <span className="ml-auto font-medium text-neutral-900 dark:text-neutral-100">
                {hoverTotalCents !== undefined ? formatCents(hoverTotalCents) : "—"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 pl-3.5 text-[11px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-sm bg-amber-500 dark:bg-amber-400" />
              <span className="text-gray-500 dark:text-neutral-400">Bills</span>
              <span className="ml-auto font-medium text-neutral-700 dark:text-neutral-300">
                {hoverRecurringCents !== undefined ? formatCents(hoverRecurringCents) : "—"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 pl-3.5 text-[11px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-sm bg-blue-900 dark:bg-blue-500" />
              <span className="text-gray-500 dark:text-neutral-400">One-Time</span>
              <span className="ml-auto font-medium text-neutral-700 dark:text-neutral-300">
                {hoverOneTimeCents !== undefined ? formatCents(hoverOneTimeCents) : "—"}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="h-0 w-2 shrink-0 border-t-2 border-dashed border-neutral-400 dark:border-neutral-500" />
              <span className="text-gray-500 dark:text-neutral-400">Last Month</span>
              <span className="ml-auto font-medium text-neutral-500 dark:text-neutral-400">
                {hoverLastCents !== undefined ? formatCents(hoverLastCents) : "—"}
              </span>
            </div>
          </div>
        </ChartHoverTooltip>
      )}
    </Link>
  );
}
