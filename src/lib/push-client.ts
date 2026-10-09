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

// The endpoint this device last registered — per device, like
// EXPECTED_ON_KEY. iOS can answer pushManager.getSubscription() with null on
// a later load while that same subscription is still live and still
// delivering (household report, 2026-10-07: a member's switch and badge
// always read "off", re-enabling made a fresh subscription each time — three
// live endpoints on one phone — and a notification still arrived). Knowing
// the endpoint lets the app ask the server instead (subscriptionIsLive), and
// lets a new subscription replace this device's old row instead of piling up.
const ENDPOINT_KEY = "flow-push-endpoint";

function storedEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

function setStoredEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // storage unavailable — falls back to the browser's own answer only
  }
}

// This browser/home-screen app's own random ID — the server keeps one
// subscription per device (PushSubscription.deviceId), so a phone and a
// laptop can both be on while one phone can't pile up several live
// endpoints (household request, 2026-10-08). Created once, kept forever.
const DEVICE_ID_KEY = "flow-push-device-id";

function deviceId(): string | undefined {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return undefined; // storage unavailable — the row just carries no device
  }
}

// `exclusive` is the explicit "turn notifications on here": this device's
// subscription replaces any other the server holds for the same device.
// Without it (the quiet re-send on every page load, or a silent repair) the
// server only refreshes a row it already holds, never creates one, so a
// stale browser can't resubscribe itself just by being opened. Resolves
// whether this device is subscribed server-side.
async function registerWithServer(subscription: PushSubscription, exclusive: boolean): Promise<boolean> {
  const previous = storedEndpoint();
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...subscription.toJSON(),
      exclusive,
      deviceId: deviceId(),
      // This device's previous endpoint — a silent repair (a new endpoint
      // for the same device) takes over its row.
      replaces: previous && previous !== subscription.endpoint ? previous : undefined,
    }),
  });
  const active = res.ok && ((await res.json()) as { active?: boolean }).active === true;
  setStoredEndpoint(active ? subscription.endpoint : null);
  return active;
}

// Whether the server still holds this user's subscription for `endpoint` —
// it deletes one the moment the push service reports it gone (push.ts), so
// a row still there is a subscription still delivering.
async function subscriptionIsLive(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`);
    if (!res.ok) return false;
    return ((await res.json()) as { active?: boolean }).active === true;
  } catch {
    return false;
  }
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

  // The browser subscribed, but that's only half of it — if the server
  // didn't store it (network error, 5xx, the demo household's 403), nothing
  // will ever be delivered. Throw so the toggle shows the failure instead of
  // flipping on (it used to report "subscribed" regardless; 2026-10-08 review).
  if (!(await registerWithServer(subscription, true))) {
    throw new Error("The server didn't accept this device's push subscription.");
  }
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
      // The server no longer holds this device's subscription (turned off,
      // or replaced) — reads as off here, and the switch turns it back on.
      const active = await registerWithServer(existing, false).catch(() => false);
      return active ? "on" : "off";
    }
    // iOS sometimes reports no subscription for one that's still live — trust
    // the server's record of this device's endpoint over that.
    const remembered = storedEndpoint();
    if (Notification.permission === "granted" && remembered && (await subscriptionIsLive(remembered))) {
      setExpectedOn(true);
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
      if (!(await registerWithServer(subscription, false))) {
        await subscription.unsubscribe().catch(() => {});
        return "off";
      }
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
  // The remembered endpoint covers a device iOS claims has no subscription
  // while the server still delivers to it (see ENDPOINT_KEY).
  const endpoint = subscription?.endpoint ?? storedEndpoint();
  if (!endpoint) return;

  const res = await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  // Refused (an owner locked notifications on) — keep the browser's own
  // subscription too, so the device keeps receiving.
  if (!res.ok) throw new Error("unsubscribe refused");

  await subscription?.unsubscribe();
  setStoredEndpoint(null);
  setExpectedOn(false);
}
