import { requireOwner } from "@/lib/access";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { AiSettingsPanel } from "./ai-settings-panel";
import { AiUsageSynopsis } from "./ai-usage-synopsis";
import { AiUsageCard } from "./ai-usage-card";
import { getAiUsageSummary } from "@/lib/ai-usage";

export default async function AiSettingsPage() {
  const session = await requireOwner();

  const [existing, usage] = await Promise.all([
    db.householdAiSettings.findUnique({
      where: { householdId: session.user.householdId },
      select: { provider: true, status: true, lastError: true },
    }),
    getAiUsageSummary(session.user.householdId),
  ]);

  return (
    <AppShell title="AI Features" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <AiUsageSynopsis />

      <AiSettingsPanel existing={existing} />

      <AiUsageCard summary={usage} />
    </AppShell>
  );
}
