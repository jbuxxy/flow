import { formatCents } from "@/lib/money";
import { bucketStatus, STATUS_BAR_CLASS } from "@/lib/bucket-status";
import { BucketIcon } from "@/components/bucket-icon";
import type { BucketProgress } from "@/lib/buckets";

export function BucketProgressBar({
  progress,
  bucket,
}: {
  progress: BucketProgress;
  // When given, the bucket's icon fronts the name here (it's no longer on
  // the page title line — see src/app/buckets/[id]/page.tsx).
  bucket?: { name: string; icon?: string | null };
}) {
  const fillPct = Math.min(progress.spentPct, 100);
  const status = bucketStatus(progress.spentPct, progress.warningThresholdPct);
  // A one-time-purchase bucket funds a target over time, not a monthly cap —
  // see OneTimePurchaseCard (bucket-card.tsx) for the same savings-goal-styled
  // treatment.
  const oneTime = progress.excludedFromAllocation;
  const funded = oneTime && progress.spentPct >= 100;
  const remainingCents = Math.max(progress.monthlyCapCents - progress.spentCents, 0);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
          {bucket && (
            <BucketIcon
              bucket={bucket}
              size={14}
              wrapperClassName="h-5 w-5 bg-blue-50 text-blue-900 dark:bg-neutral-800 dark:text-blue-300"
            />
          )}
          <span className="truncate">{progress.name}</span>
        </span>
        <span className="shrink-0 text-gray-600 dark:text-neutral-400">
          {formatCents(progress.spentCents)} / {formatCents(progress.monthlyCapCents)}
        </span>
      </div>

      {progress.topUpCents > 0 && (
        <p
          className="mt-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
          title="Auto-applied from this month's ad hoc/P2P income to cover this bucket going over its cap (Settings > Income)"
        >
          +{formatCents(progress.topUpCents)} from extra income
        </p>
      )}

      <div className="relative mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-blue-50 dark:bg-neutral-800">
        <div
          className={`chart-bar h-full rounded-full ${oneTime ? "bg-emerald-600" : STATUS_BAR_CLASS[status]}`}
          style={{ width: `${fillPct}%` }}
        />
        {/* Marker for "expected spend at this point in the month" — meaningless
            for a one-time purchase, which has no month to pace against. */}
        {!oneTime && (
          <div
            className="chart-fill absolute top-0 h-full w-0.5 bg-blue-900 dark:bg-blue-300"
            style={{ left: `${Math.min(progress.paceFraction * 100, 100)}%` }}
            title="Expected Pace"
          />
        )}
      </div>

      {oneTime ? (
        <p
          className={`mt-1 text-xs ${
            funded ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-neutral-400"
          }`}
        >
          {funded ? "Fully funded" : `${formatCents(remainingCents)} to go`}
        </p>
      ) : progress.onPaceToOvershoot && progress.spentPct < 100 ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          On pace for {formatCents(progress.projectedMonthEndCents)} this month
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-gray-400 dark:text-neutral-500">
          {progress.paceBasis === "schedule"
            ? `${Math.round(progress.paceFraction * 100)}% of this month's bills due so far`
            : `${Math.round(progress.paceFraction * 100)}% of month elapsed`}
        </p>
      )}
    </div>
  );
}
