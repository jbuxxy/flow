"use client";

import { ChevronUp, TriangleAlert } from "lucide-react";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

const STORAGE_PREFIX = "flow-collapsed:";

// Same remembered-collapse mechanism CollapsibleWarningCard uses for
// itself, exposed so WarningCardCarousel can drive one shared collapsed
// state across every card it holds (see that component's own comment for
// why: independent per-card state left a short, collapsed card next to a
// tall, expanded one, breaking the carousel's height on swipe).
// Passthrough shape every warning-card wrapper (NeedsSetupWarning,
// MinPaymentWarning, BillsNeedDueDateWarning, CountWarning,
// SuggestionListWarning) accepts and forwards straight to its own
// CollapsibleWarningCard, so WarningCardCarousel can drive all of them as
// one group.
export type CollapseControlProps = { collapsed?: boolean; onToggle?: () => void };

export function useCollapsedState(storageKey: string): [boolean, (next: boolean) => void] {
  return useStoredBoolean(STORAGE_PREFIX + storageKey, false);
}

// Shared shell for every "needs attention" card (MinPaymentWarning,
// NeedsSetupWarning, BillsNeedDueDateWarning, CountWarning,
// SuggestionListWarning) — same icon+heading row, same collapse-and-
// remember behavior, so collapsing one of these anywhere behaves the same
// as collapsing any other (2026-08-19). `storageKey` is per card *type*
// (and, for CountWarning, per instance) — not per rendered instance — so
// collapsing "Debts need setup" on the dashboard also starts it collapsed
// on /debts and /settings/simplefin, the same way dismissing an item there
// is one shared piece of state, not a per-page one. See useStoredBoolean
// (src/lib/use-stored-boolean.ts) for why this is useSyncExternalStore-based
// rather than a lazy useState + effect.
export function CollapsibleWarningCard({
  storageKey,
  color,
  title,
  children,
  collapsed: collapsedOverride,
  onToggle,
}: {
  storageKey: string;
  color: "red" | "yellow";
  title: string;
  children: React.ReactNode;
  // WarningCardCarousel passes both of these to make every card in the
  // carousel expand/collapse together instead of independently — omitted
  // everywhere else, where each card keeps tracking its own storageKey.
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const [ownCollapsed, setOwnCollapsed] = useCollapsedState(storageKey);
  const collapsed = collapsedOverride ?? ownCollapsed;
  const toggle = onToggle ?? (() => setOwnCollapsed(!ownCollapsed));

  const palette =
    color === "red"
      ? {
          border: "border-red-200 dark:border-red-900",
          bg: "bg-red-50 dark:bg-red-950/40",
          heading: "text-red-800 dark:text-red-300",
          chevron: "text-red-400 hover:text-red-700 dark:text-red-500 dark:hover:text-red-300",
        }
      : {
          border: "border-yellow-200 dark:border-yellow-900",
          bg: "bg-yellow-50 dark:bg-yellow-950/40",
          heading: "text-yellow-800 dark:text-yellow-300",
          chevron: "text-yellow-400 hover:text-yellow-700 dark:text-yellow-500 dark:hover:text-yellow-300",
        };

  return (
    <div className={`rounded-xl border ${palette.border} ${palette.bg} p-4`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className={`flex w-full items-center gap-1.5 text-sm font-semibold ${palette.heading}`}
      >
        <TriangleAlert size={16} className="shrink-0" />
        {/* font-comfortaa explicitly: this is a <span> inside a <button>, so the
            global h1-h6 Comfortaa rule (globals.css) doesn't reach it — without
            it every warning card's title fell back to the body sans while the
            h2-titled cards beside it (Payday, Quick Confirm, Paid Off) used
            the app's heading font (2026-09-19). */}
        <span className="flex-1 text-left font-comfortaa">{title}</span>
        <ChevronUp
          size={16}
          className={`transition-transform ${palette.chevron} ${collapsed ? "rotate-180" : ""}`}
        />
      </button>
      {!collapsed && children}
    </div>
  );
}
