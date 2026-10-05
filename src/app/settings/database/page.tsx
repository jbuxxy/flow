import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { ExportPanel } from "./export-panel";
import { PurgeFinancialDataPanel } from "./purge-financial-data-panel";
import { RestartWizardButton } from "./restart-wizard-button";

export default async function DatabaseSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "OWNER") redirect("/");

  return (
    <AppShell title="Database" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <ExportPanel />

      <RestartWizardButton />

      <PurgeFinancialDataPanel />
    </AppShell>
  );
}
