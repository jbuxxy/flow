"use client";

import { useEffect, useState } from "react";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

// Shared detection logic — factored out of the old floating InstallPrompt
// popup (2026-09-11 household request: badge the profile icon + a Settings
// entry instead of a fixed-position popup) so both the badge (ProfileMenu)
// and the new Settings "Install App" card read the same status without
// duplicating the browser-feature-detection branching.
export type InstallStatus =
  | "checking"
  | "installed"
  | "ios-available"
  | "prompt-available"
  | "unavailable"
  | "dismissed";

const DISMISSED_KEY = "flow-install-prompt-dismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's non-standard flag for "already added to Home Screen"
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

// The browser-feature half of status, independent of dismissal — computed
// once (via the effect below, deferred into a callback per
// react-hooks/set-state-in-effect — see use-push-status.ts's identical
// comment on why) and never itself knows about the dismissed flag; useInstallStatus
// below layers that on top from useStoredBoolean so every mounted instance
// reacts the moment *any* of them calls dismiss(), not just the one that
// was clicked.
type FeatureStatus = "checking" | "installed" | "ios-available" | "prompt-available" | "unavailable";

function initialFeatureStatus(): FeatureStatus {
  if (isStandalone()) return "installed";
  if (isIos()) return "ios-available";
  return "unavailable";
}

export function useInstallStatus(): { status: InstallStatus; install: () => Promise<void>; dismiss: () => void } {
  const [featureStatus, setFeatureStatus] = useState<FeatureStatus>("checking");
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  // A real, shared pub-sub (useSyncExternalStore under the hood) — every
  // useInstallStatus() instance in the tree (ProfileMenu's badge,
  // InstallAppCard) reacts the instant any one of them calls dismiss(),
  // unlike a plain localStorage.setItem() a sibling instance's own state
  // would never learn about. Real report, 2026-09-12 code review: the
  // previous plain-localStorage version left "Not Now" appearing to do
  // nothing — the card and the profile badge both stayed visible until a
  // full page reload, since dismissing only ever wrote storage and no
  // mounted hook instance was listening for that write.
  const [dismissed, setDismissed] = useStoredBoolean(DISMISSED_KEY, false);

  // setState only ever runs inside a callback (event handler / promise),
  // never synchronously in the effect body — see use-push-status.ts's own
  // comment on why (react-hooks/set-state-in-effect).
  useEffect(() => {
    // Reading it synchronously here (not the setState call) is fine — only
    // dispatching the *result* into state has to wait for a callback.
    const initial = initialFeatureStatus();
    Promise.resolve().then(() => setFeatureStatus(initial));
    if (initial !== "unavailable") return;

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setFeatureStatus("prompt-available");
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    if (outcome === "accepted") setFeatureStatus("installed");
  }

  function dismiss(): void {
    setDismissed(true);
  }

  // "installed" always wins (dismissing is moot once it's actually
  // installed); otherwise dismissed beats whatever the feature-detection
  // side says, same precedence the old single-status version had.
  const status: InstallStatus =
    featureStatus === "checking" || featureStatus === "installed"
      ? featureStatus
      : dismissed
        ? "dismissed"
        : featureStatus;

  return { status, install, dismiss };
}
