"use client";

import Link from "next/link";
import { BillRow, type BillData } from "./bill-row";
import { DebtPaymentCard, type DebtPaymentWithName } from "@/app/debts/debt-payment-card";
import { PatternRow, type PatternData } from "@/components/pattern-row";
import { BucketIcon } from "@/components/bucket-icon";
import { useRecurringSort, type SortOrder } from "./recurring-sort";
import { ResultCount } from "@/components/result-count";
import type { CategoryOption } from "./category-picker";
import type { AccountedForCandidate } from "@/lib/debt-payments";
import { dueDayOf, patternDueDay, sortRecurring, type RecurringSortable } from "@/lib/recurring-sort";

export type BillGroup = {
  bucketId: string;
  name: string;
  icon: string | null;
  bills: BillData[];
  debtPayments: DebtPaymentWithName[];
  patterns: PatternData[];
};

// Client half of the household-wide Recurring list (src/app/bills/page.tsx).
// The server groups bills, debt payments, and P2P patterns by bucket alike
// (household feedback, 2026-09-14 — debts/patterns used to each get one
// single household-wide card, sorted by type instead of matching bills'
// per-bucket grouping, which didn't read as "this is Buckets->Recurring").
// This component applies the interactive "Sort By" order that reorders the
// rows *within* each section between due date (default) and A–Z. The
// control itself lives on the page title line (RecurringSortControl,
// recurring-sort.tsx); the shared sortOrder comes in through
// useRecurringSort. Section order itself stays alphabetical and is fixed on
// the server; only the items inside a section move. Same sort as
// BucketBillsSection's own control (src/lib/recurring-sort.ts), except here
// paid-off debts sink with cancelled bills/patterns so a $0 debt never
// crowds out what's actually due.
// Bills, debt payments, and P2P patterns share one sorted list per section
// (same merge BucketBillsSection does for a single bucket) so a due-date/A-Z
// sort applies across every type together — patterns used to trail as their
// own block, so one due the 1st sat under a bill due the 28th (household
// report, 2026-09-30). Sort key lives in src/lib/recurring-sort.ts.
type RecurringItem = RecurringSortable &
  (
    | { kind: "bill"; bill: BillData }
    | { kind: "debt"; debtPayment: DebtPaymentWithName }
    | { kind: "pattern"; pattern: PatternData }
  );

function sortSection(
  bills: BillData[],
  debtPayments: DebtPaymentWithName[],
  patterns: PatternData[],
  order: SortOrder,
): RecurringItem[] {
  return sortRecurring<RecurringItem>(
    [
      ...bills.map((b): RecurringItem => ({ kind: "bill", sortName: b.name, dueDay: dueDayOf(b.nextDueDate), sinks: b.canceled, bill: b })),
      ...debtPayments.map(
        (dp): RecurringItem => ({
          kind: "debt",
          sortName: dp.debtName,
          dueDay: dueDayOf(dp.nextDueDate),
          sinks: dp.paidOff,
          debtPayment: dp,
        }),
      ),
      ...patterns.map(
        (p): RecurringItem => ({ kind: "pattern", sortName: p.label, dueDay: patternDueDay(p), sinks: !p.active, pattern: p }),
      ),
    ],
    order,
  );
}

type SharedRowProps = {
  buckets: { id: string; name: string }[];
  debts: { id: string; name: string }[];
  categories: CategoryOption[];
  billOptions: { id: string; name: string }[];
  accountedForSuggestions: Record<string, AccountedForCandidate[]>;
};

// One section's worth of rows — bills, debt payments, and P2P patterns
// merged and sorted together.
function RecurringSectionRows({
  bills,
  debtPayments,
  patterns,
  sortOrder,
  buckets,
  debts,
  categories,
  billOptions,
  accountedForSuggestions,
}: {
  bills: BillData[];
  debtPayments: DebtPaymentWithName[];
  patterns: PatternData[];
  sortOrder: SortOrder;
} & SharedRowProps) {
  const items = sortSection(bills, debtPayments, patterns, sortOrder);
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) =>
        item.kind === "pattern" ? (
          <PatternRow
            key={`pattern-${item.pattern.id}`}
            pattern={item.pattern}
            buckets={buckets}
            debts={debts}
            bills={billOptions}
            categories={categories}
          />
        ) : item.kind === "bill" ? (
          <BillRow key={`bill-${item.bill.id}`} bill={item.bill} buckets={buckets} debts={debts} categories={categories} />
        ) : (
          <DebtPaymentCard
            key={`debt-${item.debtPayment.id}`}
            debtPayment={item.debtPayment}
            accountedForSuggestions={accountedForSuggestions}
          />
        ),
      )}
    </ul>
  );
}

