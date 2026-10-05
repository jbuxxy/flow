"use client";

import { useState } from "react";
import { BillRow, type BillData } from "@/app/bills/bill-row";
import { DebtPaymentCard, type DebtPaymentWithName } from "@/app/debts/debt-payment-card";
import { PatternRow } from "@/components/pattern-row";
import { SelectField } from "@/components/select-field";
import type { CategoryOption } from "@/app/bills/category-picker";
import type { AccountedForCandidate } from "@/lib/debt-payments";
import type { PatternData } from "@/lib/pattern-data";
import { dueDayOf, patternDueDay, sortRecurring, type RecurringSortOrder, type RecurringSortable } from "@/lib/recurring-sort";

// One shared shape for sorting bills, debt payments, and P2P patterns
// together — each arrived in its own order from the query and just got
// concatenated (patterns as a separate block under the rest, until
// 2026-09-30), so the combined list wasn't actually in due-date order
// across types. This makes both sort options (due date, A-Z) apply to the
// whole merged list at once instead (see src/lib/recurring-sort.ts).
type SortableItem = RecurringSortable &
  (
    | { kind: "bill"; bill: BillData }
    | { kind: "debt"; debtPayment: DebtPaymentWithName }
    | { kind: "pattern"; pattern: PatternData }
  );

