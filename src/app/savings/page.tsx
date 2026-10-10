import Link from "next/link";
import { db } from "@/lib/db";
import { getSavingsGoalsWithProgress, getHouseholdSavingsCapacity, GOAL_LINKABLE_ACCOUNT_TYPES } from "@/lib/savings";
import { requireFullAccess } from "@/lib/access";
import { formatCents } from "@/lib/money";
import { AppShell } from "@/components/app-shell";
import { StatCard } from "@/components/stat-card";
import { GoalProgressBar } from "@/components/goal-progress-bar";
import { AddGoalForm } from "./add-goal-form";

export default async function SavingsPage() {
  const session = await requireFullAccess();

  const [goals, accounts, capacity] = await Promise.all([
    getSavingsGoalsWithProgress(session.user.householdId),
    db.account.findMany({
      where: { householdId: session.user.householdId, accountType: { in: GOAL_LINKABLE_ACCOUNT_TYPES } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getHouseholdSavingsCapacity(session.user.householdId),
  ]);
  const totalSavedCents = goals.reduce((sum, g) => sum + g.currentAmountCents, 0);

  return (
    <AppShell
      title="Savings Goals"
      user={session.user}
      titleActions={<AddGoalForm accounts={accounts} />}
      width={goals.length === 0 ? "reading" : "wide"}
    >
      {goals.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          No goals yet — what are you saving for?
        </p>
      ) : (
        <>
        <div className="grid grid-cols-2 gap-3 lg:max-w-lg">
          <StatCard
            label="Total Saved"
            labelClassName="text-emerald-700 dark:text-emerald-400"
            value={formatCents(totalSavedCents)}
          />
          <StatCard
            label="Est. Monthly Capacity"
            labelClassName="text-emerald-700 dark:text-emerald-400"
            value={
              <>
                {formatCents(capacity.estimatedMonthlySaveableCents)}
                <span className="text-base font-normal text-gray-500 dark:text-neutral-400">/mo</span>
              </>
            }
          />
        </div>
        <ul className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start xl:grid-cols-3">
          {goals.map((g) => (
            <li key={g.id} className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
              <Link href={`/savings/${g.id}`}>
                <GoalProgressBar progress={g} />
              </Link>
            </li>
          ))}
        </ul>
        </>
      )}
    </AppShell>
  );
}
