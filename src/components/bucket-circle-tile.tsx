import Link from "next/link";
import { Gauge } from "lucide-react";
import { CircularProgress } from "./circular-progress";
import type { BucketProgress } from "@/lib/buckets";

export function BucketCircleTile({
  progress,
  size = 68,
  strokeWidth = 6,
}: {
  progress: BucketProgress;
  // Default (68/6) is this component's only real-world size today — its one
  // caller, BucketGrid (the dashboard carousel card), now overrides both so
  // 3 rows of tiles fit its fixed-~340px card (household request,
  // 2026-09-12). Kept as props rather than hardcoding the smaller size here
  // so a future full-size caller (e.g. a non-dashboard bucket grid) isn't
  // stuck with it.
  size?: number;
  strokeWidth?: number;
}) {
  // Same flag + Gauge icon as the dashboard's "Buckets Over Pace" tile and
  // BucketCard — marks *which* rings that count refers to (household
  // request, 2026-10-05). One-time buckets are excluded from that count, so
  // they never get the icon here either.
  const overPace = progress.onPaceToOvershoot && !progress.excludedFromAllocation;
  return (
    <Link
      href={`/buckets/${progress.id}`}
      className="flex flex-col items-center gap-1.5 rounded-2xl p-1 text-center transition hover:bg-blue-50 dark:hover:bg-neutral-900"
    >
      <div className="relative">
        <CircularProgress
          pct={progress.spentPct}
          size={size}
          strokeWidth={strokeWidth}
          label={
            overPace ? (
              <span className="flex flex-col items-center leading-none">
                {Math.round(Math.max(progress.spentPct, 0))}%
                <Gauge size={11} className="mt-0.5 text-amber-500 dark:text-amber-400" aria-label="On Pace To Go Over" />
              </span>
            ) : undefined
          }
        />
        {progress.needsAttention && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-600 ring-2 ring-[var(--background)]"
            aria-label="Needs Attention"
            title="Needs Attention"
          />
        )}
      </div>
      <p className="line-clamp-1 w-full text-[11px] font-medium text-neutral-900 dark:text-neutral-100">
        {progress.name}
      </p>
    </Link>
  );
}
