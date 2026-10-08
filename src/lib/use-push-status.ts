"use client";

import { useEffect, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { ensurePushSubscription } from "@/lib/push-client";

export type PushStatus = "checking" | "off" | "on" | "denied" | "unsupported";

// One status for the whole page, not one per hook instance. Every reader —
// NotificationToggle, the Settings card's tint + dot, ProfileMenu's avatar
// badge, the dashboard's warning carousel — sees a flip the moment the
// toggle makes it. Per-instance useState (the 2026-08-22 version) left the
// badges red after turning notifications on, and a component mounted later
// still read the stale "off" from ensurePushSubscription's cached first
// result (household report, 2026-10-08).
let current: PushStatus = "checking";
const listeners = new Set<() => void>();

function setShared(next: SetStateAction<PushStatus>): void {
  const value = typeof next === "function" ? next(current) : next;
  if (value === current) return;
  current = value;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Returns a setter too since NotificationToggle updates it optimistically
// after a subscribe/unsubscribe action completes.
export function usePushStatus(): [PushStatus, Dispatch<SetStateAction<PushStatus>>] {
  const status = useSyncExternalStore(subscribe, () => current, () => "checking" as const);

  useEffect(() => {
    // Not just a read: repairs a subscription the OS silently dropped (see
    // ensurePushSubscription). Shared across every mounted instance, so the
    // repair runs at most once per page load — and only seeds the store
    // while it's still unresolved, so it never overwrites a newer toggle.
    ensurePushSubscription()
      .then((result) => setShared((s) => (s === "checking" ? (result === "repaired" ? "on" : result) : s)))
      .catch(() => setShared((s) => (s === "checking" ? "unsupported" : s)));
  }, []);

  return [status, setShared];
}
