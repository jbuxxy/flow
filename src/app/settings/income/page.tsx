import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasFullAccess } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { IncomeCalcSettings } from "./income-calc-settings";
import { IncomeUsageSynopsis } from "./income-usage-synopsis";

export default async function IncomeSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/settings");

  const household = await db.household.findUniqueOrThrow({
    where: { id: session.user.householdId },
    select: { incomeCalcMethod: true, includeP2PInIncomeCalc: true, autoApplyAdHocIncomeToBuckets: true },
  });

  return (
    <AppShell title="Income for Budgeting" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <IncomeUsageSynopsis />

      <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
        <IncomeCalcSettings
          method={household.incomeCalcMethod}
          includeP2P={household.includeP2PInIncomeCalc}
          autoApplyToBuckets={household.autoApplyAdHocIncomeToBuckets}
        />
      </div>
    </AppShell>
  );
}
