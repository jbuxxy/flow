"use client";

import { createContext, useContext, useState } from "react";
import { SelectField } from "@/components/select-field";
import type { RecurringSortOrder as SortOrder } from "@/lib/recurring-sort";

export type { SortOrder };

const RecurringSortContext = createContext<{
  sortOrder: SortOrder;
  setSortOrder: (order: SortOrder) => void;
} | null>(null);

// The "Sort By" control lives on the page's title line (rendered into
// AppShell's `titleActions` slot) while the list it reorders is AppShell's
// `children` — this provider wraps the whole <AppShell> so the two share one
// sortOrder. AppShell is an async server component handed to this client
// provider as `children`, which is fine: a client component can render
// server components passed to it as props.
export function RecurringSortProvider({ children }: { children: React.ReactNode }) {
  const [sortOrder, setSortOrder] = useState<SortOrder>("dueDate");
  return (
    <RecurringSortContext.Provider value={{ sortOrder, setSortOrder }}>{children}</RecurringSortContext.Provider>
  );
}

export function useRecurringSort() {
  const ctx = useContext(RecurringSortContext);
  if (!ctx) throw new Error("useRecurringSort must be used within RecurringSortProvider");
  return ctx;
}

// Same control BucketBillsSection renders (bucket-bills-section.tsx) — only
// shown when there's more than one row to reorder. No "Sort By" label — the
// dropdown's own options (Due Date / A–Z) already say what it does (household
// feedback, 2026-09-14).
export function RecurringSortControl({ show }: { show: boolean }) {
  const { sortOrder, setSortOrder } = useRecurringSort();
  if (!show) return null;
  return (
    <div className="-mr-1 flex shrink-0 items-center gap-2 text-xs text-gray-500 dark:text-neutral-400">
      <SelectField
        value={sortOrder}
        onChange={(v) => setSortOrder(v as SortOrder)}
        options={[
          { value: "dueDate", label: "Due Date" },
          { value: "alphabetical", label: "A–Z" },
        ]}
        small
        searchable={false}
        className="w-32"
      />
    </div>
  );
}
