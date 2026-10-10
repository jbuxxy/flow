"use client";

import { useActionState, useState, useTransition } from "react";
import { CheckCircle2, ChevronDown, CircleSlash, SkipForward, Trash2, Undo2 } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate, dayOfMonthUTC, dueDateProximity } from "@/lib/date";
import { useKebabEditRow } from "@/lib/use-kebab-edit-row";
import { DayOfMonthPicker } from "@/components/day-of-month-picker";
import { EntryLine } from "@/components/entry-line";
import { CycleLedger } from "@/components/cycle-ledger";
import { deleteBill, skipBillCycle, unskipBillCycle, updateBill, type BillFormState } from "./actions";
import { type CategoryOption } from "./category-picker";
import { MerchantLogo } from "@/components/merchant-logo";
import { SelectField } from "@/components/select-field";
import { BucketCategoryFields } from "@/components/bucket-category-fields";
import { RowActions, type RowAction } from "@/components/row-actions";
import { InlineSaveButton } from "@/components/inline-save-button";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";
import { MoneyInput } from "@/components/money-input";
import { CADENCE_LABEL, CADENCE_OPTIONS, addCadenceISO } from "@/lib/cadence-label";
import { PatternRow, type PatternData } from "@/components/pattern-row";
import { BillReimbursementLinker } from "@/components/bill-reimbursement-linker";
import { useEntryFilter } from "@/components/bucket-entry-filter";
import { useReceiptToggle } from "@/components/receipt-toggle";
import type { PaymentReceipt } from "@/lib/payment-receipt";

export type BillData = {
  id: string;
  name: string;
  merchant: string | null;
  amountCents: number;
  toleranceCents: number | null;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL";
  categoryId: string | null;
  categoryName: string | null;
  nextDueDate: string; // ISO date
  // Computed server-side from nextDueDate (dueStatus below) and passed
  // through rather than recomputed in this "use client" row — dueStatus
  // depends on "today," and recomputing that client-side during hydration
  // can land on a different calendar day than the server did (household
  // runs on TZ=America/Denver server-side; a viewer's browser can be on any
  // TZ), producing a hydration text mismatch right around the UTC date
  // rollover. Computing it once, server-side, is also just more correct:
  // "today" here means the household's day, not whichever device is
  // looking at the screen.
  dueStatus: { label: string; className: string };
  lastPaidDate: string | null; // ISO date
  // False until a human has confirmed the due date (manual entry, or
  // saving the edit form below) — shows a "~" approximate marker until then.
  dueDateLocked: boolean;
  bucketId: string | null;
  // ISO date, newest first. reimbursedBy lists every linked credit's
  // reimbursesTransaction (see Transaction.reimbursesTransactionId) that
  // pays this specific payment back — a P2P reimbursement pattern pinned to
  // this bill (RecurringPattern.billId) auto-links there, or a household
  // links one by hand here via BillReimbursementLinker (or from wherever
  // the credit itself sits, on /transactions). More than one entry means a
  // bill split between people (e.g. two roommates each Venmo-ing back half).
  // Full history — every payment this bill has ever matched, not scoped to
  // any one cycle (used for the "most recent reimbursement ever" projection
  // fallback below). For "did *this* cycle get paid," see cyclePaid/
  // currentCyclePayments instead.
  payments: {
    id: string;
    amountCents: number;
    occurredOn: string;
    pending: boolean;
    // Its matched email receipt, if any (paymentReceiptOf) — the paid
    // line/ledger glyph that opens the "From Receipt" block.
    receipt: PaymentReceipt | null;
    reimbursedBy: { id: string; merchant: string; amountCents: number; occurredOn: string }[];
  }[];
  // Both server-computed via cyclePaymentStatus (src/lib/cycle-slots.ts) —
  // the same calendar-month-bounded buildCycleSlots primitive
  // DebtPaymentRow/DebtRow already use, so this can't drift from theirs the
  // way a client-recomputed heuristic already has, twice (see that
  // function's own comment). cyclePaid answers "did every occurrence
  // expected this calendar month get a real payment," full stop — no
  // separate reasoning about whether nextDueDate has rolled over yet.
  // currentCyclePayments is `payments` filtered to just this month's, same
  // shape, ready for the ledger/reimbursement pill as-is.
  cyclePaid: boolean;
  currentCyclePayments: {
    id: string;
    amountCents: number;
    occurredOn: string;
    pending: boolean;
    // Its matched email receipt, if any (paymentReceiptOf) — the paid
    // line/ledger glyph that opens the "From Receipt" block.
    receipt: PaymentReceipt | null;
    reimbursedBy: { id: string; merchant: string; amountCents: number; occurredOn: string }[];
  }[];
  // Server-computed via getActiveBillCycleSkips (src/lib/recurring-bills.ts)
  // — non-null exactly while the household's most recent Skip This Cycle
  // (skipBillCycle, ./actions.ts) is still the one describing the *current*
  // cycle transition, not a stale skip from a cycle that's since rolled
  // past again. The due date that got skipped (not nextDueDate, which has
  // already advanced past it) — shown as "Skipped {date}" with an Undo in
  // place of the normal due/paid treatment (household request, 2026-09-14).
  skippedCycleDueDate: string | null; // ISO date
  // CREDIT patterns pinned to this bill (RecurringPattern.billId,
  // countsAsIncome:false) — every matching P2P credit auto-nets against
  // this bill's payments (matchReimbursements, src/lib/reimbursements.ts)
  // without needing to be linked by hand. Shown/editable inline below,
  // reusing PatternRow.
  reimbursementPatterns: PatternData[];
  // active:false — cancelled, but still listed this month because it was
  // already paid (see currentPeriodBillWhere / deleteBill). Renders settled
  // with a "Cancelled" tag and no edit/skip/cancel controls; drops out of
  // every list at month rollover.
  canceled: boolean;
};

