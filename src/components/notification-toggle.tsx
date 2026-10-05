"use client";

import { useTransition } from "react";
import { subscribeToPush, unsubscribeFromPush } from "@/lib/push-client";
import { usePushStatus } from "@/lib/use-push-status";
import { Switch } from "@/components/switch";
import { NotificationPushWarning } from "@/components/notification-push-warning";
import { showToast } from "@/lib/toast";
import { LockableSwitch } from "@/components/lockable-switch";

export function NotificationToggle({
  hideWhenEnabled = false,
  showUnavailableWarning = false,
  lockedOn = false,
}: {
  hideWhenEnabled?: boolean;
  showUnavailableWarning?: boolean;
  // The household owner locked this member's notifications on
  // (User.notificationsLocked) — this device can turn push on but not off
  // (the server refuses the unsubscribe too, /api/push/subscribe).
  lockedOn?: boolean;
}) {
  const [status, setStatus] = usePushStatus();
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      try {
        if (status === "on") {
          await unsubscribeFromPush();
          setStatus("off");
          showToast("Notifications Off");
        } else {
          const result = await subscribeToPush();
          setStatus(result === "subscribed" ? "on" : result === "denied" ? "denied" : "unsupported");
          if (result === "subscribed") showToast("Notifications On");
        }
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  // "checking": nothing resolved yet.
  if (status === "checking") return null;
  // "unsupported"/"denied": the dashboard shows NotificationPushWarning via
  // its own warning carousel (DashboardWarnings) instead of passing
  // showUnavailableWarning here, so it isn't rendered twice there; Settings
  // has no such carousel, so it opts in directly.
  if (status === "unsupported" || status === "denied") {
    return showUnavailableWarning ? <NotificationPushWarning reason={status} /> : null;
  }
  if (status === "on" && hideWhenEnabled) return null;

  if (status === "on" && lockedOn) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm text-gray-700 dark:text-neutral-300">Notifications Are On</span>
          <span className="block text-xs text-gray-500 dark:text-neutral-400">Locked on by the household owner.</span>
        </span>
        <LockableSwitch
          checked
          locked
          onToggle={() => {}}
          onLockedTap={() => showToast("Locked On By The Household Owner")}
          ariaLabel="Push Notifications"
        />
      </div>
    );
  }

  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-gray-700 dark:text-neutral-300">
        {status === "on" ? "Notifications Are On" : "Enable Notifications"}
      </span>
      <Switch checked={status === "on"} onChange={toggle} disabled={pending} ariaLabel="Push Notifications" />
    </label>
  );
}
