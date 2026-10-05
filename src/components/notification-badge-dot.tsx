"use client";

import { usePushStatus } from "@/lib/use-push-status";

// The same red dot every other "needs a look" row in Settings uses —
// pushed into the "Notification Preferences" card link specifically, since
// push permission is only knowable client-side (see ProfileMenu's identical
// use of usePushStatus for the avatar/dropdown chain this mirrors).
export function NotificationBadgeDot() {
  const [status] = usePushStatus();
  if (status !== "off") return null;
  return <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" />;
}
