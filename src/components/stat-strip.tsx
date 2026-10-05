import Link from "next/link";
import { type CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import { Sparkline } from "./sparkline";

export type StatTile = {
  key: string;
  label: string;
  value: string;
  caption?: string;
  icon: LucideIcon;
  accent?: "neutral" | "emerald" | "amber" | "red";
  href?: string;
  // Optional inline visual, mirroring the detail cards further down the
  // dashboard (This Week's Bills' paid bar, the Net Worth card's
  // Sparkline) so a stat tile reads as more than a bare number even
  // before you tap into it. At most one of these is set per tile.
  // `segments` is a per-item status bar (one color class per bucket) for
  // a tile whose value aggregates several individually-statused things —
  // a single blended progressPct read as "how full" rather than "how many
  // of these are flagged", which is what Buckets Over Pace actually means.
  progressPct?: number; // 0-100
  spark?: number[];
  // Tiny start/end labels under the sparkline so its window is readable
  // ("Sep 1" … "Today"), and a line color overriding the tile accent — the
  // Net Worth tile tints its line by direction over that window (emerald up,
  // red down) without recoloring its icon badge.
  sparkRange?: { start: string; end: string };
  sparkAccent?: "neutral" | "emerald" | "amber" | "red";
  segments?: string[]; // one Tailwind bg-* class per item
};

type Accent = NonNullable<StatTile["accent"]>;

// Icon badge + bar/spark tint per accent. The card itself stays a plain
// neutral box (see className below) — an earlier version also tinted the
// card background/border per accent, but that read as more decoration than
// signal, so only the badge and the inline visual carry the accent color.
const ACCENT: Record<Accent, { badge: string; bar: string; spark: string }> = {
  neutral: {
    badge: "bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-300",
    bar: "bg-blue-500",
    // Matches the bigger Net Worth card's line color further down the
    // dashboard exactly (page.tsx) — both plot the same netWorthDaily
    // series, so they read as one chart rather than two different blues.
    spark: "text-blue-900 dark:text-blue-300",
  },
  emerald: {
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400",
    bar: "bg-emerald-500",
    spark: "text-emerald-700 dark:text-emerald-400",
  },
  amber: {
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400",
    bar: "bg-amber-500",
    spark: "text-amber-700 dark:text-amber-400",
  },
  red: {
    badge: "bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400",
    bar: "bg-red-500",
    spark: "text-red-600 dark:text-red-400",
  },
};

// Access-aware by construction: callers only push a tile for data the
// viewer is actually allowed to see (hasFullAccess/canViewNetWorth), so a
// limited member just gets fewer tiles rather than a broken/empty one.
// Column count adapts to how many survive that filtering, so one tile
// (a limited member with only the buckets stat) still reads as a
// deliberate full-width card, not a half-empty grid.
export function StatStrip({ tiles }: { tiles: StatTile[] }) {
  if (tiles.length === 0) return null;

  // Fixed 2-up on mobile regardless of count (3 tiles just wrap to a
  // half-empty second row) — a 3-column grid at phone width was cramming
  // icon+value+label into ~110px each and truncating everything (real
  // household screenshot, 2026-08-21). Only widens past 2 at `sm:`, and
  // only when there's enough tiles to fill it.
  // At `lg:` the strip sits in a wider container, so a 2- or 3-tile strip
  // gets a matching column count instead of two half-width tiles floating
  // left. 4+ tiles already fill the row at `sm:`.
  const cols =
    tiles.length === 1
      ? "grid-cols-1"
      : tiles.length >= 4
        ? "grid-cols-2 sm:grid-cols-4"
        : tiles.length === 3
          ? "grid-cols-2 lg:grid-cols-3"
          : "grid-cols-2";
  // An odd count under 4 always stays on the fixed 2-col layout above (1
  // already gets its own full-width row via grid-cols-1), so it's the only
  // regime where a trailing tile can end up alone with an empty cell next to
  // it — e.g. a non-owner full-access member with buckets/due/savings but no
  // net-worth tile. Let that last tile fill the row instead.
  const lastFillsRow = tiles.length % 2 !== 0 && tiles.length < 4;
  // The last-tile-fills-row span must be released once a 3-tile strip goes
  // to its own 3-column track at `lg:`.
  const fillClass = tiles.length === 3 ? " col-span-2 lg:col-span-1" : " col-span-2";

  return (
    <div className={`grid ${cols} gap-2 lg:gap-3`}>
      {tiles.map((t, i) => {
        const Icon = t.icon;
        const accent = t.accent ?? "neutral";
        const accentStyle = ACCENT[accent];
        const isLast = i === tiles.length - 1;
        // When this tile spans the whole row (a lone tile, or the trailing
        // tile of an odd-count strip) there's horizontal room to spare, so
        // the caption reads better pushed out to the right, vertically
        // centred against the value/label, rather than stacked underneath.
        // A 3-tile strip drops that span at `lg:` (own 3-col track), so the
        // right-aligned caption reverts to stacked there too.
        const fillsRow = lastFillsRow && isLast;
        const narrowsAtLg = tiles.length === 3;
        // Mobile sizing tightened (household request, 2026-09-12: the
        // dashboard's two stat rows + the fixed-400px Payment Calendar
        // below it shouldn't need a scrollbar on a phone screen at
        // baseline — more tiles or a notification banner pushing past that
        // is fine, but this row's own footprint was the easy, even-across-
        // every-tile place to trim). `lg:` sizes are untouched — the wide
        // desktop layout already has vertical room to spare.
        const className = `rounded-2xl border border-blue-100 dark:border-neutral-800 bg-[var(--background)] p-2.5 lg:p-4${fillsRow ? fillClass : ""}`;
        const content = (
          <>
            <div className="flex items-center gap-2 lg:gap-2.5">
              <span
                className={`flex h-7 w-7 lg:h-11 lg:w-11 shrink-0 items-center justify-center rounded-full ${accentStyle.badge}`}
              >
                <Icon className="h-3.5 w-3.5 lg:h-5 lg:w-5" />
              </span>
              <div
                className={`min-w-0 flex-1${
                  fillsRow ? ` flex items-center justify-between gap-3${narrowsAtLg ? " lg:block" : ""}` : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-base lg:text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t.value}</p>
                  <p className="truncate text-[11px] lg:text-xs text-gray-500 dark:text-neutral-400">{t.label}</p>
                </div>
                {t.caption && (
                  <p
                    className={`truncate text-[10px] lg:text-[11px] text-gray-400 dark:text-neutral-500${
                      fillsRow ? ` shrink-0 text-right${narrowsAtLg ? " lg:text-left" : ""}` : ""
                    }`}
                  >
                    {t.caption}
                  </p>
                )}
              </div>
            </div>
            {t.segments && t.segments.length > 0 && (
              <div className="mt-1.5 lg:mt-2.5 flex h-1.5 gap-0.5">
                {t.segments.map((colorClass, idx) => (
                  <span
                    key={idx}
                    className={`chart-bar h-full flex-1 rounded-full ${colorClass}`}
                    style={{ "--chart-index": idx } as CSSProperties}
                  />
                ))}
              </div>
            )}
            {typeof t.progressPct === "number" && (
              <div className="mt-1.5 lg:mt-2.5 h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                <div
                  className={`chart-bar h-full rounded-full ${accentStyle.bar} transition-[width] duration-300`}
                  style={{ width: `${Math.min(100, Math.max(0, t.progressPct))}%` }}
                />
              </div>
            )}
            {t.spark && t.spark.length >= 2 && (
              <>
                {/* 40px, not the old 16px — at 16px any real movement
                    (tens of $k on a ~$900k figure) flattened to a near-
                    straight line (household report, 2026-09-29). */}
                <div className="mt-2 lg:mt-2.5 h-10 lg:h-12">
                  <Sparkline
                    values={t.spark}
                    className={ACCENT[t.sparkAccent ?? t.accent ?? "neutral"].spark}
                    gradientId={`stat-spark-${t.key}`}
                    fill
                  />
                </div>
                {t.sparkRange && (
                  <div className="mt-0.5 flex justify-between text-[10px] text-gray-400 dark:text-neutral-500">
                    <span>{t.sparkRange.start}</span>
                    <span>{t.sparkRange.end}</span>
                  </div>
                )}
              </>
            )}
          </>
        );

        return t.href ? (
          <Link key={t.key} href={t.href} className={`${className} transition hover:shadow-md`}>
            {content}
          </Link>
        ) : (
          <div key={t.key} className={className}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
