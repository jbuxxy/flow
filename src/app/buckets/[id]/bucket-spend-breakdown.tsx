import type { ReactNode } from "react";
import { BucketSpendBreakdownCard } from "./bucket-spend-breakdown-card";

// The bucket page's spend-breakdown carousel (up to two slides) — this
// cycle's REAL spend so far, grouped by category and by merchant. Doubles as an in-page filter
// control (2026-08-26): tapping a row toggles it as a filter on the entry
// cards below (Recurring + Singles), wired through BucketEntryFilterProvider
// (the interactive row list lives in bucket-spend-breakdown-list.tsx so this
// module can stay a server component). Callers resolve each entry's category
// label up front (2026-08-24) rather than passing raw transactions + a
// categories list: a RECURRING/MIXED bucket's real spend has to merge two
// sources — plain bucketId-scoped transactions AND debt-payment-linked ones
// (whose own categoryId is always null; only their DebtPayment.categoryId
// carries a label, see buckets/[id]/page.tsx) — and resolving that here would
// mean duplicating the same category-lookup logic the page already needs for
// its own DebtPayment query.
// amountCents is always the FULL amount out the door — this breakdown shows
// real total spend, not the capped bucket figure. excludedCents is the
// portion of that which is extra debt paydown past the cycle's ceiling
// (minimum + payoff-plan extra) and so is NOT in the bucket total / pace /
// alerts (2026-08-28 household call) — informational, drives the row's
// annotation only. See budgetedDebtPaymentCents, src/lib/debt-payment-budget.ts.
export type SpendEntry = { amountCents: number; categoryLabel: string; merchant: string; excludedCents?: number };

// The category / merchant labels in the order the breakdown cards lay them out
// — descending by real spend this cycle, the same sort `toBreakdown` /
// `spendBreakdownCards` use to key the donut wedge colors. Fed to
// BucketEntryFilterProvider so a selected filter's color (chip + entry-card
// left edge) is chosen by the label's wedge position, not by tap order — the
// donut and the filters stay in sync.
export function spendBreakdownLabelOrder(entries: SpendEntry[]): { category: string[]; merchant: string[] } {
  const byCategory = new Map<string, number>();
  const byMerchant = new Map<string, number>();
  for (const e of entries) {
    byCategory.set(e.categoryLabel, (byCategory.get(e.categoryLabel) ?? 0) + e.amountCents);
    byMerchant.set(e.merchant, (byMerchant.get(e.merchant) ?? 0) + e.amountCents);
  }
  const order = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  return { category: order(byCategory), merchant: order(byMerchant) };
}

function toBreakdown(
  countByLabel: Map<string, number>,
  excludedByLabel: Map<string, number>,
): { label: string; cents: number; excludedCents: number }[] {
  return [...countByLabel.entries()]
    .map(([label, cents]) => ({ label, cents, excludedCents: excludedByLabel.get(label) ?? 0 }))
    .sort((a, b) => b.cents - a.cents);
}

// Returns 0-2 StatCard slides — category and/or merchant, each only when
// there's more than one distinct label to actually break down (nothing to
// show if every dollar landed under one label). `filterCategories` /
// `filterMerchants` are the labels that some entry card on the page
// actually carries — only those rows become filter toggles (see
// BreakdownList). Meant to be spread directly as SwipeCarousel children,
// not rendered as its own
// component — SwipeCarousel needs each slide as a direct child to measure/key
// individually, which an array-returning function satisfies but a wrapping
// component (whose own conditional null-return still counts as one child)
// would not.
export function spendBreakdownCards(
  entries: SpendEntry[],
  filterCategories: string[],
  filterMerchants: string[],
): ReactNode[] {
  if (entries.length === 0) return [];

  const byCategory = new Map<string, number>();
  const byMerchant = new Map<string, number>();
  const excludedByCategory = new Map<string, number>();
  const excludedByMerchant = new Map<string, number>();
  for (const e of entries) {
    byCategory.set(e.categoryLabel, (byCategory.get(e.categoryLabel) ?? 0) + e.amountCents);
    byMerchant.set(e.merchant, (byMerchant.get(e.merchant) ?? 0) + e.amountCents);
    if (e.excludedCents) {
      excludedByCategory.set(e.categoryLabel, (excludedByCategory.get(e.categoryLabel) ?? 0) + e.excludedCents);
      excludedByMerchant.set(e.merchant, (excludedByMerchant.get(e.merchant) ?? 0) + e.excludedCents);
    }
  }
  const categoryBreakdown = toBreakdown(byCategory, excludedByCategory);
  const merchantBreakdown = toBreakdown(byMerchant, excludedByMerchant);
  const total = entries.reduce((sum, e) => sum + e.amountCents, 0);

  const cards: ReactNode[] = [];
  if (categoryBreakdown.length > 1) {
    cards.push(
      <BucketSpendBreakdownCard
        key="category"
        dim="category"
        title="Spending by Category"
        total={total}
        entries={categoryBreakdown}
        filterable={filterCategories}
      />,
    );
  }
  if (merchantBreakdown.length > 1) {
    cards.push(
      <BucketSpendBreakdownCard
        key="merchant"
        dim="merchant"
        title="Spending by Merchant"
        total={total}
        entries={merchantBreakdown}
        filterable={filterMerchants}
      />,
    );
  }
  return cards;
}
