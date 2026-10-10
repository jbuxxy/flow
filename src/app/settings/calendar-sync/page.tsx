import { requireOwner } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { CalendarSyncPanel } from "./calendar-sync-panel";
import { ensureCalendarFeedUrl } from "./actions";

export default async function CalendarSyncSettingsPage() {
  const session = await requireOwner();

  const url = await ensureCalendarFeedUrl();

  return (
    <AppShell title="Calendar Sync" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">
      <CalendarSyncPanel initialUrl={url} />
    </AppShell>
  );
}
