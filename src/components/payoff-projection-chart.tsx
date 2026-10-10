"use client";

import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { useChartHover, ChartHoverTooltip } from "@/components/chart-hover";
import type { PayoffResult } from "@/lib/debt-payoff";
import { LINE_SERIES_COLORS, TOTAL_COLOR } from "@/lib/chart-colors";
import { SwipeCarousel } from "@/components/swipe-carousel";
import { ChartRiseReveal } from "@/components/chart-rise-reveal";
import { formatCompact, niceTicks } from "@/lib/chart-axis";

const WIDTH = 640;
const HEIGHT = 220;
const MARGIN = { top: 16, right: 12, bottom: 28, left: 52 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

const TOTAL_ID = "__total";

// Sample down to at most ~60 points — a 50-year monthly timeline is
// hundreds of entries, far more resolution than an SVG this size can
// usefully render, and a debt that pays off in year 2 doesn't need every
// one of the remaining 48 flat-zero years plotted.
function samplePoints(timeline: PayoffResult["timeline"]) {
  const lastMonthWithBalance = timeline.reduce(
    (last, p, i) => (p.totalRemainingCents > 0 ? i : last),
    0,
  );
  const trimmed = timeline.slice(0, Math.min(timeline.length, lastMonthWithBalance + 2));
  const stride = Math.max(1, Math.ceil(trimmed.length / 60));
  return trimmed.filter((_, i) => i % stride === 0 || i === trimmed.length - 1);
}

// `timeline[i].month` is 1-indexed from simulatePayoff's tick loop, where
// tick 1 represents startDate's own calendar month (not one month later —
// see the matching `month - 1` in simulatePayoff's own date math), so the
// mapping back to a real date needs the same -1.
function timelineMonthDate(startDate: Date, month: number) {
  // Snap to the 1st (UTC) before shifting — a late-in-month startDate
  // (day 29–31) otherwise overflows a shorter target month and mislabels
  // the axis by a month. Only month/year is read off this.
  return new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + month - 1, 1));
}

const SPARK_W = 400;
const SPARK_H = 80;

