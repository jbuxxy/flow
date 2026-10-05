"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Settings, LogOut, Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type Theme } from "./theme-provider";
import { usePushStatus } from "@/lib/use-push-status";
import { useInstallStatus } from "@/lib/use-install-status";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  PARENT: "Parent",
  CHILD: "Kid",
};

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ProfileMenu({
  user,
  needsAttention = false,
  settingsNeedsAttention = false,
  placement = "down",
}: {
  user: { name?: string | null; role: string };
  // Which way the dropdown opens off the avatar. "down" (default) for the
  // mobile top header; "up" for the desktop sidebar footer, where the avatar
  // sits at the bottom of the viewport.
  placement?: "down" | "up";
  // "Something in Settings needs a look" — bank connection, AI, or a debt
  // needing setup (2026-08-27: narrowed to the Settings chain only; bills
  // are not in it — they light just the /buckets bottom-nav dot). Equal to
  // settingsNeedsAttention today; kept as its own prop since the avatar dot
  // and the dropdown row dot are visually distinct signals.
  needsAttention?: boolean;
  // What the dropdown's own "Settings" row dot shows — the same Settings
  // chain (bank / AI / debt setup). Every bucket/bill/debt-row content-level
  // badge still points to the exact card once someone's navigated in.
  settingsNeedsAttention?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();
  // Two more reasons for the same dot, both only knowable client-side (a
  // browser permission, a display-mode media query) — folded into the same
  // badge chain the server-computed needsAttention/settingsNeedsAttention
  // already drive, rather than a separate dashboard banner/floating popup
  // (household feedback, 2026-09-11: "looks a bit out of place... just
  // badge the profile"). "denied"/"unsupported"/"checking" don't badge —
  // nothing to act on for those (NotificationToggle itself stays hidden
  // for them too).
  const [pushStatus] = usePushStatus();
  const { status: installStatus } = useInstallStatus();
  const notificationsOff = pushStatus === "off";
  const installAvailable = installStatus === "ios-available" || installStatus === "prompt-available";
  const clientNeedsAttention = notificationsOff || installAvailable;
  const themeIndex = THEME_OPTIONS.findIndex((o) => o.value === theme);
  const currentThemeOption = THEME_OPTIONS[themeIndex];
  const nextThemeOption = THEME_OPTIONS[(themeIndex + 1) % THEME_OPTIONS.length];

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const displayName = user.name?.trim() || "Account";
  const initials =
    displayName
      .split(" ")
      .map((n) => n[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={needsAttention || clientNeedsAttention ? "Account Menu — Needs Attention" : "Account Menu"}
        className="relative flex h-9 w-9 items-center justify-center rounded-full bg-blue-900 dark:bg-blue-700 text-sm font-semibold text-white"
      >
        {initials}
        {(needsAttention || clientNeedsAttention) && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[var(--background)] bg-red-600" />
        )}
      </button>

      {open && (
        <div
          className={`absolute z-[var(--z-overlay)] w-48 overflow-hidden rounded-xl border border-blue-100 dark:border-neutral-800 bg-[var(--background)] py-1 shadow-lg ${
            placement === "up" ? "bottom-11 left-0" : "top-11 right-0"
          }`}
        >
          <div className="px-3 py-1.5">
            <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{displayName}</p>
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              {ROLE_LABEL[user.role] ?? user.role}
            </p>
          </div>
          <div className="my-1 border-t border-blue-100 dark:border-neutral-800" />
          <button
            onClick={() => setTheme(nextThemeOption.value)}
            aria-label={`Theme: ${currentThemeOption.label}. Tap to switch to ${nextThemeOption.label}.`}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-blue-50 dark:hover:bg-neutral-800"
          >
            <currentThemeOption.icon size={16} />
            <span className="text-neutral-500 dark:text-neutral-400">{currentThemeOption.label}</span>
          </button>
          <div className="my-1 border-t border-blue-100 dark:border-neutral-800" />
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 hover:bg-blue-50 dark:hover:bg-neutral-800"
          >
            <Settings size={16} />
            Settings
            {(settingsNeedsAttention || clientNeedsAttention) && (
              <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" />
            )}
          </Link>
          <div className="my-1 border-t border-blue-100 dark:border-neutral-800" />
          <button
            onClick={() => signOut({ redirectTo: "/login" })}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            <LogOut size={16} />
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
