"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isActive, type NavItem } from "./nav-items";

// The profile icon (app-shell.tsx/profile-menu.tsx) badges only for the
// Settings chain (bank / AI / debt setup). A tab whose own page has
// something pending gets its own small dot here instead — bills point ONLY
// to /buckets (2026-08-27: a household with just unconfirmed bill due dates
// had a badged profile icon that led nowhere, since bills have no Settings
// surface), debts point to both /debts and the Settings chain. bank/AI live
// in Settings, not a tab, so they only ever show on the profile icon.
//
// Tab list lives in nav-items.tsx now, shared with the desktop sidebar.
// Below `lg` this is the only nav; at `lg`+ AppShell passes `lg:hidden` and
// the sidebar takes over.
export function BottomNav({
  fullAccess,
  canViewNetWorth = false,
  attention = {},
  className = "",
}: {
  fullAccess: boolean;
  canViewNetWorth?: boolean;
  attention?: Partial<Record<string, boolean>>;
  className?: string;
}) {
  const pathname = usePathname();
  const access = { fullAccess, canViewNetWorth };
  const tabs: readonly NavItem[] = NAV_ITEMS.filter((t) => t.show(access));

  return (
    <nav
      className={`fixed inset-x-0 bottom-0 z-[var(--z-chrome)] border-t border-blue-100 dark:border-neutral-800 bg-[var(--background)]/95 backdrop-blur ${className}`}
      style={{ paddingBottom: "max(0.375rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex max-w-md items-stretch justify-between px-1">
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
                active ? "text-blue-900 dark:text-blue-300" : "text-gray-400 dark:text-neutral-500"
              }`}
            >
              <span className="relative">
                <Icon
                  size={22}
                  strokeWidth={active ? 2.4 : 2}
                  className={`transition-transform duration-200 ${active ? "scale-110" : ""}`}
                />
                {attention[href] && (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-[var(--background)] bg-red-600" />
                )}
              </span>
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
