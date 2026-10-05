import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import type { GoalProgress } from "@/lib/savings";

export function GoalProgressBar({ progress }: { progress: GoalProgress }) {
  const fillPct = Math.min(progress.pct, 100);

  // The open-ended "General Savings" catch-all has no target amount/date — it
  // just accumulates whatever surplus the monthly budget routes to savings.
  if (progress.isCatchAll) {
    return (
      <div>
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-neutral-900 dark:text-neutral-100">{progress.name}</span>
          <span className="text-gray-600 dark:text-neutral-400">{formatCents(progress.currentAmountCents)} saved</span>
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">Open-ended · fed by your monthly surplus</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-neutral-900 dark:text-neutral-100">{progress.name}</span>
        <span className="text-gray-600 dark:text-neutral-400">
          {formatCents(progress.currentAmountCents)} / {formatCents(progress.targetAmountCents)}
        </span>
      </div>

      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-blue-50 dark:bg-neutral-800">
        <div
          className="chart-bar h-full rounded-full bg-emerald-600"
          style={{ width: `${fillPct}%` }}
        />
      </div>

      {progress.baselineCents > 0 && (
        <p className="mt-1 text-[11px] text-gray-400 dark:text-neutral-500">
          Measured from {formatCents(progress.baselineCents)} already in the linked account
        </p>
      )}

      {progress.pct >= 100 ? (
        <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">Goal reached</p>
      ) : progress.targetDate ? (
        <p
          className={`mt-1 text-xs ${progress.onTrackForTargetDate === false ? "text-amber-700 dark:text-amber-400" : "text-gray-500 dark:text-neutral-400"}`}
        >
          Target {formatDate(progress.targetDate, { month: "short", year: "numeric" })}
          {progress.onTrackForTargetDate === false && " — behind pace"}
          {progress.onTrackForTargetDate === true && " — on pace"}
        </p>
      ) : progress.projectedCompletionDate ? (
        <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
          At this pace: {formatDate(progress.projectedCompletionDate, { month: "short", year: "numeric" })}
        </p>
      ) : null}
    </div>
  );
}
