import Link from "next/link";
import { PiggyBank } from "lucide-react";
import { GoalProgressBar } from "./goal-progress-bar";
import type { GoalProgress } from "@/lib/savings";

const MAX_SHOWN = 2;

export function SavingsGoalsCard({ goals }: { goals: GoalProgress[] }) {
  if (goals.length === 0) return null;

  const shown = goals.slice(0, MAX_SHOWN);
  const remaining = goals.length - shown.length;

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PiggyBank size={18} className="shrink-0 text-emerald-700 dark:text-emerald-400" />
          <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Savings Goals</h2>
        </div>
        <Link href="/savings" className="text-sm text-gray-500 dark:text-neutral-400">
          View All →
        </Link>
      </div>

      <ul className="flex flex-col gap-4">
        {shown.map((g) => (
          <li key={g.id}>
            <Link href={`/savings/${g.id}`}>
              <GoalProgressBar progress={g} />
            </Link>
          </li>
        ))}
      </ul>

      {remaining > 0 && (
        <Link href="/savings" className="mt-3 inline-block text-sm text-gray-500 dark:text-neutral-400">
          +{remaining} more goal{remaining === 1 ? "" : "s"}
        </Link>
      )}
    </div>
  );
}
