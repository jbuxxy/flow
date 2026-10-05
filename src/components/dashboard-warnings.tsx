"use client";

import { WarningCardCarousel } from "@/components/warning-card-carousel";
import { NotificationPushWarning } from "@/components/notification-push-warning";
import { usePushStatus } from "@/lib/use-push-status";

// Wraps WarningCardCarousel so it can include a signal the server can't
// know ahead of time: push-notification support/permission is live browser
// state (Notification.permission, PushManager presence), not anything
// stored per-household — hasAnyAttention (page.tsx) is a purely
// server-computed boolean across every *other* signal, so it can't account
// for this one. This component is the "use client" seam that ORs the two
// together: it renders nothing extra (and nothing at all, if there's
// otherwise nothing to show) until the client-side push check resolves,
// same as NotificationToggle already did on its own before this existed —
// no hydration mismatch, since the initial "checking" state renders
// identically on the server and on first client paint.
export function DashboardWarnings({
  hasServerAttention,
  children,
}: {
  hasServerAttention: boolean;
  children: React.ReactNode;
}) {
  const [pushStatus] = usePushStatus();

  if (!hasServerAttention && pushStatus !== "unsupported" && pushStatus !== "denied") return null;

  return (
    <WarningCardCarousel desktopGrid>
      {children}
      {(pushStatus === "unsupported" || pushStatus === "denied") && (
        <NotificationPushWarning key="push-notifications" reason={pushStatus} />
      )}
    </WarningCardCarousel>
  );
}