const initialState: BillFormState = {};

export function BillRow({
  bill,
  buckets,
  debts = [],
  categories,
  // "bucket" renders the due/paid line through the shared EntryLine (bullet
  // + "Sep 3" + right-aligned amount, under a divider) so a bill reads the
  // same as a debt payment in a bucket's Recurring list (2026-09-01
  // household request). The standalone /bills page keeps the pill.
  variant = "default",
}: {
  bill: BillData;
  buckets: { id: string; name: string }[];
  debts?: { id: string; name: string }[];
  categories: CategoryOption[];
  variant?: "default" | "bucket";
}) {
  const bucket = variant === "bucket";
  const { editing, setEditing, setActionsOpen, editAction, rowActionsProps } = useKebabEditRow();
  // The reimbursement detail (the linked-credit line + the pinned pattern
  // row) is collapsed by default — the "reimbursed" / "+ Expected" pill is
  // the toggle (2026-09-01 household request).
  const [reimbursementOpen, setReimbursementOpen] = useState(false);
  const [cadence, setCadence] = useState(bill.cadence);
  const [dueDate, setDueDate] = useState(bill.nextDueDate.slice(0, 10));
  // Switching cadence re-projects the non-monthly due date one new period
  // past the last payment — otherwise Monthly -> Yearly on a just-paid bill
  // kept the one-month-out date and the "yearly" bill came due next month
  // (household report 2026-09-30). Back to the saved cadence restores the
  // saved date; a never-paid bill has no anchor, so its date is left alone.
  function changeCadence(v: BillData["cadence"]) {
    setCadence(v);
    if (v === bill.cadence) setDueDate(bill.nextDueDate.slice(0, 10));
    else if (bill.lastPaidDate) setDueDate(addCadenceISO(bill.lastPaidDate, v));
  }
  const [dueDay, setDueDay] = useState(String(dayOfMonthUTC(bill.nextDueDate)));
  const [bucketId, setBucketId] = useState(bill.bucketId ?? "");
  const [deletePending, startDeleteTransition] = useTransition();
  const [skipPending, startSkipTransition] = useTransition();
  const [unskipPending, startUnskipTransition] = useTransition();
  const updateBillWithId = updateBill.bind(null, bill.id);
  const [state, formAction, pending] = useActionState(updateBillWithId, initialState);
  const { justSaved } = useActionToast(pending, state, { success: "Bill Saved" });
  const status = bill.dueStatus;

  // Inert unless this row is rendered inside the bucket page's
  // BucketEntryFilterProvider (no provider on /bills) — then it hides when a
  // category/merchant filter is active and unmatched, and tints its left edge.
  const { hidden, barClass } = useEntryFilter(bill.categoryName, bill.name);
  // The single paid line's own receipt (the ledger, once it shows, carries
  // one per payment instead) — the cycle's primary payment, else its only one.
  const paidReceipt =
    (bill.currentCyclePayments.find((p) => p.occurredOn === bill.lastPaidDate) ?? bill.currentCyclePayments[0])?.receipt ??
    null;
  const { trigger: paidReceiptTrigger, panel: paidReceiptPanel } = useReceiptToggle(paidReceipt);

  // Both server-computed (cyclePaymentStatus, src/lib/cycle-slots.ts) — see
  // BillData's own comment for why this replaced the old client-side
  // paidOnSchedule/stuckCyclePaid heuristic (real incidents 2026-08-14 and
  // 2026-08-30, both the same underlying class of bug: nextDueDate/
  // lastPaidDate alone can't reliably answer "is this cycle paid" without
  // also asking whether nextDueDate has actually rolled into a new
  // calendar month yet).
  const currentCyclePayments = bill.currentCyclePayments;
  const totalCents = currentCyclePayments.reduce((s, p) => s + p.amountCents, 0);
  const reimbursedCents = currentCyclePayments.reduce(
    (s, p) => s + p.reimbursedBy.reduce((rs, r) => rs + Math.abs(r.amountCents), 0),
    0,
  );

  // The household's setup is almost entirely MONTHLY bills, where "paid or
  // not, this month" is the only question that matters — WEEKLY/ANNUAL
  // cadences are the deliberate exception (a weekly charge naturally spans
  // several payments a month, an annual one needs a different rhythm
  // entirely), so they keep the fuller due-status + ledger treatment below
  // unconditionally, never collapsing to a plain "Paid" checkmark.
  const isMonthly = bill.cadence === "MONTHLY";
  // A cancelled bill only lingers here at all while it's already been paid
  // this month (currentPeriodBillWhere) — always show it settled.
  const paidThisCycle = (isMonthly && bill.cyclePaid) || bill.canceled;
  // Server-computed (getActiveBillCycleSkips) — see BillData's own comment.
  const isSkipped = bill.skippedCycleDueDate !== null;
  // Offered any time the cycle isn't already settled one way or the other —
  // no more days-overdue wait (see skipBillCycle's own comment: household
  // request, 2026-09-14 — a credit balance is known well before a bill is
  // even due).
  const canSkip = !bill.canceled && !paidThisCycle && !isSkipped;

  function undoSkip() {
    startUnskipTransition(async () => {
      try {
        await unskipBillCycle(bill.id);
        showToast("Skip Undone");
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  // A cancelled bill is read-only here — it's only still listed because it
  // was paid this month, and drops off at rollover. Computed once and reused
  // by whichever variant's bottom line ends up rendering the kebab (see
  // `bucket` below) rather than duplicated per-variant.
  const billActions: RowAction[] = bill.canceled
    ? []
    : [
        editAction,
        ...(canSkip
          ? [
              {
                key: "skip",
                icon: SkipForward,
                label: "Skip This Cycle",
                disabled: skipPending,
                confirmMessage: `Skip this cycle for "${bill.name}"? No payment gets recorded — the due date just moves to the next cycle, for a bill that readjusted and owes nothing right now. You can undo this from the row afterward if something turns out to still be owed.`,
                successToast: "Cycle Skipped",
                onClick: () => startSkipTransition(() => skipBillCycle(bill.id)),
              } satisfies RowAction,
            ]
          : []),
        {
          key: "cancel",
          icon: Trash2,
          label: "Cancel Bill",
          tone: "danger",
          disabled: deletePending,
          confirmMessage: `Cancel "${bill.name}"? Its past transactions and bucket history stay exactly as they are — this just stops expecting future payments.${
            paidThisCycle ? " It stays in this month's list since it's already been paid, then drops off next month." : ""
          }${bill.merchant ? ` If new charges from ${bill.merchant} show up later, Flow will offer to track it as a bill again.` : ""}`,
          successToast: "Bill Canceled",
          onClick: () => startDeleteTransition(() => deleteBill(bill.id)),
        },
      ];

  // A monthly bill that isn't paid this cycle still has bill.payments[0]
  // pointing at *last* cycle's payment, so its linked reimbursement — and
  // the "− $X reimbursed" pill / linker built from currentCyclePayments — is
  // stale history, not this cycle's. Suppress it and show the expected-
  // reimbursement projection instead until this cycle's own credit lands
  // (household request 2026-09-01: "it's a new month, show the expected
  // reimbursement now").
  const cycleReimbursementIsStale = isMonthly && !paidThisCycle;
  const hasCurrentReimbursement = reimbursedCents > 0 && !cycleReimbursementIsStale;
  // Projection anchor: the most recent real reimbursement total for this
  // bill (bill.payments is newest-first; a cycle split between two people is
  // summed). Falls back to the pinned pattern's configured band when there's
  // no history yet.
  const lastReimbursedPayment = bill.payments.find((p) => p.reimbursedBy.length > 0);
  const lastReimbursementCents = lastReimbursedPayment
    ? lastReimbursedPayment.reimbursedBy.reduce((s, r) => s + Math.abs(r.amountCents), 0)
    : 0;
  const patternRangeMinCents = bill.reimbursementPatterns.reduce((s, p) => s + p.amountMinCents, 0);
  const patternRangeMaxCents = bill.reimbursementPatterns.reduce((s, p) => s + p.amountMaxCents, 0);
  const showExpectedReimbursement =
    isMonthly &&
    !bill.canceled &&
    bill.reimbursementPatterns.length > 0 &&
    !hasCurrentReimbursement &&
    (lastReimbursementCents > 0 || patternRangeMaxCents > 0);
  // The pill (either one) is the collapse toggle for the detail below. When
  // neither pill renders (e.g. a cancelled bill still showing its pattern),
  // there's nothing to toggle from, so the detail just stays visible.
  const reimbursementHasToggle = hasCurrentReimbursement || showExpectedReimbursement;
  const reimbursementDetailsShown = reimbursementOpen || !reimbursementHasToggle;
  // A single on-time payment needs nothing more than the checkmark below —
  // the ledger only earns its place when there's a genuine second payment
  // in the same cycle to explain (still possible even for a monthly bill:
  // a duplicate charge, a partial + catch-up payment).
  const showLedger = isMonthly ? paidThisCycle && currentCyclePayments.length > 1 : currentCyclePayments.length > 0;

  // The two reimbursement toggles + the "Needs a bucket" nudge — the same
  // small pills whether the row shows the /bills status pill or the
  // bucket-page EntryLine, so build them once. Skip moved into the kebab
  // (billActions above) — see canSkip's own comment.
  const needsBucketPill = !bill.bucketId && buckets.length > 0 && !bill.canceled;
  const hasPills = hasCurrentReimbursement || showExpectedReimbursement || needsBucketPill;
  const secondaryPills = (
    <>
      {hasCurrentReimbursement && (
        <button
          type="button"
          onClick={() => setReimbursementOpen((v) => !v)}
          aria-expanded={reimbursementOpen}
          title={`${formatCents(reimbursedCents)} reimbursed — net ${formatCents(totalCents - reimbursedCents)}`}
          className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
        >
          − {formatCents(reimbursedCents)} reimbursed
          <ChevronDown size={11} className={`shrink-0 transition-transform ${reimbursementOpen ? "rotate-180" : ""}`} />
        </button>
      )}
      {showExpectedReimbursement && (
        <button
          type="button"
          onClick={() => setReimbursementOpen((v) => !v)}
          aria-expanded={reimbursementOpen}
          title={
            bill.reimbursementPatterns.length === 1
              ? `Expected back via ${bill.reimbursementPatterns[0].label}`
              : "Expected reimbursement this cycle"
          }
          className="inline-flex items-center gap-1 rounded-full border border-emerald-200 dark:border-emerald-900 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
        >
          {lastReimbursementCents > 0
            ? `+ ${formatCents(lastReimbursementCents)} Expected`
            : `+ ${formatCents(patternRangeMinCents)}–${formatCents(patternRangeMaxCents)} Expected`}
          {bill.reimbursementPatterns.length === 1 ? ` · ${bill.reimbursementPatterns[0].label}` : ""}
          <ChevronDown size={11} className={`shrink-0 transition-transform ${reimbursementOpen ? "rotate-180" : ""}`} />
        </button>
      )}
      {needsBucketPill && (
        <span className="inline-block rounded-full bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          Needs a bucket
        </span>
      )}
    </>
  );

  if (hidden) return null;

  return (
    <li className={`flex flex-col gap-1 rounded-xl border border-blue-100 dark:border-neutral-800 p-4 ${barClass}`}>
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
            {bill.merchant && <MerchantLogo merchant={bill.merchant} size={16} allowGuess />}
            {bill.name}
            {bill.canceled && (
              <span className="inline-block whitespace-nowrap rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Cancelled
              </span>
            )}
            {!bill.dueDateLocked && !bill.canceled && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" title="Needs Attention — Due Date Not Yet Confirmed" />
            )}
          </p>
          {/* On a bucket page the subtitle moves below the divider (with the
              EntryLine) so the card matches DebtPaymentRow's layout — its
              border-t sits above the "$X · cadence · category" line too. */}
          {!bucket && (
            <p className="text-sm text-gray-600 dark:text-neutral-400">
              {formatCents(bill.amountCents)} · {CADENCE_LABEL[bill.cadence]} ·{" "}
              {bill.categoryName ? (
                <span className="text-emerald-700 dark:text-emerald-400">{bill.categoryName}</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Uncategorized</span>
              )}
            </p>
          )}
          {/* The status pill (or ledger) and the kebab, bottom-right, both
              moved out of this title column (see after this `<div>` below) —
              nested inside the same trailing block as the ledger so the
              kebab that follows always lands at the true bottom-right of the
              card, matching the `bucket` variant's own already-fixed layout
              just below. With the kebab left in the title column instead, a
              multi-payment cycle's ledger rendered as a later sibling pushed
              it up into the middle of the card instead of the corner every
              other row keeps it in (real report, 2026-09-14: "Cedar Creek
              Irrigation Debits Web," once its $2 service fee started
              auto-attaching alongside the main charge). The bucket variant
              renders a full-width EntryLine below the header instead (see
              after this row) and carries the kebab there. */}
        </div>
      </div>

      {bucket && (
        // A bucket's Recurring list: the divider sits directly under the
        // card title (above the "$X · cadence · category" subtitle), then
        // the same bullet + "Sep 3" + right-aligned amount row a debt
        // payment shows — matches DebtPaymentRow's layout (2026-09-01
        // household request). The relative "Due in N days" phrasing moves
        // to the date's tooltip.
        <div className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
          <p className="text-sm text-gray-600 dark:text-neutral-400">
            {formatCents(bill.amountCents)} · {CADENCE_LABEL[bill.cadence]} ·{" "}
            {bill.categoryName ? (
              <span className="text-emerald-700 dark:text-emerald-400">{bill.categoryName}</span>
            ) : (
              <span className="text-amber-700 dark:text-amber-400">Uncategorized</span>
            )}
          </p>
          {/* Once the ledger below is showing, every payment it lists already
              carries its own checkmark + date — this EntryLine's own "Sep 01
              $37.00" summary would just be that same first/primary payment
              listed twice (real report, 2026-09-14: "Cedar Creek Irrigation Debits
              Web" — same fix already made for the /bills non-bucket variant,
              see its own identical comment). The whole `<ul>` is skipped
              rather than just its contents so an empty list doesn't still
              claim a `gap-2` slot in the flex column below. isSkipped/due
              never coincide with showLedger in practice (showLedger implies
              paidThisCycle for a MONTHLY bill, isSkipped implies the
              opposite), so only the `paidThisCycle` case actually needs this
              — gating the whole ternary is just the simpler, safe superset. */}
          {!showLedger && (
            <ul className="flex flex-col gap-1.5 text-xs">
              {paidThisCycle ? (
                <EntryLine
                  state="paid"
                  date={new Date(bill.lastPaidDate!)}
                  amountCents={currentCyclePayments.length > 0 ? totalCents : bill.amountCents}
                  receipt={paidReceipt}
                  pending={currentCyclePayments.some((p) => p.pending)}
                />
              ) : isSkipped ? (
                // Same muted + trailing Undo treatment PayoffExtraSkip already
                // gets on /debts (EntryLine already supports both generically)
                // — shows the cycle that got skipped, not the new nextDueDate
                // it's already advanced past, same "settled" convention the
                // paid branch above follows until the next real rollover.
                <EntryLine
                  state="due"
                  date={new Date(bill.skippedCycleDueDate!)}
                  amountCents={bill.amountCents}
                  muted
                  trailingAction={
                    <button
                      type="button"
                      onClick={undoSkip}
                      disabled={unskipPending}
                      aria-label="Undo Skipping This Cycle"
                      title="Undo"
                      className="shrink-0 text-blue-900 dark:text-blue-300 disabled:opacity-50"
                    >
                      <Undo2 size={12} />
                    </button>
                  }
                />
              ) : (
                <EntryLine
                  state="due"
                  date={new Date(bill.nextDueDate)}
                  amountCents={bill.amountCents}
                  approximate={!bill.dueDateLocked}
                  dateClassName={dueDateProximity(new Date(bill.nextDueDate)).textClassName}
                  dateTitle={dueDateProximity(new Date(bill.nextDueDate)).label}
                />
              )}
            </ul>
          )}
          {/* Nested inside this same block (not a trailing sibling below) so
              the kebab that follows always lands at the true bottom-right of
              the card — with the ledger rendered as a later sibling instead,
              a multi-payment cycle pushed the kebab up into the middle of
              the card instead of the corner every other row keeps it in
              (real report, 2026-09-11: Riverside Gymnastics specifically,
              once it had 2 payments in a cycle). */}
          {showLedger && (
            <CycleLedger payments={currentCyclePayments} primaryOccurredOn={bill.lastPaidDate} totalCents={totalCents} />
          )}
          <RowActions actions={billActions} dense {...rowActionsProps}>
            {hasPills && <span className="flex flex-wrap items-center gap-1.5">{secondaryPills}</span>}
          </RowActions>
        </div>
      )}

      {!bucket && (
        <>
          {showLedger && (
            <CycleLedger payments={currentCyclePayments} primaryOccurredOn={bill.lastPaidDate} totalCents={totalCents} />
          )}
          <RowActions actions={billActions} dense {...rowActionsProps}>
            <span className="flex flex-wrap items-center gap-1.5">
              {/* Once the ledger above is showing, every payment it lists
                  already carries its own checkmark + date — repeating just
                  the first/primary one here as a plain "Paid {date}" summary
                  read as that same payment listed twice (real report,
                  2026-09-14: "Cedar Creek Irrigation Debits Web"'s $35 charge plus
                  its $2 attached service fee). Drop the summary once the
                  ledger's already telling the same story; secondaryPills
                  (reimbursed, Needs a bucket) still belong on this line
                  either way. */}
              {!showLedger &&
                (isSkipped ? (
                  // Same muted-with-Undo language as the `bucket` variant's
                  // EntryLine branch just above (this row uses plain text
                  // instead of EntryLine here, matching the Paid/status-pill
                  // treatment either side of it) — household request,
                  // 2026-09-14: "make sure it visually displays as skipped
                  // with an undo."
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    <CircleSlash size={15} className="shrink-0 text-neutral-400 dark:text-neutral-600" />
                    Skipped {formatDate(new Date(bill.skippedCycleDueDate!), { month: "short", day: "numeric" })}
                    <button
                      type="button"
                      onClick={undoSkip}
                      disabled={unskipPending}
                      aria-label="Undo Skipping This Cycle"
                      title="Undo"
                      className="text-blue-900 dark:text-blue-300 disabled:opacity-50"
                    >
                      <Undo2 size={12} />
                    </button>
                  </span>
                ) : paidThisCycle ? (
                  // Matched to DebtPaymentRow's paid-line treatment (2026-08-26
                  // household request: "make bills like debts") — no filled pill,
                  // just a bigger checkmark flush on the left with plain text.
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                    Paid {formatDate(new Date(bill.lastPaidDate!), { month: "short", day: "numeric" })}
                    {paidReceiptTrigger}
                  </span>
                ) : (
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}
                    title={bill.dueDateLocked ? undefined : "Approximate — Not Yet Confirmed"}
                  >
                    {bill.dueDateLocked ? "" : "~"}
                    {status.label}
                  </span>
                ))}
              {secondaryPills}
            </span>
          </RowActions>
          {!showLedger && !isSkipped && paidThisCycle && paidReceiptPanel}
        </>
      )}

      {/* Rendered independent of showLedger — a typical single-payment
          monthly bill (the common case) never shows the ledger above at
          all, but still needs somewhere to confirm "yes, this got
          reimbursed" (2026-08-26 household request: the same per-payment
          confirmation debt payments already have). */}
      {reimbursementDetailsShown &&
        !cycleReimbursementIsStale &&
        currentCyclePayments.some((p) => p.reimbursedBy.length > 0) && (
          <div className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
            {currentCyclePayments.map((p) => (
              <BillReimbursementLinker key={p.id} linked={p.reimbursedBy} />
            ))}
          </div>
        )}

      {reimbursementDetailsShown && bill.reimbursementPatterns.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
          {bill.reimbursementPatterns.map((p) => (
            <PatternRow
              key={p.id}
              pattern={p}
              buckets={buckets}
              debts={debts}
              bills={[{ id: bill.id, name: bill.name }]}
              categories={categories.filter((c) => c.bucketId === bill.bucketId)}
            />
          ))}
        </ul>
      )}

      {editing && (
        <form
          action={(formData) => {
            formAction(formData);
            setEditing(false);
            setActionsOpen(false);
          }}
          className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-3"
        >
          {/* Field order is fixed and mirrored in track-as-bill-form.tsx
              (household layout request, 2026-09-08): Name / Amount·Cadence·Due
              Date / Bucket·Category / Tolerance. Tolerance sits last because
              it's the rarely-touched "Auto" override — matchBillPayments
              learns the band from real payment history on its own now (see
              historicalToleranceCents, src/lib/recurring-bills.ts). */}
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            Name
            <input
              name="name"
              defaultValue={bill.name}
              required
              className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Amount
              <MoneyInput
                name="amount"
                defaultCents={bill.amountCents}
                required
                className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Cadence
              <SelectField
                name="cadence"
                value={cadence}
                onChange={(v) => changeCadence(v as BillData["cadence"])}
                searchable={false}
                options={CADENCE_OPTIONS}
                className="mt-1"
              />
            </label>
            {cadence === "MONTHLY" ? (
              <DayOfMonthPicker
                name="dueDay"
                value={dueDay}
                onChange={setDueDay}
                label="Due Date"
                unconfirmed={!bill.dueDateLocked}
              />
            ) : (
              <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                Due Date
                <input
                  name="nextDueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  required
                  className={`mt-1 rounded-lg border px-3 py-2 text-sm focus:outline-none ${
                    bill.dueDateLocked
                      ? "border-neutral-300 dark:border-neutral-700 focus:border-blue-900"
                      : "border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/30 focus:border-red-500"
                  }`}
                />
              </label>
            )}
          </div>
          <BucketCategoryFields
            buckets={buckets}
            bucketId={bucketId}
            onBucketChange={setBucketId}
            categories={categories}
            defaultCategoryId={bill.categoryId}
            allowNoBucket
            hideWithoutBuckets
          />
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            Amount Tolerance (optional — how much this can vary and still match a payment)
            <MoneyInput
              name="tolerance"
              defaultCents={bill.toleranceCents ?? undefined}
              placeholder="Auto"
              className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
            />
          </label>
          {state.error && <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>}
          <InlineSaveButton pending={pending} justSaved={justSaved} />
        </form>
      )}
    </li>
  );
}
