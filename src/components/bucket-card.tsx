import Link from "next/link";
import { Gauge } from "lucide-react";
import { formatDollars } from "@/lib/money";
import { BucketIcon } from "./bucket-icon";
import { CircularProgress } from "./circular-progress";
import type { BucketProgress } from "@/lib/buckets";

export function BucketCard({ progress }: { progress: BucketProgress }) {
  if (progress.excludedFromAllocation) {
    return <OneTimePurchaseCard progress={progress} />;
  }

  return (
    <Link
      href={`/buckets/${progress.id}`}
      className="block rounded-2xl border border-blue-100 dark:border-neutral-800 bg-[var(--background)] p-4 shadow-sm transition hover:shadow-md"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BucketIcon
            bucket={progress}
            size={20}
            wrapperClassName="h-10 w-10 bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300"
          />
          <div>
            <p className="flex items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
              {progress.name}
              {/* The same onPaceToOvershoot flag (and Gauge icon) behind the
                  "Buckets Over Pace" count on the dashboard and the allocation
                  card — marks *which* buckets those are (household request,
                  2026-10-03). */}
              {progress.onPaceToOvershoot && (
                <span title="On Pace To Go Over" aria-label="On Pace To Go Over" className="shrink-0">
                  <Gauge size={15} className="text-amber-500 dark:text-amber-400" />
                </span>
              )}
              {progress.needsAttention && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" title="Needs Attention" />
              )}
            </p>
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              {formatDollars(progress.spentCents)} of {formatDollars(progress.monthlyCapCents)}
            </p>
            {progress.topUpCents > 0 && (
              <p
                className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
                title="Auto-applied from this month's ad hoc/P2P income to cover this bucket going over its cap (Settings > Income)"
              >
                +{formatDollars(progress.topUpCents)} From Extra Income
              </p>
            )}
          </div>
        </div>
        <CircularProgress pct={progress.spentPct} size={72} strokeWidth={6} />
      </div>
    </Link>
  );
}

// A one-time-purchase bucket (Bucket.excludedFromAllocation) isn't a monthly
// spend bucket — it's a target you fund over time (a Tesla down payment, a
// big repair), and its "spent" is every charge ever assigned to it, not just
// this month's (see getBucketsWithProgress). Deliberately its own look:
// emerald border + faint tint (vs. every other card's blue-on-transparent),
// a "ONE-TIME" tag, and a plain emerald fill bar with NO pace marker — the
// striped pace track stays the exclusive signature of a real spend bucket.
// Same treatment as a Savings Goal's progress bar, which is the same kind of
// thing (2026-09-10, after a "0%" ring read as a failing spend bucket, then
// a milestone pill that didn't land either).
function OneTimePurchaseCard({ progress }: { progress: BucketProgress }) {
  const funded = progress.spentPct >= 100;
  const fillPct = Math.min(progress.spentPct, 100);
  const remainingCents = Math.max(progress.monthlyCapCents - progress.spentCents, 0);

  return (
    <Link
      href={`/buckets/${progress.id}`}
      className="block rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/15 p-4 shadow-sm transition hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <BucketIcon
            bucket={progress}
            size={20}
            wrapperClassName="h-10 w-10 shrink-0 bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400"
          />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
              <span className="truncate">{progress.name}</span>
              {progress.needsAttention && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" title="Needs Attention" />
              )}
            </p>
            <p className="mt-0.5 text-xs">
              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400">
                One-Time
              </span>
            </p>
          </div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-neutral-400">
          {formatDollars(progress.spentCents)} / {formatDollars(progress.monthlyCapCents)}
        </span>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-emerald-100/70 dark:bg-neutral-800">
        <div className="chart-bar h-full rounded-full bg-emerald-600" style={{ width: `${fillPct}%` }} />
      </div>

      <p
        className={`mt-1.5 text-xs ${
          funded ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-neutral-400"
        }`}
      >
        {funded ? "Fully funded" : `${formatDollars(remainingCents)} to go`}
      </p>
    </Link>
  );
}