// The collapsed Projected Payoff card's desktop preview: just the dashed
// Total line (plus a faint fill) falling to $0, no axes — 13 per-debt lines
// at this size are a tangle, and the one line answers "what's the path to
// debt-free" at a glance. Start/end labelled underneath in HTML (the SVG is
// preserveAspectRatio="none" so it stretches to the card, which would
// distort SVG text). Same sampling + month mapping as the full chart.
export function PayoffProjectionSparkline({
  timeline,
  startDate,
}: {
  timeline: PayoffResult["timeline"];
  startDate: Date;
}) {
  const points = samplePoints(timeline);
  if (points.length < 2) return null;

  const yMax = Math.max(...points.map((p) => p.totalRemainingCents), 1);
  const pad = 3; // keep the stroke off the top/bottom edge
  const x = (i: number) => (i / (points.length - 1)) * SPARK_W;
  const y = (cents: number) => pad + (SPARK_H - 2 * pad) * (1 - cents / yMax);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.totalRemainingCents)}`).join(" ");
  const area = `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`;

  const first = points[0];
  const last = points[points.length - 1];
  const label = (p: (typeof points)[number]) =>
    `${formatCompact(p.totalRemainingCents)} · ${formatDate(timelineMonthDate(startDate, p.month), { month: "short", year: "2-digit" })}`;

  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="block h-20 w-full">
        <ChartRiseReveal width={SPARK_W} height={SPARK_H}>
          <path d={area} className="fill-neutral-900/5 dark:fill-neutral-100/10" />
          <path
            d={line}
            fill="none"
            className={TOTAL_COLOR.stroke}
            strokeWidth={2}
            strokeDasharray="5 3"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </ChartRiseReveal>
      </svg>
      <div className="flex justify-between text-[11px] text-gray-500 dark:text-neutral-400">
        <span>{label(first)}</span>
        <span>{label(last)}</span>
      </div>
    </div>
  );
}

// Projected per-debt remaining balance over the life of the plan, plus a
// combined total line — the household's own multi-year "what does this look
// like" view, built from simulatePayoff's timeline (see debt-payoff.ts).
// `debts` is expected to already be every still-owed debt (in the attack
// plan or not — a plan-excluded debt still counts toward "when is the
// household debt-free," it just never gets extra payments cascaded onto
// it) with paid-off debts filtered out by the caller before this ever
// renders, so every one of them gets its own named line — no color-slot
// cap, no "Other" bucket standing in for debts we didn't bother to name.
export function PayoffProjectionChart({
  debts,
  timeline,
  startDate,
}: {
  debts: { id: string; name: string }[];
  timeline: PayoffResult["timeline"];
  startDate: Date;
}) {
  const points = samplePoints(timeline);
  const monthDate = (month: number) => timelineMonthDate(startDate, month);

  const xMax = Math.max(points.length - 1, 1);
  const allValues = points.flatMap((p) => [p.totalRemainingCents, ...debts.map((d) => p.perDebtRemainingCents[d.id] ?? 0)]);
  const rawMax = allValues.length ? Math.max(...allValues) : 0;
  const ticks = niceTicks(0, rawMax * 1.05 || 100);
  const yMax = ticks[ticks.length - 1] || 1;

  const xScale = (i: number) => MARGIN.left + (xMax === 0 ? PLOT_W / 2 : (i / xMax) * PLOT_W);
  const yScale = (cents: number) => MARGIN.top + PLOT_H - (cents / yMax) * PLOT_H;

  const debtSeries = debts.map((d, i) => ({ id: d.id, name: d.name, color: LINE_SERIES_COLORS[i % LINE_SERIES_COLORS.length] }));
  const seriesList = [...debtSeries, { id: TOTAL_ID, name: "Total", color: TOTAL_COLOR }];

  // A handful of evenly spaced x-axis labels — same "don't render more than
  // the plot can usefully show" reasoning as the ~60-point sampling above.
  const xTickCount = Math.min(5, points.length);
  const xTickIndices = [
    ...new Set(
      Array.from({ length: xTickCount }, (_, i) => Math.round((i * (points.length - 1)) / Math.max(xTickCount - 1, 1))),
    ),
  ];

  function lineFor(getCents: (p: PayoffResult["timeline"][number]) => number) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(getCents(p))}`).join(" ");
  }

  const { hoverIndex, svgRef, contentBox, pointerHandlers } = useChartHover(
    WIDTH,
    HEIGHT,
    points.length,
    (i) => xScale(i),
  );

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  if (points.length < 2) {
    return <p className="text-xs text-gray-500 dark:text-neutral-400">Not enough data yet to project a chart.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {seriesList.map((s) => (
          <span key={s.id} className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
            <span className={`h-2 w-2 shrink-0 rounded-full ${s.color.dot}`} />
            {s.name}
          </span>
        ))}
      </div>

      <SwipeCarousel>
      <div key="chart" className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block w-full touch-none select-none"
          {...pointerHandlers}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={MARGIN.left}
                x2={WIDTH - MARGIN.right}
                y1={yScale(t)}
                y2={yScale(t)}
                className="stroke-blue-100 dark:stroke-neutral-800"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 8}
                y={yScale(t)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-gray-500 dark:fill-neutral-400 text-[9px]"
              >
                {formatCompact(t)}
              </text>
            </g>
          ))}

          {xTickIndices.map((i) => (
            <text
              key={i}
              x={xScale(i)}
              y={MARGIN.top + PLOT_H + 16}
              textAnchor="middle"
              className="fill-gray-500 dark:fill-neutral-400 text-[9px]"
            >
              {formatDate(monthDate(points[i].month), { month: "short", year: "2-digit" })}
            </text>
          ))}

          {/* Every projected balance line rises up out of the x-axis
              together on mount (see ChartRiseReveal). */}
          <ChartRiseReveal width={WIDTH} height={HEIGHT} baselineY={MARGIN.top + PLOT_H}>
            {debtSeries.map((s) => (
              <path
                key={s.id}
                d={lineFor((p) => p.perDebtRemainingCents[s.id] ?? 0)}
                fill="none"
                className={s.color.stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            <path
              d={lineFor((p) => p.totalRemainingCents)}
              fill="none"
              className={TOTAL_COLOR.stroke}
              strokeWidth={2.5}
              strokeDasharray="5 3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </ChartRiseReveal>

          {hovered && hoverIndex !== null && (
            <line
              x1={xScale(hoverIndex)}
              x2={xScale(hoverIndex)}
              y1={MARGIN.top}
              y2={MARGIN.top + PLOT_H}
              className="stroke-neutral-400 dark:stroke-neutral-600"
              strokeWidth={1}
            />
          )}
        </svg>

        {hovered && hoverIndex !== null && contentBox && (
          <ChartHoverTooltip
            contentBox={contentBox}
            viewBoxWidth={WIDTH}
            viewBoxHeight={HEIGHT}
            anchorX={xScale(hoverIndex)}
            anchorY={yScale(rawMax)}
          >
            <div className="font-semibold text-neutral-900 dark:text-neutral-100">
              {formatDate(monthDate(hovered.month), { month: "short", year: "numeric" })}
            </div>
            {debtSeries
              .filter((s) => (hovered.perDebtRemainingCents[s.id] ?? 0) > 0)
              .map((s) => (
                <div key={s.id} className="flex items-center gap-1.5 text-gray-600 dark:text-neutral-400">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.color.dot}`} />
                  {s.name}: {formatCents(hovered.perDebtRemainingCents[s.id] ?? 0)}
                </div>
              ))}
            <div className="flex items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TOTAL_COLOR.dot}`} />
              Total: {formatCents(hovered.totalRemainingCents)}
            </div>
          </ChartHoverTooltip>
        )}
      </div>

      {/* Locked to the chart's own aspect ratio so both slides are exactly
          the same height at every width — SwipeCarousel sizes its viewport to
          the active slide, and a fixed max-h table made the card jump on
          every swipe (household request, 2026-10-08). The table scrolls
          inside whatever height that leaves. */}
      <div key="table" className="flex flex-col gap-1" style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}>
        <p className="px-1 text-[11px] text-gray-500 dark:text-neutral-400">Remaining Balance By Month</p>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto rounded-lg border border-blue-100 dark:border-neutral-800">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-white dark:bg-neutral-900">
              <tr className="border-b border-blue-100 dark:border-neutral-800">
                <th className="px-2 py-1.5 text-left font-medium text-gray-500 dark:text-neutral-400">Month</th>
                {debtSeries.map((s) => (
                  <th key={s.id} className="px-2 py-1.5 text-right font-medium text-gray-500 dark:text-neutral-400">
                    {s.name}
                  </th>
                ))}
                <th className="border-l border-blue-100 dark:border-neutral-800 px-2 py-1.5 text-right font-semibold text-neutral-700 dark:text-neutral-300">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.month} className="border-b border-blue-100 dark:border-neutral-800 last:border-0">
                  <td className="px-2 py-1.5 text-neutral-700 dark:text-neutral-300">
                    {formatDate(monthDate(p.month), { month: "short", year: "numeric" })}
                  </td>
                  {debtSeries.map((s) => {
                    const cents = p.perDebtRemainingCents[s.id] ?? 0;
                    return (
                      <td
                        key={s.id}
                        className={`px-2 py-1.5 text-right font-medium ${
                          cents > 0
                            ? "text-neutral-900 dark:text-neutral-100"
                            : "text-neutral-300 dark:text-neutral-600"
                        }`}
                      >
                        {/* A paid-off (or not-yet-started) debt reads as a
                            dash, not "$0.00" — makes the payoff progression
                            scannable down each column (household request,
                            2026-09-01). */}
                        {cents > 0 ? formatCents(cents) : "–"}
                      </td>
                    );
                  })}
                  <td
                    className={`border-l border-blue-100 dark:border-neutral-800 px-2 py-1.5 text-right font-semibold ${
                      p.totalRemainingCents > 0
                        ? "text-neutral-900 dark:text-neutral-100"
                        : "text-neutral-300 dark:text-neutral-600"
                    }`}
                  >
                    {p.totalRemainingCents > 0 ? formatCents(p.totalRemainingCents) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </SwipeCarousel>
    </div>
  );
}
