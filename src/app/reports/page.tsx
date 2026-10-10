import Link from "next/link";
import { Archive } from "lucide-react";
import { requireFullAccess } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { getMonthReport, monthsAgoPeriodKey } from "@/lib/monthly-report";
import { getOrCreateCurrentReport } from "@/lib/reports";
import { getPendingBudgetPlan } from "@/lib/budget-plan";
import { ReportView } from "./report-view";

export default async function ReportsPage() {
  const session = await requireFullAccess();

  const current = await getMonthReport(session.user.householdId, monthsAgoPeriodKey(1));

  const report =
    current.buckets.length > 0 ? await getOrCreateCurrentReport(session.user.householdId, current) : null;
  // The "Set These Up In Your Budget →" CTA is owner-only — setting the budget
  // is "full financials" (budget/actions.ts requireOwner). A non-owner
  // full-access member can still open /budget to view the plan.
  const budgetPlanPending =
    session.user.role === "OWNER" && (await getPendingBudgetPlan(session.user.householdId)) != null;

  return (
    <AppShell
      title="Monthly Report"
      user={session.user}
      width="reading"
      titleActions={
        <Link
          href="/reports/archive"
          aria-label="Report Archive"
          title="Report Archive"
          className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          <Archive size={18} />
        </Link>
      }
    >
      {current.buckets.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          No buckets yet — set some up to start seeing monthly reports.
        </p>
      ) : (
        <ReportView
          current={current}
          monthLabel={current.label}
          report={report}
          budgetPlanPending={budgetPlanPending}
        />
      )}
    </AppShell>
  );
}
