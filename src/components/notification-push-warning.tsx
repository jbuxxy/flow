"use client";

import { CollapsibleWarningCard, type CollapseControlProps } from "@/components/collapsible-warning-card";
import type { PushStatus } from "@/lib/use-push-status";

// Same collapsible shell as AttentionLinkCard/CountWarning/etc. — this used
// to be plain gray text rendered by NotificationToggle itself, outside the
// dashboard's warning carousel entirely, which read as inconsistent next to
// every other "you should look at this" signal on the page. No link out
// (unlike AttentionLinkCard) since there's nothing in-app to deep-link to —
// "unsupported" needs a manual Home Screen install, "denied" needs the
// device's own OS settings.
export function NotificationPushWarning({
  reason,
  collapsed,
  onToggle,
}: { reason: Extract<PushStatus, "unsupported" | "denied"> } & CollapseControlProps) {
  return (
    <CollapsibleWarningCard
      storageKey="push-notifications-unavailable"
      color="yellow"
      title="Push Notifications Unavailable"
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <p className="mt-1 text-xs text-neutral-900 dark:text-white">
        {reason === "unsupported"
          ? "Push notifications aren't supported in this browser. On iPhone, add Flow to your Home Screen first."
          : "Notifications are blocked. Enable them for Flow in your device settings."}
      </p>
    </CollapsibleWarningCard>
  );
}
