import { requireOwner } from "@/lib/access";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { AiSettingsPanel } from "./ai-settings-panel";
import { AiUsageSynopsis } from "./ai-usage-synopsis";

export default async function AiSettingsPage() {
  const session = await requireOwner();

  const existing = await db.householdAiSettings.findUnique({
    where: { householdId: session.user.householdId },
    select: { provider: true, status: true, lastError: true },
  });

  return (
    <AppShell title="AI Features" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <AiUsageSynopsis />

      <AiSettingsPanel existing={existing} />
    </AppShell>
  );
}
