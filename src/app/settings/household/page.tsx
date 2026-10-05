import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasFullAccess } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { HouseholdProfileSettings } from "./household-profile-settings";
import { HouseholdUsageSynopsis } from "./household-usage-synopsis";

export default async function HouseholdSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/settings");

  const household = await db.household.findUniqueOrThrow({
    where: { id: session.user.householdId },
    select: { goalPosture: true, adultsCount: true, kidsCount: true },
  });

  return (
    <AppShell title="Household Profile" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <HouseholdUsageSynopsis />

      <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
        <HouseholdProfileSettings
          goalPosture={household.goalPosture}
          adultsCount={household.adultsCount}
          kidsCount={household.kidsCount}
        />
      </div>
    </AppShell>
  );
}
