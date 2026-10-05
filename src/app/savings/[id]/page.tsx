import { Sparkles } from "lucide-react";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSavingsGoalsWithProgress, getGoalInsight, GOAL_LINKABLE_ACCOUNT_TYPES } from "@/lib/savings";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { hasFullAccess } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { GoalProgressBar } from "@/components/goal-progress-bar";
import { ContributeForm } from "./contribute-form";
import { DeleteGoalButton } from "./delete-goal-button";
import { LinkAccountSelect } from "./link-account-select";
import { EditGoalForm } from "./edit-goal-form";
import { ReminderToggle } from "./reminder-toggle";

export default async function GoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");

  const { id } = await params;
  const goal = await db.savingsGoal.findUnique({ where: { id } });
  if (!goal || goal.householdId !== session.user.householdId) notFound();

  const progress = (await getSavingsGoalsWithProgress(session.user.householdId)).find(
    (g) => g.id === goal.id,
  )!;

  const [contributions, accounts, insight] = await Promise.all([
    db.savingsContribution.findMany({
      where: { goalId: goal.id },
      orderBy: { occurredOn: "desc" },
    }),
    db.account.findMany({
      where: { householdId: session.user.householdId, accountType: { in: GOAL_LINKABLE_ACCOUNT_TYPES } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getGoalInsight(session.user.householdId, goal),
  ]);

  return (
    <AppShell title={goal.name} user={session.user} breadcrumb={{ href: "/savings", label: "All Goals" }} width="reading">

      <GoalProgressBar progress={progress} />

      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-600 dark:text-neutral-400">
          {goal.description || "No description yet — what's this goal for?"}
        </p>
        <EditGoalForm
          goalId={goal.id}
          name={goal.name}
          description={goal.description}
          targetAmountCents={goal.targetAmountCents}
          targetDate={goal.targetDate}
        />
      </div>

      {insight && (
        <div className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-blue-50 dark:from-emerald-950/40 dark:to-blue-950/30 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles size={16} className="text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">AI Savings Coach</h2>
          </div>
          <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">
            Estimated realistic savings capacity: {formatCents(insight.estimatedMonthlySaveableCents)}/month,
            based on your income, budget buckets, and debt minimums.
          </p>
          <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
            {insight.feedback}
          </p>
        </div>
      )}

      <ReminderToggle goalId={goal.id} enabled={goal.reminderEnabled} />

      <LinkAccountSelect goalId={goal.id} accountId={goal.accountId} accounts={accounts} />

      {goal.source === "SIMPLEFIN" ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          Synced — balance updates automatically from the linked account.
          {goal.baselineCents > 0 &&
            ` Progress is counted from the ${formatCents(goal.baselineCents)} that was in the account when you linked it.`}
        </p>
      ) : (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">Log a Contribution</h2>
          <ContributeForm goalId={goal.id} />
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">History</h2>
        {contributions.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-neutral-400">No contributions logged yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {contributions.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-2 text-sm"
              >
                <div>
                  <p className="text-neutral-900 dark:text-neutral-100">
                    {formatDate(c.occurredOn, { month: "short", day: "numeric" })}
                  </p>
                  {c.note && <p className="text-xs text-gray-500 dark:text-neutral-400">{c.note}</p>}
                </div>
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  +{formatCents(c.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DeleteGoalButton goalId={goal.id} goalName={goal.name} />
    </AppShell>
  );
}