// A bucket's own home for the bill-tracking machinery — the sort control and
// tracked bills themselves. (A projected "Recurring Total" card briefly
// lived above this list as a carousel slide, 2026-08-24 to 2026-08-27, then
// was removed — a projection sitting next to the real-spend breakdown
// tables read as confusing, and the per-bill cards here already itemise the
// same thing.) Rendered once per Bucket page (see
// buckets/[id]/page.tsx), scoped to that bucket's own bills/debt payments —
// the household-wide view across every bucket lives separately at /bills
// (src/app/bills/page.tsx, 2026-08-23), which reuses BillRow/DebtPaymentCard/
// PatternRow the same way this component does rather than its own markup.
// New-bill suggestions themselves render once on the /buckets index instead
// (2026-08-16 — a suggestion filtered down to "belongs to this bucket" was
// otherwise invisible from anywhere that actually lists it, since the index
// page has no per-bucket view of pending suggestions). No manual "add a bill"/"add a
// transaction" form here (removed 2026-08-15, along with manual debt
// creation moving to /settings/simplefin) — this household doesn't track
// cash transactions at all, so every bill/transaction here comes from a
// synced account; "Track as a bill" from /transactions (createBillFromTransaction)
// is the only way a bill gets created now.
//
// Debt payments (2026-08-14): a household wanted "everything recurring, due
// this month" visible in one place rather than split across Buckets and
// Debts — so a DebtPayment can optionally be assigned to a bucket here too
// (see DebtPayment.bucketId), rendered inline in the same list as this
// bucket's bills using the same DebtPaymentRow already built for /debts,
// tagged "Debt" (2026-08-15 — previously its own separate "Debt payments"
// section, folded into one unified list on request) so it reads as one
// list of "everything recurring" rather than two. This is purely a second
// display surface, not a data model merge: /debts remains the
// payoff-focused source of truth (balance, APR, attack order), and
// assigning a bucket here never touches budget totals — see the comment on
// the debtPayments prop below.
//
// No separate "expected this month" list — each BillRow below already shows
// its own due/paid status via a badge (see dueStatus in bill-row.tsx) and
// never disappears when paid (nextDueDate just rolls forward), so a
// duplicate summary of the same per-bill dates added nothing. Unlike
// Income's biweekly paychecks, every bill here is MONTHLY (one occurrence a
// month), so one card per bill was never missing an occurrence the way a
// single Income card would for a cadence with 2-3 paychecks a month.
export function BucketBillsSection({
  bills,
  debtPayments,
  patterns = [],
  categories,
  allBuckets,
  debts,
  accountedForSuggestions = {},
}: {
  bills: BillData[];
  // Debt payments assigned to this bucket (see the schema comment on
  // DebtPayment.bucketId) — rendered inline alongside bills below, and
  // counted into the bucket's progress bar the same way a real bill is
  // (getBucketsWithProgress, src/lib/buckets.ts; 2026-08-15, reversed from
  // originally excluding them: a household's monthly cap on a "Bills"-type
  // bucket is meant to cover everything recurring, debt or not — confirmed
  // directly after a debt payment noticeably dropped out of the progress
  // bar once it stopped being informally tracked as a plain bill).
  debtPayments: DebtPaymentWithName[];
  // P2P patterns targeting this bucket (Venmo/Zelle rules) — sorted into
  // the same list rather than trailing it.
  patterns?: PatternData[];
  categories: CategoryOption[];
  allBuckets: { id: string; name: string }[];
  // Needed by BillRow's inline reimbursement-pattern list (PatternRow's
  // generic edit form always offers a Bucket/Debt payment target, even
  // though a reimbursement pattern's own direction is CREDIT).
  debts: { id: string; name: string }[];
  // Suggested purchases for each visible payment's "already accounted for"
  // linker, keyed by payment transaction id — see
  // getAccountedForSuggestions, src/lib/debt-payments.ts.
  accountedForSuggestions?: Record<string, AccountedForCandidate[]>;
}) {
  const [sortOrder, setSortOrder] = useState<RecurringSortOrder>("dueDate");

  // A cancelled-but-still-listed bill or pattern (paid this month, drops off
  // at rollover — see currentPeriodBillWhere/currentPeriodPatternWhere)
  // sinks to the bottom regardless of sort order. A paid-off debt sinks only
  // when it has no payment this cycle (household rule, 2026-10-02, refining
  // 2026-09-29): one paid off *this* month (Sam's Club, paid Oct 1) belongs in
  // this month's sorted order and keeps its place with DebtPaymentCard's green
  // styling, but one paid off in an earlier month with nothing this cycle
  // (Citi Double Cash, Quicksilver) is just a dormant card and drops to the
  // bottom. /debts and /bills (recurring-list.tsx) sink every paid-off debt.
  const sortedItems = sortRecurring<SortableItem>(
    [
      ...bills.map(
        (b): SortableItem => ({ kind: "bill", sortName: b.name, dueDay: dueDayOf(b.nextDueDate), sinks: b.canceled, bill: b }),
      ),
      ...debtPayments.map((dp): SortableItem => {
        const dormantPaidOff =
          dp.paidOff && !dp.slots.some((s) => s.payment) && dp.extraPayments.length === 0;
        return {
          kind: "debt",
          sortName: dp.debtName,
          // A dormant paid-off debt sinks, and its tracker's nextDueDate is
          // stale (Quicksilver, paid off Sep 4, sat among the 27th's rows —
          // 2026-09-29), so it orders by its payoff date down there. One with
          // a payment this cycle stays in the list and sorts by its real due
          // date like any other row — not the day it was paid (Sam's Club,
          // due Oct 4, paid Oct 1, sat at the 1st — 2026-10-03).
          dueDay: dueDayOf(dormantPaidOff && dp.paidOffDate ? dp.paidOffDate : dp.nextDueDate),
          sinks: dormantPaidOff,
          debtPayment: dp,
        };
      }),
      ...patterns.map(
        (p): SortableItem => ({ kind: "pattern", sortName: p.label, dueDay: patternDueDay(p), sinks: !p.active, pattern: p }),
      ),
    ],
    sortOrder,
  );

  return (
    <div className="flex flex-col gap-4">
      {sortedItems.length > 0 && (
        <>
          {/* "Recurring" heading + the Sort By control share one line
              (2026-09-03 household request) — the section header lives here,
              not in the parent page, so it can sit beside the control that
              only this component knows whether to show. */}
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Recurring</h2>
            {sortedItems.length > 1 && (
              // No "Sort By" label — the dropdown's own options (Due Date /
              // A–Z) already say what it does (household feedback, 2026-09-14,
              // matching RecurringSortControl's identical trim).
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-neutral-400">
                <SelectField
                  value={sortOrder}
                  onChange={(v) => setSortOrder(v as RecurringSortOrder)}
                  searchable={false}
                  options={[
                    { value: "dueDate", label: "Due Date" },
                    { value: "alphabetical", label: "A–Z" },
                  ]}
                  small
                  className="w-32"
                />
              </div>
            )}
          </div>
          <ul className="flex flex-col gap-3">
            {sortedItems.map((item) =>
              item.kind === "pattern" ? (
                <PatternRow
                  key={`pattern-${item.pattern.id}`}
                  pattern={item.pattern}
                  buckets={allBuckets}
                  debts={debts}
                  categories={categories}
                  variant="bucket"
                />
              ) : item.kind === "bill" ? (
                <BillRow
                  key={`bill-${item.bill.id}`}
                  bill={item.bill}
                  buckets={allBuckets}
                  debts={debts}
                  categories={categories}
                  variant="bucket"
                />
              ) : (
                <DebtPaymentCard
                  key={`debt-${item.debtPayment.id}`}
                  debtPayment={item.debtPayment}
                  accountedForSuggestions={accountedForSuggestions}
                  variant="bucket"
                />
              ),
            )}
          </ul>
        </>
      )}
    </div>
  );
}
