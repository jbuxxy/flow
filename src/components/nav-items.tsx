import {
  Home,
  LayoutGrid,
  CreditCard,
  PiggyBank,
  Banknote,
  PieChart,
  ReceiptText,
  Landmark,
  Settings,
  type LucideIcon,
} from "lucide-react";

// Single source of truth for primary navigation, shared by the mobile
// BottomNav and the desktop DesktopSidebar so the two can never drift. This
// file is deliberately NOT a client component — it's just data + a pure
// helper, imported by both navs (each of which is `"use client"` itself).

export type NavAccess = { fullAccess: boolean; canViewNetWorth: boolean };

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  show: (access: NavAccess) => boolean;
};

// The mobile bottom bar is space-capped at 6 tabs — this is that set, in
// order. `show` replaces the old `fullAccessOnly` boolean (BottomNav used to
// filter on `fullAccess || !fullAccessOnly`, which is exactly `show({...})`).
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: Home, show: () => true },
  { href: "/buckets", label: "Buckets", icon: LayoutGrid, show: () => true },
  { href: "/income", label: "Income", icon: Banknote, show: (a) => a.fullAccess },
  { href: "/debts", label: "Debts", icon: CreditCard, show: (a) => a.fullAccess },
  { href: "/savings", label: "Goals", icon: PiggyBank, show: (a) => a.fullAccess },
  { href: "/reports", label: "Reports", icon: PieChart, show: (a) => a.fullAccess },
];

// Extra destinations the sidebar has room for that the bottom bar doesn't —
// today reachable only via in-page links or the profile menu.
export const NAV_ITEMS_DESKTOP_EXTRA: readonly NavItem[] = [
  { href: "/transactions", label: "Transactions", icon: ReceiptText, show: (a) => a.fullAccess },
  { href: "/networth", label: "Net Worth", icon: Landmark, show: (a) => a.canViewNetWorth },
  { href: "/settings", label: "Settings", icon: Settings, show: () => true },
];

// Same active-tab rule both navs have always used: exact match for Home,
// prefix match for everything else.
export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
