"use client";

import type { ReactNode } from "react";
import { usePushStatus } from "@/lib/use-push-status";

// Settings' "Notifications" card around the master toggle. When push is off
// on this device the card itself is the thing that needs a look — red tint
// plus the same red "needs attention" dot every other Settings row uses —
// since push permission is only knowable client-side (see ProfileMenu's
// identical use of usePushStatus for the avatar/dropdown chain this mirrors).
export function NotificationSettingsCard({ children }: { children: ReactNode }) {
  const [status] = usePushStatus();
  const off = status === "off";
  return (
    <div
      className={
        off
          ? "rounded-2xl border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 p-4"
          : "rounded-2xl border border-blue-100 dark:border-neutral-800 p-4"
      }
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Notifications</h2>
        {off && <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" />}
      </div>
      {children}
    </div>
  );
}
