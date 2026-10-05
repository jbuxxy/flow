"use client";

import { Check, Download, Smartphone } from "lucide-react";
import { useInstallStatus } from "@/lib/use-install-status";
import { showToast } from "@/lib/toast";

// The Settings home for what used to be a fixed-position popup on every
// page (household request, 2026-09-11: "out of place... just badge the
// profile and this entry instead"). Renders nothing once installed, already
// dismissed, or genuinely unavailable (a desktop browser that hasn't fired
// beforeinstallprompt yet) — ProfileMenu's own badge is what tells someone
// there's something to look at here in the first place.
export function InstallAppCard() {
  const { status, install, dismiss } = useInstallStatus();

  if (status === "checking" || status === "installed" || status === "dismissed" || status === "unavailable") {
    return null;
  }

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
        <Smartphone size={16} />
        Install Flow
      </h2>
      {status === "ios-available" ? (
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
          Tap the Share icon, then <strong>Add to Home Screen</strong> — quick access and notifications, same as any
          other app.
        </p>
      ) : (
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
          Install Flow for quick access and notifications.
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-3">
        <button
          onClick={() => {
            dismiss();
            showToast("Dismissed");
          }}
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
        >
          Not Now
        </button>
        {status === "ios-available" ? (
          <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <Check size={15} />
            Got It
          </span>
        ) : (
          <button
            onClick={() => void install()}
            className="flex items-center gap-1.5 rounded-lg bg-blue-900 px-4 py-2 text-sm font-medium text-white dark:bg-blue-700"
          >
            <Download size={15} />
            Install
          </button>
        )}
      </div>
    </div>
  );
}
