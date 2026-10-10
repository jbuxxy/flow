import { requireOwner } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { ExportPanel } from "./export-panel";
import { PurgeFinancialDataPanel } from "./purge-financial-data-panel";
import { RestartWizardButton } from "./restart-wizard-button";

export default async function DatabaseSettingsPage() {
  const session = await requireOwner();

  return (
    <AppShell title="Database" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <ExportPanel />

      <RestartWizardButton />

      <PurgeFinancialDataPanel />
    </AppShell>
  );
}
