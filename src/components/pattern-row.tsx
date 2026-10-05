"use client";

import { useActionState, useTransition } from "react";
import { Link2, SkipForward, Trash2 } from "lucide-react";
import { formatCents } from "@/lib/money";
import { todayAsUTCDate, dueDateProximity } from "@/lib/date";
import {
  updatePattern,
  deletePattern,
  cancelPattern,
  skipPatternCycle,
  type PatternFormState,
} from "@/app/transactions/actions";
import { PatternFields } from "@/components/pattern-fields";
import type { CategoryOption } from "@/app/bills/category-picker";
import { useEntryFilter } from "@/components/bucket-entry-filter";
import { RowActions, type RowAction } from "@/components/row-actions";
import { InlineSaveButton } from "@/components/inline-save-button";
import { EntryLine } from "@/components/entry-line";
import { CycleLedger } from "@/components/cycle-ledger";
import { useActionToast } from "@/lib/use-action-toast";
import { useKebabEditRow } from "@/lib/use-kebab-edit-row";
import { CADENCE_LABEL } from "@/lib/cadence-label";
import { showToast } from "@/lib/toast";
// PatternData/serializePatternDates live in lib/pattern-data.ts, not here —
// a server page needs to call serializePatternDates(), and every export from
// a "use client" file (this one) is a client reference a Server Component
// can't invoke. Type-only re-export below is safe (erased at build time);
// re-exporting the function itself would reintroduce the same bug.
import type { PatternData } from "@/lib/pattern-data";

export type { PatternData };

const DAY_MS = 86_400_000;

// Under this, an unmatched cycle is assumed to be a real payment just late
// to post/sync; past it, usually means the cycle readjusted and owes
// nothing. NOTE: BillRow's own Skip This Cycle no longer waits on a
// threshold like this at all — a household can skip a bill any time it
// isn't already paid/skipped, not just once it's overdue (household
// request, 2026-09-14: known-in-advance credit balances shouldn't have to
// wait for the day count). That change was deliberately NOT carried over
// to a scheduled P2P pattern's own Skip below — the two have simply
// diverged for now; this isn't a stale copy of a shared constant, so don't
// "fix" one to match the other without a fresh household decision on
// whether pattern Skip should drop its own wait too.
const SKIP_GRACE_DAYS = 7;

const initialState: PatternFormState = {};

// Shared by the unscheduled and scheduled tagline blocks below — same
// category/bucket/debt/income segments either way, differing only in the
// leading text and whether the channelKeyword segment shows (real finding,
// 2026-09-22 code review: the two were near-identical hand-copied JSX, and
// channelKeyword had already silently drifted — present in one, absent in
// the other, with no comment explaining why).
function PatternTagline({
  pattern,
  variant,
  isReimbursement,
  leading,
  showChannel,
}: {
  pattern: PatternData;
  variant: "default" | "bucket";
  isReimbursement: boolean;
  leading: React.ReactNode;
  showChannel: boolean;
}) {
  return (
    <p className="text-sm text-gray-600 dark:text-neutral-400">
      {leading}
      {" · "}
      {pattern.categoryName ? (
        <span className="text-emerald-700 dark:text-emerald-400">{pattern.categoryName}</span>
      ) : (
        <span className="text-amber-700 dark:text-amber-400">Uncategorized</span>
      )}
      {showChannel && (
        <>
          {" · "}
          {pattern.channelKeyword}
        </>
      )}
      {pattern.bucketName && variant !== "bucket" ? ` · ${pattern.bucketName}` : ""}
      {pattern.debtName ? ` · ${pattern.debtName} (debt)` : ""}
      {!isReimbursement && pattern.direction === "CREDIT" && pattern.countsAsIncome ? " · Counts as Income" : ""}
    </p>
  );
}

