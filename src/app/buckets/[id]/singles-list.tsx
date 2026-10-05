"use client";

import { useMemo, useState, type ComponentProps } from "react";
import { TransactionRow } from "./transaction-row";
import { ResultCount } from "@/components/result-count";
import { useBucketEntryFilter, matchesEntryFilter, type FilterState } from "@/components/bucket-entry-filter";
import type { CategoryOption } from "@/app/bills/category-picker";
import type { ReimbursementCandidate } from "@/components/reimbursement-linker";

type BucketOption = { id: string; name: string; trackingMode: "SPEND" | "RECURRING" | "MIXED" };
type DebtOption = { id: string; name: string };
type RowTransaction = ComponentProps<typeof TransactionRow>["transaction"];

export type SinglesRow = {
  id: string;
  // Carried alongside `transaction` (not read off it) so filtering never has
  // to reach into TransactionRow's own prop shape — categoryId resolves to a
  // name the same way TransactionRow itself does (see categoryNameOf below).
  categoryId: string | null;
  merchant: string;
  transaction: RowTransaction;
  labelSuggestions: string[];
  reimbursementSuggestions: ReimbursementCandidate[];
};

const PAGE_SIZE = 20;

function categoryNameOf(categoryId: string | null, categories: CategoryOption[]): string | null {
  return categoryId ? (categories.find((c) => c.id === categoryId)?.name ?? null) : null;
}

// The bucket detail page's Singles list — capped to PAGE_SIZE with a "N of M"
// count and a pager, both filter-aware: the tap-a-category/merchant-row
// filter (useBucketEntryFilter, shared with the spend-breakdown carousel
// above) narrows what counts as "total" here exactly the same way it hides
// individual rows, rather than the two disagreeing. Owns the section title
// itself (not a sibling <h2> in page.tsx) so the count can sit on the same
// row, right-aligned.
export function SinglesList({
  title,
  rows,
  buckets,
  currentBucketId,
  debts,
  categories,
}: {
  title: string;
  rows: SinglesRow[];
  buckets: BucketOption[];
  currentBucketId: string;
  debts: DebtOption[];
  categories: CategoryOption[];
}) {
  const { state } = useBucketEntryFilter();
  // Remount (and so reset to page 1) whenever the active filter itself
  // changes -- a person picking a different category/merchant expects page 1
  // of the new result, not whatever page number they happened to be on
  // against the previous filter's totally different set of rows.
  const filterKey = `${state.dim ?? ""}:${state.values.join(" ")}`;

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{title}</h2>
        <p className="text-sm text-gray-500 dark:text-neutral-400">No transactions logged yet.</p>
      </div>
    );
  }

  return (
    <SinglesListPage
      key={filterKey}
      title={title}
      rows={rows}
      state={state}
      buckets={buckets}
      currentBucketId={currentBucketId}
      debts={debts}
      categories={categories}
    />
  );
}

function SinglesListPage({
  title,
  rows,
  state,
  buckets,
  currentBucketId,
  debts,
  categories,
}: {
  title: string;
  rows: SinglesRow[];
  state: FilterState;
  buckets: BucketOption[];
  currentBucketId: string;
  debts: DebtOption[];
  categories: CategoryOption[];
}) {
  const [page, setPage] = useState(1);

  const filtered = useMemo(
    () => rows.filter((r) => matchesEntryFilter(state, categoryNameOf(r.categoryId, categories), r.merchant)),
    [rows, state, categories],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped rather than reset-via-effect -- same pure-render-time
  // reconciliation BucketEntryFilterProvider itself uses (see its own
  // comment). Covers a revalidation shrinking the list out from under an
  // already-open later page (e.g. enough rows got reclassified away).
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-2">
      {/* Count on the same row as the section title, right-aligned. */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{title}</h2>
        <ResultCount count={filtered.length} noun="Transaction" total={rows.length} className="text-right" />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400">No transactions match this filter.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {pageItems.map((r) => (
              <TransactionRow
                key={r.id}
                transaction={r.transaction}
                merchant={r.merchant}
                buckets={buckets}
                currentBucketId={currentBucketId}
                debts={debts}
                categories={categories}
                labelSuggestions={r.labelSuggestions}
                reimbursementSuggestions={r.reimbursementSuggestions}
              />
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="mt-1 flex items-center justify-between text-sm">
              <PagerButton disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} label="Prev" />
              <span className="text-xs text-gray-500 dark:text-neutral-400">
                Page {currentPage} of {totalPages}
              </span>
              <PagerButton disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} label="Next" />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PagerButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  if (disabled) {
    return <span className="rounded-lg px-3 py-1.5 text-neutral-300 dark:text-neutral-700">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-1.5 font-medium text-blue-900 dark:text-blue-300"
    >
      {label}
    </button>
  );
}
