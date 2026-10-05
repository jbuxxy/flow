import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasFullAccess } from "@/lib/access";
import { currentPeriodKey } from "@/lib/period";
import { periodLabel } from "@/lib/monthly-report";
import {
  createOrRefreshBudgetPlan,
  getPendingBudgetPlan,
  reconcileAllocationWithLiveBuckets,
  type BudgetPlanAllocation,
} from "@/lib/budget-plan";
import { AppShell } from "@/components/app-shell";
import { BudgetAllocator } from "@/components/budget-allocator";

export default async function BudgetPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");

  // "Full financials" = owner. A non-owner full-access member (spouse) can see
  // the proposed plan but can't confirm, skip, or change a value — the
  // allocator renders read-only and the server actions enforce requireOwner.
  const canSetBudget = session.user.role === "OWNER";

  const periodKey = currentPeriodKey();
  await createOrRefreshBudgetPlan(session.user.householdId, periodKey);
  const plan = await getPendingBudgetPlan(session.user.householdId);

  const title = `Set ${periodLabel(periodKey)} Budget`;

  if (!plan) {
    return (
      <AppShell title={title} user={session.user} width="reading">
        <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
          <p className="text-sm text-gray-600 dark:text-neutral-400">
            No budget to set right now — your current bucket caps carry over. We&apos;ll propose a fresh allocation at
            the start of next month.
          </p>
        </div>
      </AppShell>
    );
  }

  const allocation = await reconcileAllocationWithLiveBuckets(
    plan.allocation as unknown as BudgetPlanAllocation,
    session.user.householdId,
  );

  return (
    <AppShell title={title} user={session.user}>
      {/* Keyed on the redraft so a fresh AI redraft remounts the sliders
          with its numbers instead of keeping the old draft's local state. */}
      <BudgetAllocator key={allocation.redraft?.at ?? "original"} allocation={allocation} readOnly={!canSetBudget} />
    </AppShell>
  );
}
