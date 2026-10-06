import { showToast } from "@/lib/toast";

// Web Push requires the VAPID public key as a Uint8Array, but it's
// distributed as a URL-safe base64 string.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

// "This device had notifications on last we saw" — set whenever a
// subscription is created or observed, cleared when someone turns them off
// here. ensurePushSubscription only repairs a device with this set, so a
// deliberate off (including one made before this flag existed) is never
// switched back on. Per device, like the subscription itself.
const EXPECTED_ON_KEY = "flow-push-expected-on";

function setExpectedOn(value: boolean): void {
  try {
    if (value) localStorage.setItem(EXPECTED_ON_KEY, "1");
    else localStorage.removeItem(EXPECTED_ON_KEY);
  } catch {
    // storage unavailable (private browsing) — repair just never triggers
  }
}

function isExpectedOn(): boolean {
  try {
    return localStorage.getItem(EXPECTED_ON_KEY) === "1";
  } catch {
    return false;
  }
}

async function registerWithServer(subscription: PushSubscription): Promise<void> {
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
}

export async function subscribeToPush(): Promise<"subscribed" | "denied" | "unsupported"> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set");

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await registerWithServer(subscription);
  setExpectedOn(true);

  return "subscribed";
}

// Self-repair, run once per page load by usePushStatus. iOS can silently
// drop a home-screen app's push subscription (an OS update, storage
// pressure, the icon re-added) while notification permission stays
// "granted" — the device just stops receiving, and nobody notices until
// they happen to open Settings (household report, 2026-10-05). When
// permission is still granted and this device was last seen on (see
// EXPECTED_ON_KEY), quietly subscribe
// again (no prompt — permission already exists). Also re-sends an existing
// subscription so the server's row can't drift (it deletes rows the push
// service reports gone). If the browser refuses a gesture-less subscribe,
// this resolves "off" and the profile icon's existing red dot takes over.
export type EnsureResult = "on" | "repaired" | "off" | "denied" | "unsupported";

let ensureOnce: Promise<EnsureResult> | null = null;

export function ensurePushSubscription(): Promise<EnsureResult> {
  ensureOnce ??= (async (): Promise<EnsureResult> => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
      return "unsupported";
    }
    if (Notification.permission === "denied") return "denied";
    const existing = await currentPushSubscription();
    if (existing) {
      setExpectedOn(true);
      registerWithServer(existing).catch(() => {});
      return "on";
    }
    if (Notification.permission !== "granted" || !isExpectedOn()) return "off";

    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) return "off";
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await registerWithServer(subscription);
      showToast("Notifications Reconnected");
      return "repaired";
    } catch {
      return "off";
    }
  })();
  return ensureOnce;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;

  const res = await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  // Refused (an owner locked notifications on) — keep the browser's own
  // subscription too, so the device keeps receiving.
  if (!res.ok) throw new Error("unsubscribe refused");

  await subscription.unsubscribe();
  setExpectedOn(false);
}