export function RecurringList({
  billGroups,
  unbucketedBills,
  unbucketedDebtPayments,
  unbucketedPatterns,
  buckets,
  debts,
  categories,
  billOptions,
  accountedForSuggestions,
}: {
  billGroups: BillGroup[];
  unbucketedBills: BillData[];
  unbucketedDebtPayments: DebtPaymentWithName[];
  unbucketedPatterns: PatternData[];
  buckets: { id: string; name: string }[];
  debts: { id: string; name: string }[];
  categories: CategoryOption[];
  billOptions: { id: string; name: string }[];
  accountedForSuggestions: Record<string, AccountedForCandidate[]>;
}) {
  const { sortOrder } = useRecurringSort();

  const hasUnbucketed =
    unbucketedBills.length > 0 || unbucketedDebtPayments.length > 0 || unbucketedPatterns.length > 0;

  const totalItems =
    billGroups.reduce((n, g) => n + g.bills.length + g.debtPayments.length + g.patterns.length, 0) +
    unbucketedBills.length +
    unbucketedDebtPayments.length +
    unbucketedPatterns.length;

  const rowProps: SharedRowProps = { buckets, debts, categories, billOptions, accountedForSuggestions };

  // One card per group (per-bucket section, the unbucketed pile at the end)
  // — built once and reused by both layouts below, keyed so React shares no
  // state between the two mounted copies.
  const groupCards = [
    ...billGroups.map((group) => ({
      key: group.bucketId,
      node: (
        <section className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <Link href={`/buckets/${group.bucketId}`} className="shrink-0">
              <BucketIcon
                bucket={{ name: group.name, icon: group.icon }}
                size={16}
                wrapperClassName="h-7 w-7 bg-emerald-50 text-emerald-700 dark:bg-neutral-800 dark:text-emerald-400"
              />
            </Link>
            <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{group.name}</h2>
          </div>
          <RecurringSectionRows
            bills={group.bills}
            debtPayments={group.debtPayments}
            patterns={group.patterns}
            sortOrder={sortOrder}
            {...rowProps}
          />
        </section>
      ),
    })),
    ...(hasUnbucketed
      ? [
          {
            key: "unbucketed",
            node: (
              <section className="mb-4">
                <h3 className="mb-2 text-xs font-medium text-gray-500 dark:text-neutral-400">No Bucket</h3>
                <RecurringSectionRows
                  bills={unbucketedBills}
                  debtPayments={unbucketedDebtPayments}
                  patterns={unbucketedPatterns}
                  sortOrder={sortOrder}
                  {...rowProps}
                />
              </section>
            ),
          },
        ]
      : []),
  ];

  // Mobile keeps the plain stack it's always had. Desktop swaps a CSS
  // multi-column masonry for `flex flex-wrap` — a `break-inside-avoid`
  // column masonry treats each bucket's whole card as one unsplittable
  // block, and with only a handful of very unevenly sized buckets (one
  // packed "Bills" tower next to two short ones), the browser's column-fill
  // algorithm can't balance them: it fills column 1 in DOM order and leaves
  // later columns empty, no matter how the column count/width is computed
  // (household report, 2026-09-23 — confirmed by rendering the real page
  // headlessly). `flex-wrap` sidesteps that the same way SwipeCarousel's
  // own `desktopGrid` already does for the identical class of bug
  // (2026-09-22/23) — items wrap into however many fit each row and the
  // last (possibly partial) row's items grow to fill it, no fixed column
  // count and nothing ever strands empty width. Two sibling containers over
  // the same cards, switched by CSS only (`lg:hidden` / `hidden lg:flex`) —
  // same trade-off SwipeCarousel accepts: the desktop branch mounts too,
  // just hidden below `lg`.
  return (
    <div className="flex flex-col gap-4">
      {totalItems > 0 && <ResultCount count={totalItems} noun="Recurring Item" />}

      <div className="lg:hidden">{groupCards.map((c) => <div key={c.key}>{c.node}</div>)}</div>

      <div className="hidden lg:flex lg:flex-wrap lg:items-start lg:justify-center lg:gap-4">
        {groupCards.map((c) => (
          // Capped like SwipeCarousel's own `capCardWidth` (2026-09-23) — an
          // odd number of groups leaves one alone on its trailing row, and
          // uncapped `grow` would stretch it to the full row width, landing
          // right back on the wide "name … amount" gap this fix exists to
          // avoid. A capped group just leaves blank gutter beside itself on
          // that one row instead — far smaller than a whole stranded column.
          <div key={c.key} className="lg:grow lg:shrink lg:basis-[350px] lg:max-w-[420px]">
            {c.node}
          </div>
        ))}
      </div>
    </div>
  );
}
