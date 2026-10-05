"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { formatCents } from "@/lib/money";

// Net worth items grouped by type (Cash/Retirement/Property/Investments/
// Crypto/Other) — each section collapsible independently so a household
// with a lot of accounts can fold away the ones they don't need to check
// every visit. Defaults open since nothing should visually disappear the
// first time this ships.
export function CollapsibleGroup({
  title,
  totalCents,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  totalCents: number;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
          <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          {title} ({count})
        </span>
        <span
          className={`text-sm font-medium ${totalCents < 0 ? "text-red-600 dark:text-red-400" : "text-neutral-900 dark:text-neutral-100"}`}
        >
          {formatCents(totalCents)}
        </span>
      </button>
      {open && <div className="mt-3 flex flex-col gap-2">{children}</div>}
    </div>
  );
}
