"use client";

import { useEffect, useState } from "react";

export type NotificationLockState = { enabled: boolean; locked: boolean };

const POLL_MS = 5_000;

// The signed-in member's own master switch + owner lock, kept current while
// the page is open: re-read every few seconds while visible and the moment
// the app comes back to the foreground. There's no server push channel, and
// iOS won't deliver a silent web push, so polling the tiny
// /api/me/notification-lock route is what makes an owner's lock/unlock show
// up live on the member's phone (household request, 2026-10-17).
// `active` false skips polling entirely (the owner's own view).
export function useLiveNotificationLock(initial: NotificationLockState, active = true): NotificationLockState {
  const [state, setState] = useState(initial);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/me/notification-lock", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as NotificationLockState;
        if (!cancelled) {
          setState((prev) => (prev.enabled === next.enabled && prev.locked === next.locked ? prev : next));
        }
      } catch {
        // offline — keep the last known state
      }
    };
    const id = setInterval(read, POLL_MS);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
    };
  }, [active]);

  return state;
}