export function PatternRow({
  pattern,
  buckets,
  debts,
  bills = [],
  categories = [],
  variant = "default",
}: {
  pattern: PatternData;
  buckets: { id: string; name: string }[];
  debts: { id: string; name: string }[];
  bills?: { id: string; name: string }[];
  categories?: CategoryOption[];
  // "bucket": rendered on the bucket page this pattern is itself targeting
  // (buckets/[id]/page.tsx) — its own bucket name in the tagline would just
  // repeat the page you're already on (household feedback, 2026-09-11,
  // matching BillRow's identical `variant="bucket"` convention). Every other
  // caller (income/reimbursement patterns with no fixed bucket, the
  // household-wide /bills list mixing several buckets) keeps it — there it's
  // real information, not an echo.
  variant?: "default" | "bucket";
}) {
  const { editing, setEditing, setActionsOpen, editAction, rowActionsProps } = useKebabEditRow();
  const [state, formAction, pending] = useActionState(updatePattern.bind(null, pattern.id), initialState);
  const { justSaved } = useActionToast(pending, state, { success: "Pattern Saved" });
  const [skipPending, startSkipTransition] = useTransition();
  const isReimbursement = pattern.direction === "CREDIT" && !!pattern.billName;
  const isScheduled = pattern.cadence !== null && pattern.nextDueDate !== null;

  // Inert unless rendered inside the bucket page's BucketEntryFilterProvider.
  // A pattern has no merchant, so a merchant filter always hides it; a
  // category filter matches on pattern.categoryName.
  const { hidden, barClass } = useEntryFilter(pattern.categoryName, null);
  if (hidden) return null;

  // A canceled-but-still-shown scheduled pattern (active:false — see
  // currentPeriodPatternWhere/cancelPattern) is read-only, same as a
  // canceled RecurringBill: it's only still in this list because it was
  // paid this period, and drops off at rollover on its own. An unscheduled
  // pattern has no "cancel, but keep this cycle" concept to offer (no real
  // cycle at all), so it keeps plain Delete unconditionally.
  const actions: RowAction[] = !pattern.active
    ? []
    : isScheduled
      ? [
          editAction,
          {
            key: "cancel",
            icon: Trash2,
            label: "Cancel",
            tone: "danger",
            confirmMessage:
              `Cancel "${pattern.label}"? Its past transactions and bucket history stay exactly as they are — ` +
              `this just stops expecting future payments.${
                pattern.lastPaidDate
                  ? " If it's already been paid this month, it stays in this list until next month, then drops off."
                  : ""
              }`,
            successToast: "Pattern Canceled",
            onClick: () => cancelPattern(pattern.id),
          },
        ]
      : [
          editAction,
          {
            key: "delete",
            icon: Trash2,
            label: "Delete",
            tone: "danger",
            confirmMessage: `Delete "${pattern.label}"?`,
            successToast: "Pattern Deleted",
            onClick: () => deletePattern(pattern.id),
          },
        ];

  // Both server-computed (cyclePaymentStatus, src/lib/cycle-slots.ts) — see
  // PatternData's own comment for why this replaced the old client-side
  // paidOnSchedule/stuckCyclePaid heuristic (real report, 2026-09-12: "Mom
  // Verizon Reimbursement," paid Aug 25 with nextDueDate rolled to Sep 25,
  // kept showing "Paid Aug 25" through the first 24 days of September
  // instead of "due ~Sep 25" — nextDue hasn't arrived yet isn't the same
  // question as "has nextDue actually rolled into a new calendar month
  // yet," and the old heuristic only ever asked the first one). Unlike
  // BillRow (which deliberately keeps a raw due-status pill for non-MONTHLY
  // cadences on purpose), PatternRow has no such pill to preserve — cyclePaid
  // applies the same way regardless of cadence here.
  const currentCyclePayments = pattern.currentCyclePayments;
  const totalCents = currentCyclePayments.reduce((s, p) => s + p.amountCents, 0);
  const nextDue = pattern.nextDueDate ? new Date(pattern.nextDueDate) : null;
  const today = todayAsUTCDate();
  // A canceled pattern only lingers here at all because it's already been
  // paid this period (currentPeriodPatternWhere) — always show it settled,
  // same "cancel right after the final payment" treatment BillRow's own
  // paidThisCycle gives a canceled bill.
  const paidThisCycle = isScheduled && (!pattern.active || pattern.cyclePaid);
  const expectedCents = Math.round((pattern.amountMinCents + pattern.amountMaxCents) / 2);
  // Same paidThisCycle gate BillRow's own showLedger uses (bill-row.tsx).
  const showLedger = paidThisCycle && currentCyclePayments.length > 1;
  // Same Skip control BillRow offers (bill-row.tsx's SKIP_GRACE_DAYS) — a
  // scheduled pattern overdue this long with nothing matched usually means
  // the cycle readjusted and owes nothing (household request, 2026-09-12:
  // an overdue reimbursement had no way to acknowledge that and just sat
  // overdue forever). Same day math as EntryLine's own dueDateProximity so
  // this flips on exactly when the date's proximity styling reads overdue.
  const daysOverdue = nextDue ? Math.round((today.getTime() - nextDue.getTime()) / DAY_MS) : 0;
  const showSkip = pattern.active && isScheduled && !paidThisCycle && daysOverdue >= SKIP_GRACE_DAYS;

  return (
    <li
      // No text-sm here (2026-09-11 fix, real report: one scheduled pattern's
      // ledger rendered visibly smaller than another's) —
      // BillRow's own root <li> sets no size class either, so EntryLine/
      // CycleLedger (neither of which sets its own size) inherit the
      // ambient default in both; text-sm here was quietly shrinking every
      // line in a scheduled pattern's card relative to a bill's. rounded-xl/
      // p-4 also now match BillRow's card shell exactly, not just the text.
      className={`rounded-xl border p-4 ${
        isReimbursement
          ? "border-emerald-200 bg-emerald-50/30 dark:border-emerald-900 dark:bg-emerald-950/10"
          : "border-neutral-200 dark:border-neutral-800"
      } ${barClass}`}
    >
      <div>
        <p className="flex flex-wrap items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
          {isReimbursement && <Link2 size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />}
          {pattern.label}
          {!pattern.active && (
            <span className="inline-block whitespace-nowrap rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              Cancelled
            </span>
          )}
        </p>
        {/* The P2P identity line — "Venmo - Robin Miller," the same app +
            counterparty a household would recognize from the transaction
            itself — makes it obvious at a glance this card tracks a P2P
            transfer, not a plain merchant bill (household feedback,
            2026-09-11). Only once a receipt has actually resolved a
            counterparty; channelKeyword alone ("Venmo") with no name isn't
            worth its own line — the tagline below already names the app for
            that case. Replaces showing counterpartyName in the tagline
            itself, which read as a redundant near-duplicate right next to
            this. */}
        {pattern.counterpartyName && (
          <p className="text-sm text-gray-500 dark:text-neutral-400">
            {pattern.channelKeyword.charAt(0).toUpperCase() + pattern.channelKeyword.slice(1)} -{" "}
            {pattern.counterpartyName}
          </p>
        )}
        {/* Unscheduled stays the original single-block flat rule card — tagline
            and kebab right under the title, no divider, nothing to render like
            a bill. A scheduled pattern's tagline moves below, into the same
            bordered block as its EntryLine/CycleLedger/kebab (see below). */}
        {!isScheduled && (
          <>
            <PatternTagline
              pattern={pattern}
              variant={variant}
              isReimbursement={isReimbursement}
              showChannel
              leading={
                isReimbursement
                  ? `Reimburses ${pattern.billName}`
                  : `${pattern.direction === "DEBIT" ? "Money Out" : "Money In"} · ${formatCents(pattern.amountMinCents)}–${formatCents(pattern.amountMaxCents)}`
              }
            />
            <RowActions actions={actions} dense {...rowActionsProps} />
          </>
        )}
      </div>

      {/* Same "title, divider, tagline + EntryLine + ledger + kebab" shell
          BillRow's own bucket variant uses (household feedback, 2026-09-11:
          "make the tag line more uniform to other recurring entries" +
          matching text-xs ledger sizing + kebab always at the true bottom,
          below the ledger, not stranded above it once a cycle has more than
          one payment). */}
      {isScheduled && (
        <div className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
          <PatternTagline
            pattern={pattern}
            variant={variant}
            isReimbursement={isReimbursement}
            showChannel={false}
            leading={
              isReimbursement ? `Reimburses ${pattern.billName}` : `${formatCents(expectedCents)} · ${CADENCE_LABEL[pattern.cadence!]}`
            }
          />
          <ul className="flex flex-col gap-1.5 text-xs">
            {paidThisCycle ? (
              <EntryLine
                state="paid"
                date={new Date(pattern.lastPaidDate!)}
                amountCents={currentCyclePayments.length > 0 ? totalCents : expectedCents}
                receipt={
                  (currentCyclePayments.find((p) => p.occurredOn === pattern.lastPaidDate) ?? currentCyclePayments[0])
                    ?.receipt
                }
              />
            ) : (
              <EntryLine
                state="due"
                date={nextDue!}
                amountCents={expectedCents}
                approximate={!pattern.dueDateLocked}
                dateClassName={dueDateProximity(nextDue!).textClassName}
                dateTitle={dueDateProximity(nextDue!).label}
              />
            )}
          </ul>
          {showLedger && (
            <CycleLedger payments={currentCyclePayments} primaryOccurredOn={pattern.lastPaidDate} totalCents={totalCents} />
          )}
          <RowActions actions={actions} dense {...rowActionsProps}>
            {showSkip && (
              <button
                type="button"
                onClick={() => {
                  if (
                    !confirm(
                      "Skip this cycle? No payment gets recorded — the due date just moves to the next cycle, for a cycle that readjusted and owes nothing right now.",
                    )
                  )
                    return;
                  startSkipTransition(async () => {
                    try {
                      await skipPatternCycle(pattern.id);
                      showToast("Cycle Skipped");
                    } catch {
                      showToast("Couldn’t Skip Cycle", "error");
                    }
                  });
                }}
                disabled={skipPending}
                title="Skip This Cycle — Nothing Owed (e.g. a Readjusted Reimbursement)"
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-50"
              >
                <SkipForward size={12} />
                {skipPending ? "Skipping…" : "Skip"}
              </button>
            )}
          </RowActions>
        </div>
      )}

      {editing && (
        <form
          action={(formData) => {
            formAction(formData);
            setEditing(false);
            setActionsOpen(false);
          }}
          className="mt-3 flex flex-col gap-3 border-t border-neutral-100 dark:border-neutral-800 pt-3"
        >
          <PatternFields
            buckets={buckets}
            debts={debts}
            bills={bills}
            categories={categories}
            lockedChannelKeyword={pattern.channelKeyword}
            lockedDirection={pattern.direction}
            defaults={{
              label: pattern.label,
              channelKeyword: pattern.channelKeyword,
              amountMin: (pattern.amountMinCents / 100).toString(),
              amountMax: (pattern.amountMaxCents / 100).toString(),
              // The scheduled-form's single Amount field — the same
              // midpoint expectedCents uses elsewhere in this component, so
              // reopening the edit form on a scheduled pattern shows the
              // number the household actually typed, not a derived range.
              amount: (Math.round((pattern.amountMinCents + pattern.amountMaxCents) / 2) / 100).toString(),
              dayOfMonthStart: pattern.dayOfMonthStart?.toString() ?? "",
              dayOfMonthEnd: pattern.dayOfMonthEnd?.toString() ?? "",
              weekdays: pattern.weekdays,
              target: pattern.bucketId ? `bucket:${pattern.bucketId}` : pattern.debtId ? `debt:${pattern.debtId}` : "",
              countsAsIncome: pattern.countsAsIncome,
              billId: pattern.billId ?? "",
              categoryId: pattern.categoryId ?? "",
              counterpartyName: pattern.counterpartyName ?? undefined,
              noteKeywords: pattern.noteKeywords,
              cadence: pattern.cadence ?? undefined,
              nextDueDate: pattern.nextDueDate ?? undefined,
              tolerance: pattern.toleranceCents !== null ? (pattern.toleranceCents / 100).toString() : undefined,
            }}
          />
          {state.error && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
          <InlineSaveButton pending={pending} justSaved={justSaved} />
        </form>
      )}
    </li>
  );
}
