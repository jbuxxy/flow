"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { ProfileMenu } from "./profile-menu";
import {
  NAV_ITEMS,
  NAV_ITEMS_DESKTOP_EXTRA,
  isActive,
  type NavItem,
} from "./nav-items";

// Desktop-only left rail — the counterpart to BottomNav, sharing NAV_ITEMS.
// Visibility is pure CSS (`hidden lg:flex`): it's always in the DOM, so
// there's no matchMedia / hydration branch. Below `lg` the bottom bar is the
// nav and this is display:none. Fixed width, no collapse toggle (simplest;
// there's nothing to persist and no drawer to build).
export function DesktopSidebar({
  user,
  fullAccess,
  canViewNetWorth,
  needsAttention = false,
  settingsNeedsAttention = false,
  attention = {},
}: {
  user: { name?: string | null; role: string };
  fullAccess: boolean;
  canViewNetWorth: boolean;
  needsAttention?: boolean;
  settingsNeedsAttention?: boolean;
  attention?: Partial<Record<string, boolean>>;
}) {
  const pathname = usePathname();
  const access = { fullAccess, canViewNetWorth };
  const primary: NavItem[] = NAV_ITEMS.filter((t) => t.show(access));
  const extra: NavItem[] = NAV_ITEMS_DESKTOP_EXTRA.filter((t) => t.show(access));

  function renderItem({ href, label, icon: Icon }: NavItem) {
    const active = isActive(pathname, href);
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
          active
            ? "bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300"
            : "text-gray-500 dark:text-neutral-400 hover:bg-blue-50/60 dark:hover:bg-neutral-800/50"
        }`}
      >
        <Icon size={20} strokeWidth={active ? 2.4 : 2} className="shrink-0" />
        <span className="truncate">{label}</span>
        {attention[href] && (
          <span
            className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-600"
            aria-label="Needs Attention"
          />
        )}
      </Link>
    );
  }

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-y-0 left-0 z-[var(--z-chrome)] hidden w-64 flex-col border-r border-blue-100 dark:border-neutral-800 bg-[var(--background)] py-4 lg:flex xl:w-72"
      style={{ paddingLeft: "max(0.75rem, env(safe-area-inset-left))", paddingRight: "0.75rem" }}
    >
      <Link href="/" className="flex items-center px-2 pb-4">
        <Image
          src="/icons/flowText.png"
          alt="flow"
          width={269}
          height={104}
          className="h-7 w-auto"
          priority
        />
      </Link>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {primary.map(renderItem)}
        {extra.length > 0 && (
          <div className="my-2 border-t border-blue-100 dark:border-neutral-800" />
        )}
        {extra.map(renderItem)}
      </div>

      <div className="mt-auto flex items-center gap-3 border-t border-blue-100 dark:border-neutral-800 px-1 pt-3">
        <ProfileMenu
          user={user}
          needsAttention={needsAttention}
          settingsNeedsAttention={settingsNeedsAttention}
          placement="up"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {user.name?.trim() || "Account"}
          </p>
        </div>
      </div>
    </nav>
  );
}
