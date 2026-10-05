// Next.js server-startup hook (https://nextjs.org/docs/app/guides/instrumentation).
// Runs once when the server process boots — this is where the SimpleFIN
// poller (and, below, the notification-rollover poller) live, since there's
// no separate worker/cron container in this deployment (single Next.js
// container, see docker-compose.yml).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as unknown as {
    __flowSyncInterval?: ReturnType<typeof setInterval>;
    __flowNotificationInterval?: ReturnType<typeof setInterval>;
  };

  if (!g.__flowSyncInterval) {
    const { syncAllHouseholds } = await import("@/lib/simplefin-sync");
    const POLL_MS = 20 * 60 * 1000;

    setTimeout(() => {
      syncAllHouseholds().catch((err) => console.error("[simplefin-sync] startup sync failed:", err));
    }, 15_000);

    g.__flowSyncInterval = setInterval(() => {
      syncAllHouseholds().catch((err) => console.error("[simplefin-sync] scheduled sync failed:", err));
    }, POLL_MS);
  }

  // Detects month rollover (NEW_CYCLE/NEW_REPORT) and sends the opt-in
  // weekly bucket digest — see src/lib/scheduled-notifications.ts. Hourly is
  // plenty of resolution for a monthly/weekly boundary.
  if (!g.__flowNotificationInterval) {
    const { runScheduledNotificationChecks } = await import("@/lib/scheduled-notifications");
    const CHECK_MS = 60 * 60 * 1000;

    setTimeout(() => {
      runScheduledNotificationChecks().catch((err) =>
        console.error("[scheduled-notifications] startup check failed:", err),
      );
    }, 20_000);

    g.__flowNotificationInterval = setInterval(() => {
      runScheduledNotificationChecks().catch((err) =>
        console.error("[scheduled-notifications] scheduled check failed:", err),
      );
    }, CHECK_MS);
  }
}
