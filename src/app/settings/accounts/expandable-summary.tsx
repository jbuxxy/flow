"use client";

import { ChevronDown } from "lucide-react";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

// The tap-to-expand half of every entry on /settings/accounts (connected
// accounts, BNPL, manual cards/loans). The entry's title row stays outside
// this — it carries its own pencil/hide/receipt buttons, and a button can't
// nest inside a button — so the summary line underneath (terms + balance) is
// the toggle instead, with the house chevron on the right (see
// bucket-allocation-card.tsx). Open state persists per entry via
// useStoredBoolean. Anything with its own link/button (a "Not Counted — Add
// It" line, the Track-as-Debt form) goes in `footer`, outside the button.
export function ExpandableSummary({
  storageKey,
  summary,
  balance,
  footer,
  children,
}: {
  storageKey: string;
  // Left column — the existing one-line terms/status text. Phrasing content
  // only (spans), since it renders inside a <button>.
  summary: React.ReactNode;
  // Right column — the balance figure.
  balance: React.ReactNode;
  footer?: React.ReactNode;
  // The expanded detail panel.
  children: React.ReactNode;
}) {
  const [open, setOpen] = useStoredBoolean(`flow:account-card:${storageKey}`, false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? "Hide Details" : "Show Details"}
        className="mt-0.5 flex w-full items-start justify-between gap-2 text-left"
      >
        <span className="block min-w-0 flex-1">{summary}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {balance}
          <ChevronDown
            size={18}
            className={`shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {footer}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-2.5 flex flex-col gap-3 border-t border-blue-100 dark:border-neutral-800 pt-3">{children}</div>
        </div>
      </div>
    </>
  );
}
