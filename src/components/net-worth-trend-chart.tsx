"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { useChartHover, ChartHoverTooltip } from "@/components/chart-hover";
import { SwipeCarousel } from "@/components/swipe-carousel";
import { ChartRiseReveal } from "@/components/chart-rise-reveal";
import type { NetWorthMonthlyPoint } from "@/lib/networth-history";
import { formatCompact, niceTicks } from "@/lib/chart-axis";

const WIDTH = 640;
const HEIGHT = 200;
const MARGIN = { top: 16, right: 12, bottom: 24, left: 52 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

function monthLabel(periodKey: string, opts: Intl.DateTimeFormatOptions): string {
  return formatDate(new Date(`${periodKey}-01T00:00:00Z`), opts);
}

type ChartPoint = { x: number; periodKey: string; cents: number };

export function NetWorthTrendChart({ monthly }: { monthly: NetWorthMonthlyPoint[] }) {
  const years = useMemo(
    () => Array.from(new Set(monthly.map((p) => p.periodKey.slice(0, 4)))).sort(),
    [monthly],
  );
  const [selected, setSelected] = useState<string>(years[years.length - 1] ?? "all");
  const [tablePage, setTablePage] = useState(0);
  const [chartHeight, setChartHeight] = useState<number | null>(null);
  const chartSlideRef = useRef<HTMLDivElement>(null);

  const isAll = selected === "all";
  // Both the year views and "All" index points by position, never by
  // calendar month: a household that started mid-year has no data before
  // its first snapshot, and stretching that year's line across a full
  // Jan–Dec axis just padded it with empty months on either side. So until a
  // second calendar year of history exists (see the toggle below, hidden
  // while `years.length < 2`) the lone year view and "All" are identical.
  const filtered = useMemo(
    () => (isAll ? monthly : monthly.filter((p) => p.periodKey.startsWith(selected))),
    [monthly, selected, isAll],
  );
  const points: ChartPoint[] = useMemo(
    () => filtered.map((p, i) => ({ x: i, periodKey: p.periodKey, cents: p.netWorthCents })),
    [filtered],
  );

  const xMax = Math.max(points.length - 1, 1);
  const values = points.map((p) => p.cents);
  const rawMin = values.length ? Math.min(...values) : 0;
  const rawMax = values.length ? Math.max(...values) : 0;
  const pad = Math.max((rawMax - rawMin) * 0.15, 100);
  const ticks = niceTicks(rawMin - pad, rawMax + pad);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];

  const xScale = (x: number) => MARGIN.left + (xMax === 0 ? PLOT_W / 2 : (x / xMax) * PLOT_W);
  const yScale = (cents: number) =>
    MARGIN.top + PLOT_H - ((cents - yMin) / (yMax - yMin || 1)) * PLOT_H;

  const { hoverIndex, svgRef, contentBox, pointerHandlers } = useChartHover(
    WIDTH,
    HEIGHT,
    points.length,
    (i) => xScale(points[i].x),
  );

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.x)},${yScale(p.cents)}`).join(" ");
  const areaPath =
    points.length > 0
      ? `${linePath} L${xScale(points[points.length - 1].x)},${MARGIN.top + PLOT_H} L${xScale(points[0].x)},${MARGIN.top + PLOT_H} Z`
      : "";

  const xTicks = isAll
    ? points.filter((p) => p.periodKey.endsWith("-01"))
    : points.filter((_, i) => i % 2 === 0);

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const latest = points.length > 0 ? points[points.length - 1] : null;
  const showEndLabel = hoverIndex === null && latest;

  // The table slide is pinned to the chart slide's rendered height so
  // swiping between the two never resizes the card. Whatever doesn't fit in
  // that height paginates rather than scrolls.
  const hasChart = points.length >= 2;
  useEffect(() => {
    const el = chartSlideRef.current;
    if (!el) return;
    const measure = () => setChartHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasChart]);

  const ROW_PX = 29; // px-2 py-1.5 text-xs row + 1px border
  const PAGER_PX = 28;
  const tableRows = [...points].reverse();
  const bodyPx = (chartHeight ?? 200) - ROW_PX; // minus the header row
  const rowsIfNoPager = Math.max(1, Math.floor(bodyPx / ROW_PX));
  const rowsPerPage =
    tableRows.length > rowsIfNoPager
      ? Math.max(1, Math.floor((bodyPx - PAGER_PX) / ROW_PX))
      : rowsIfNoPager;
  const pageCount = Math.max(1, Math.ceil(tableRows.length / rowsPerPage));
  const pageSafe = Math.min(Math.max(tablePage, 0), pageCount - 1);
  const pageRows = tableRows.slice(pageSafe * rowsPerPage, pageSafe * rowsPerPage + rowsPerPage);

  function selectYear(y: string) {
    setSelected(y);
    setTablePage(0);
  }

  return (
    <div className="flex flex-col gap-3">
      {years.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => selectYear("all")}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              isAll
                ? "bg-blue-900 text-white dark:bg-blue-700"
                : "border border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
            }`}
          >
            All
          </button>
          {years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => selectYear(y)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                selected === y
                  ? "bg-blue-900 text-white dark:bg-blue-700"
                  : "border border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      )}

      {!hasChart ? (
        <p className="text-xs text-gray-500 dark:text-neutral-400">
          Come back after a few more days to start seeing a trend here.
        </p>
      ) : (
        <SwipeCarousel>
        <div key="chart" ref={chartSlideRef} className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full touch-none select-none"
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

          {xTicks.map((p) => (
            <text
              key={p.periodKey}
              x={xScale(p.x)}
              y={HEIGHT - 6}
              textAnchor="middle"
              className="fill-gray-500 dark:fill-neutral-400 text-[9px]"
            >
              {isAll ? monthLabel(p.periodKey, { year: "numeric" }) : monthLabel(p.periodKey, { month: "short" })}
            </text>
          ))}

          {/* Data marks rise up out of the x-axis together on mount (see
              ChartRiseReveal) — the end dot rides along at the top of the
              line. Hover marks stay outside the group. */}
          <ChartRiseReveal width={WIDTH} height={HEIGHT} baselineY={MARGIN.top + PLOT_H}>
            <path d={areaPath} className="fill-blue-900/10 dark:fill-blue-300/10" />
            <path
              d={linePath}
              fill="none"
              className="stroke-blue-900 dark:stroke-blue-300"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {latest && (
              <circle
                cx={xScale(latest.x)}
                cy={yScale(latest.cents)}
                r={4}
                className="fill-blue-900 dark:fill-blue-300"
                stroke="var(--background)"
                strokeWidth={2}
              />
            )}
          </ChartRiseReveal>


          {hovered && (
            <>
              <line
                x1={xScale(hovered.x)}
                x2={xScale(hovered.x)}
                y1={MARGIN.top}
                y2={MARGIN.top + PLOT_H}
                className="stroke-neutral-400 dark:stroke-neutral-600"
                strokeWidth={1}
              />
              <circle
                cx={xScale(hovered.x)}
                cy={yScale(hovered.cents)}
                r={4}
                className="fill-blue-900 dark:fill-blue-300"
                stroke="var(--background)"
                strokeWidth={2}
              />
            </>
          )}

          {showEndLabel && latest && (
            <text
              x={Math.min(xScale(latest.x) + 6, WIDTH - MARGIN.right - 2)}
              y={yScale(latest.cents) - 8}
              textAnchor={xScale(latest.x) > WIDTH - MARGIN.right - 60 ? "end" : "start"}
              className="fill-neutral-900 dark:fill-neutral-100 text-[10px] font-semibold"
            >
              {formatCompact(latest.cents)}
            </text>
          )}
        </svg>

        {hovered && contentBox && (
          <ChartHoverTooltip
            contentBox={contentBox}
            viewBoxWidth={WIDTH}
            viewBoxHeight={HEIGHT}
            anchorX={xScale(hovered.x)}
            anchorY={yScale(hovered.cents)}
          >
            <div className="font-semibold text-neutral-900 dark:text-neutral-100">
              {formatCents(hovered.cents)}
            </div>
            <div className="text-gray-500 dark:text-neutral-400">
              {monthLabel(hovered.periodKey, { month: "long", year: "numeric" })}
            </div>
          </ChartHoverTooltip>
        )}
        </div>

        <div key="table" className="flex flex-col gap-1" style={{ height: chartHeight ?? undefined }}>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-blue-100 dark:border-neutral-800">
            <table className="w-full text-xs">
              <thead className="bg-white dark:bg-neutral-900">
                <tr className="border-b border-blue-100 dark:border-neutral-800">
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500 dark:text-neutral-400">Month</th>
                  <th className="px-2 py-1.5 text-right font-medium text-gray-500 dark:text-neutral-400">
                    Net Worth
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p) => (
                  <tr key={p.periodKey} className="border-b border-blue-100 dark:border-neutral-800 last:border-0">
                    <td className="px-2 py-1.5 text-neutral-700 dark:text-neutral-300">
                      {monthLabel(p.periodKey, { month: "short", year: "numeric" })}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium text-neutral-900 dark:text-neutral-100">
                      {formatCents(p.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3 text-xs text-gray-500 dark:text-neutral-400">
              <button
                type="button"
                onClick={() => setTablePage(pageSafe - 1)}
                disabled={pageSafe === 0}
                aria-label="Previous Page"
                className="disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                Page {pageSafe + 1} of {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setTablePage(pageSafe + 1)}
                disabled={pageSafe === pageCount - 1}
                aria-label="Next Page"
                className="disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
        </SwipeCarousel>
      )}
    </div>
  );
}
