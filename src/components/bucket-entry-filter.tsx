"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { X } from "lucide-react";
import { filterColor } from "@/lib/filter-colors";

// In-page, ephemeral filter shared by the bucket detail page's spend-breakdown
// carousel (the write side — tap a category/merchant row to toggle it) and
// every entry card below it (the read side — Recurring bills/debt payments/
// patterns and the Singles list). No URL or server state: reload clears it.
//
// Category and merchant are mutually exclusive (household rule, 2026-08-26):
// picking a merchant row while categories are active swaps the whole selection
// over to merchant, and vice-versa. Color coding only kicks in at 2+ selected
// values — a single selection just narrows the list.
//
// The context has an inert default so the shared row components (BillRow,
// DebtPaymentCard, PatternRow) render unchanged on /bills, /debts and
// /transactions, where no provider wraps them.

export type FilterDim = "category" | "merchant";

const UNCATEGORIZED = "Uncategorized";

export type FilterState = { dim: FilterDim | null; values: string[] };

// Pure predicate version of useEntryFilter's own hidden/shown rule, factored
// out so a LIST that needs to know its filtered COUNT up front (for a "N of
// M" line, or to paginate) can filter a plain array in one pass instead of
// each row deciding for itself at render time. Same "Uncategorized" fallback
// convention; unlike useEntryFilter this never reads context — callers pass
// the state they got from useBucketEntryFilter() themselves.
export function matchesEntryFilter(
  state: FilterState,
  categoryName: string | null,
  merchant: string | null,
): boolean {
  if (state.dim === null) return true;
  const own = state.dim === "category" ? categoryName ?? UNCATEGORIZED : merchant;
  return own !== null && state.values.includes(own);
}

type FilterContextValue = {
  state: FilterState;
  active: boolean;
  toggle: (dim: FilterDim, value: string) => void;
  clear: () => void;
  isSelected: (dim: FilterDim, value: string) => boolean;
  colorIndexOf: (dim: FilterDim, value: string) => number;
};

const INERT: FilterContextValue = {
  state: { dim: null, values: [] },
  active: false,
  toggle: () => {},
  clear: () => {},
  isSelected: () => false,
  colorIndexOf: () => -1,
};

const BucketEntryFilterContext = createContext<FilterContextValue>(INERT);

// `categoryValues` / `merchantValues` are the labels currently present in the
// spend breakdown (derived from the same entries the carousel cards show). The
// selection is reconciled against them every render: a value whose row has left
// the breakdown — e.g. the household moved every transaction out of that
// category since it was picked — is dropped, and once a dimension has ≤1
// distinct label left (its breakdown card no longer renders) the whole filter
// clears. Pure render-time derivation, no set-state-in-effect.
//
// `categoryOrder` / `merchantOrder` are the same labels sorted by real spend
// this cycle (spendBreakdownLabelOrder) — the order the donut assigns wedge
// hues in. `colorIndexOf` returns a label's position here so a selected
// filter's color matches its wedge instead of tracking tap order.
export function BucketEntryFilterProvider({
  categoryValues,
  merchantValues,
  categoryOrder = [],
  merchantOrder = [],
  children,
}: {
  categoryValues: string[];
  merchantValues: string[];
  categoryOrder?: string[];
  merchantOrder?: string[];
  children: React.ReactNode;
}) {
  const [raw, setRaw] = useState<FilterState>({ dim: null, values: [] });

  const value = useMemo<FilterContextValue>(() => {
    const valid = raw.dim === "category" ? categoryValues : raw.dim === "merchant" ? merchantValues : [];
    const pruned = raw.values.filter((v) => valid.includes(v));
    const dim: FilterDim | null =
      raw.dim !== null && pruned.length > 0 && valid.length > 1 ? raw.dim : null;
    const values = dim ? pruned : [];

    return {
      state: { dim, values },
      active: dim !== null,
      toggle: (d, v) => {
        if (dim !== d) {
          setRaw({ dim: d, values: [v] });
          return;
        }
        const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
        setRaw(next.length === 0 ? { dim: null, values: [] } : { dim: d, values: next });
      },
      clear: () => setRaw({ dim: null, values: [] }),
      isSelected: (d, v) => dim === d && values.includes(v),
      colorIndexOf: (d, v) => (d === "category" ? categoryOrder : merchantOrder).indexOf(v),
    };
  }, [raw, categoryValues, merchantValues, categoryOrder, merchantOrder]);

  return <BucketEntryFilterContext.Provider value={value}>{children}</BucketEntryFilterContext.Provider>;
}

export function useBucketEntryFilter(): FilterContextValue {
  return useContext(BucketEntryFilterContext);
}

// Read side for an entry card. Pass the card's category name (null → treated as
// "Uncategorized") and its merchant (null when the card has no merchant, e.g. a
// pattern — such a card is hidden whenever a merchant filter is active).
export function useEntryFilter(
  categoryName: string | null,
  merchant: string | null,
): { hidden: boolean; barClass: string } {
  const { state, colorIndexOf } = useContext(BucketEntryFilterContext);
  // matchesEntryFilter only ever returns false when a filter is active AND
  // this entry doesn't match it (it's a pass-through when no filter is set).
  if (!matchesEntryFilter(state, categoryName, merchant)) return { hidden: true, barClass: "" };
  if (state.dim === null) return { hidden: false, barClass: "" };

  // Colored left edge only when there's more than one value to tell apart —
  // keyed to the label's donut-wedge position so the edge matches the wedge.
  // Non-null: matchesEntryFilter above already returned true, which is only
  // possible when `own` matched one of state.values — TS just can't see that
  // guarantee across the function call.
  const own = (state.dim === "category" ? categoryName ?? UNCATEGORIZED : merchant)!;
  const barClass = state.values.length >= 2 ? `border-l-4! ${filterColor(colorIndexOf(state.dim, own)).bar}` : "";
  return { hidden: false, barClass };
}

export function ClearFiltersButton() {
  const { active, clear } = useBucketEntryFilter();
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={clear}
      className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200"
    >
      <X size={13} />
      Clear
    </button>
  );
}

// Visible confirmation of what the tap-a-row filter is currently narrowing the
// entry cards to — announced via aria-live so a screen reader hears the change.
export function ActiveEntryFilterSummary() {
  const { state } = useBucketEntryFilter();
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="text-xs text-gray-500 dark:text-neutral-400"
      hidden={state.dim === null}
    >
      {state.dim !== null &&
        `Showing Only ${state.dim === "category" ? "Category" : "Merchant"}: ${state.values.join(" · ")}`}
    </p>
  );
}
