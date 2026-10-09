"use client";

import { type ReactNode, useState, useTransition } from "react";
import type { BillCadence } from "@prisma/client";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Binoculars, Bookmark, CircleSlash, GripVertical, Link2, Link2Off, PartyPopper, Receipt, Repeat, Undo2, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { showToast } from "@/lib/toast";
import { formatDate, ordinal, dueDateProximity } from "@/lib/date";

async function toasted(run: () => Promise<unknown>, message: string) {
  try {
    await run();
    showToast(message);
  } catch {
    showToast("Something Went Wrong", "error");
  }
}
import { capAtPayoffCents, pickPayoffPaymentTime, type PoolBreakdown } from "@/lib/debt-payoff";
import { EntryLine } from "@/components/entry-line";
import { InstallmentProgressBar } from "@/components/installment-progress-bar";
import { PlanReceiptSection, type PlanReceiptItem } from "@/components/plan-receipt-section";
import { MerchantLogos } from "@/components/merchant-logo";
import { debtLogoSearchText } from "@/lib/merchant-domains";
import { ledgerMinimumCents, resolveMinimumLedger } from "@/lib/minimum-ledger";
import {
  linkDebtAccount,
  markDebtPaymentPaid,
  settleDebtAmountDue,
  skipDebtMinimum,
  skipPayoffExtra,
  unskipDebtMinimum,
  unskipPayoffExtra,
} from "./actions";

// The minimum-payment half of the "this cycle" checklist — reuses
// DebtPayment/markDebtPaymentPaid (the same tracker Buckets already shows)
// rather than inventing a second minimum-payment concept just for this page.
// "This cycle" = the real current calendar month (household correction,
// 2026-08-25: "a cycle in the Flow context is a month... this applies to all
// recurring debts... we do reports based on month, buckets based on month, so
// everything should be" — matches how Buckets/Reports already work, via
// buildCycleSlots/occurrencesInPeriod, src/lib/cycle-slots.ts), not one
// cadence-length window ending at the due date — the previous definition
// dropped a real BIWEEKLY payment (Aug 18) from the ledger just because it
// happened to be the payment that closed out the *previous* cadence period,
// even though it landed in the same calendar month as the still-open one.
export type CycleMinimum = {
  debtPaymentId: string;
  // The regular per-cycle minimum — what a caught-up cycle resets to. Use
  // amountDueCents (below) for what's actually owed right now; this is only
  // the baseline a future not-yet-due slot's amount is guessed from.
  amountCents: number;
  // The live rolling total actually owed as of `dueDate` — see
  // DebtPayment.amountDueCents's schema comment. Equal to amountCents on a
  // caught-up debt; higher when a prior cycle (or several, compounding)
  // went unpaid.
  amountDueCents: number;
  dueDate: Date;
  // The raw DebtPayment.nextDueDate, unadjusted by buildCycleSlots — always
  // the genuine next occurrence per the tracked schedule, never a slot
  // already fulfilled this period. `dueDate` above is deliberately
  // *different* from this when paidThisCycle: it points at whichever
  // occurrence actually landed in the current calendar month for slot-
  // matching (debt-row.tsx's own paid-checklist), which for a caught-up
  // debt is a past, already-settled date. payoff-planner.tsx's
  // dueDateByDebtId needs *this* field instead in that case — projectCyclePlan
  // treats its input as "the next real due date" and re-simulates a minimum
  // deduction *and* an interest accrual tick there, so seeding it with an
  // already-settled date double-counts both (real household report,
  // 2026-08-26: a caught-up card's projected payoff calendar was overstating
  // available cash by roughly one extra month's interest on every affected
  // debt).
  nextDueDate: Date;
  // Whether `nextDueDate` lands in the current calendar month. Gates the
  // "This Month" ledger's fallback "Next due …" line: when nothing's
  // expected this month (`slots` empty) that date is always in a future
  // month, and showing it under "This Month" reads as next month's
  // obligation leaking in (repeat household report, 2026-08-30).
  nextDueThisMonth: boolean;
  // How often the minimum recurs — used by projectCyclePlan to roll
  // dueDate forward into each predictive cycle's own real due date,
  // instead of every debt's future minimum landing on the same generic
  // date.
  cadence: BillCadence;
  // True once every expected occurrence this calendar month (see `slots`
  // below) has a real payment. Drives the mark-paid button's disabled state.
  paidThisCycle: boolean;
  dueDateLocked: boolean;
  // Every real payment landing in the current calendar month, flat — kept
  // for payoff-planner.tsx's calendar view (thisCycleDayEvents), which wants
  // "every real payment this month" without caring about slot structure.
  payments: { id: string; amountCents: number; occurredOn: Date; pending?: boolean }[];
  // Every real payment landing in the *previous* calendar month, flat — feeds
  // payoff-planner.tsx's "Last Month" calendar page (a look-back at what was
  // actually paid), which is calendar-view-only and never touches slot
  // structure or projections.
  lastMonthPayments: { id: string; amountCents: number; occurredOn: Date; pending?: boolean }[];
  // One entry per expected occurrence of this debt's cadence landing in the
  // current calendar month (usually one for MONTHLY/ANNUAL, sometimes 2-3
  // for WEEKLY/BIWEEKLY) — `payment` is the real payment that satisfied it,
  // oldest-first positionally, or null while still open. See
  // src/lib/cycle-slots.ts.
  slots: { date: Date; payment: { id: string; amountCents: number; occurredOn: Date; pending?: boolean } | null }[];
  // Real payments this month beyond the expected slot count — paid ahead of
  // schedule, or just extra/rounding-up. For a no-minimum
  // (ignoreMinimumPayment) debt, page.tsx folds its slot-consuming payment(s)
  // into this list too so the ledger renders every payment as "· Extra" —
  // use extraPaymentsBeyondSlots below instead of this field for anything
  // that needs the true beyond-slot total (e.g. netting against a projected
  // payoff-plan extra).
  extraPayments: { id: string; amountCents: number; occurredOn: Date; pending?: boolean }[];
  // The same figure as `extraPayments`, but never folded for
  // ignoreMinimumPayment display — real payments beyond the expected slot
  // count, full stop. Matches src/lib/debt-payments.ts's
  // correctedDueDateByDebtId.extraPaidCents (what the dashboard/buckets use).
  extraPaymentsBeyondSlots: { id: string; amountCents: number; occurredOn: Date; pending?: boolean }[];
  // Ids of real payments matched to a payoff-plan payday's extra (see
  // splitPlanExtraPayments, cycle-slots.ts) — rendered with the emerald
  // extra-payment treatment instead of a plain "paid" line. Optional: only
  // /debts' page.tsx supplies it.
  planExtraPaymentIds?: string[];
  // ISO (YYYY-MM-DD) due dates of this month's covered minimums the household
  // skipped — see DebtMinimumSkip / resolveMinimumLedger. Optional: only
  // /debts' page.tsx supplies it.
  skippedSlotDates?: string[];
};

// The extra-payment half — pure projection, no tracker of its own (see
// projectCyclePlan). Every upcoming paycheck allocation to this debt that
// falls within the current cycle (this month) — independent of
// CycleMinimum/paidThisCycle: the payoff plan's extra pool cascades every
// paycheck regardless of whether this debt's own minimum-payment billing
// cycle happens to already be satisfied. Predictive cycles beyond this one
// render via PayoffCycleCard instead, not this row.
export type CycleExtra = {
  paycheckDate: Date;
  amountCents: number;
  // True when this payment is the one projected to bring the debt's
  // balance to $0 — renders a trailing star on the line.
  isPayoff: boolean;
  // What this paycheck's extra pool was made of — undefined when it's just
  // the flat per-paycheck amount, nothing rolled in.
  poolBreakdown?: PoolBreakdown;
  // Whether a real synced payment already covers this projected extra —
  // derived in payoff-planner.tsx from the debt's own real extra payments
  // this cycle (cycleMinimum.extraPayments, oldest-projected-line-first),
  // not a manual checkbox: household feedback 2026-08-26 ("I don't want to
  // click a checkbox for extra payment, it should be automated via
  // SimpleFIN wherever possible") after an earlier version of this asked
  // for an explicit confirm click.
  confirmed: boolean;
  // True only for the current cycle's own payday (the most recent one on or
  // before today — see projectCyclePlan's past-payday branch,
  // src/lib/debt-payoff.ts) when it hasn't posted yet — gates whether the
  // skip control below can even appear; a later-in-month simulated line
  // isn't skippable (household decision, 2026-09-04: skip is only ever for
  // "what's due right now," not a future payday you haven't reached yet).
  pending?: boolean;
  // True when the household explicitly skipped this pending extra (see
  // skipPayoffExtra/PayoffExtraSkip) — renders muted/struck with an Undo
  // instead of the skip control. A pending line is otherwise assumed to go
  // through on schedule (real balance/isPayoff, same as any future payday —
  // household correction, 2026-09-04); skip is the one way to say "not this
  // one" and forfeit it instead.
  skipped?: boolean;
};

export function DebtRow({
  debt,
  attackOrderIndex,
  payoffDate,
  suggestedAccount,
  needsSetup,
  patternCount,
  draggable,
  cycleMinimum,
  expectedExtras,
  readOnly,
  todayISO,
  lookBack = false,
}: {
  debt: {
    id: string;
    name: string;
    // The household's own free-text note ("Sam's Kobes") — see Debt.label.
    label?: string | null;
    balanceCents: number;
    aprBasisPoints: number;
    minPaymentCents: number;
    // See Debt.ignoreMinimumPayment in schema.prisma — optional since some
    // older callers still pass a plain DebtInput that predates this field.
    ignoreMinimumPayment?: boolean;
    debtType: "REVOLVING" | "INSTALLMENT";
    kind: "CARD" | "LOAN" | "BNPL";
    installmentsTotal: number | null;
    installmentsRemaining: number | null;
    // Itemization + total from the email receipt for the original purchase,
    // once linked to this plan (Receipt.debtId / linkReceiptToPlan). Optional
    // — older/other callers pass a plain DebtInput without it.
    receiptItems?: PlanReceiptItem[] | null;
    receiptTotalCents?: number | null;
    source: "MANUAL" | "SIMPLEFIN";
    accountId: string | null;
    paidOffDate: Date | null;
    includeInPayoffPlan: boolean;
    // The linked account's raw synced name and its institution name,
    // distinct from `name` above (which already prefers a household's own
    // renamed Account.displayName) — see debts/page.tsx's own comment on
    // this same field. Logo matching below also searches these, tiered via
    // debtLogoSearchText (raw name first, institution name only as a last
    // resort — it isn't reliably accurate on its own). Never shown as text.
    // Optional — older/other callers pass a plain DebtInput without them.
    accountRawName?: string | null;
    accountOrgName?: string | null;
  };
  attackOrderIndex: number | null;
  payoffDate: Date | null;
  suggestedAccount?: { id: string; name: string } | null;
  needsSetup: boolean;
  // Number of DEBIT RecurringPatterns targeting this debt directly (a
  // Venmo/Zelle payment classified straight to it, no bucket) — see the
  // link below.
  patternCount: number;
  // Whether this row participates in drag-reordering — false for
  // paid-off/excluded debts, which always render trailing and never have an
  // attack-order position to drag into (see PayoffPlanner).
  draggable: boolean;
  cycleMinimum: CycleMinimum | null;
  expectedExtras: CycleExtra[];
  // Non-owner full-access member (2026-08-21: debts went fully read-only
  // for them — see requireOwner in ./actions) — hides the "link suggested
  // account" nudge entirely (its only action is linkDebtAccount, now
  // owner-only) and disables the "mark minimum paid" button below, same
  // dead-end-avoidance treatment as the suggestion cards elsewhere.
  readOnly: boolean;
  // Server-computed "today" (todayAsUTCDate, @/lib/date), as a plain
  // YYYY-MM-DD string — gates the Undo control on a skipped line below.
  // Passed down rather than read via `new Date()` in this client component:
  // this app's container runs TZ=America/Denver but a browser's own clock
  // can sit in any timezone, and comparing local-clock dates against a
  // UTC-midnight paycheckDate risks a server/client hydration mismatch right
  // at a day boundary (see the module comment on todayAsUTCDate, date.ts).
  todayISO: string;
  // Rendering last month's ledger (the Payoff Calendar's "Last Month" list
  // page) rather than this month's — `cycleMinimum` is scoped to that month.
  // Mark-paid is only offered on the slot the tracker itself still sits on
  // (nextDueDate hasn't rolled out of last month yet); an older slot would
  // otherwise mark the tracker's *current* occurrence paid.
  lookBack?: boolean;
}) {
  const [linkPending, startLinkTransition] = useTransition();
  const [minPending, startMinTransition] = useTransition();
  const [skipPending, startSkipTransition] = useTransition();
  // Which pending extra line (keyed `${debtId}:${paycheckDateISO}`) is
  // showing its inline "Skip this extra payment?" gate — the gated ask the
  // household wanted before a skip actually lands (household request,
  // 2026-09-04). At most one open at a time.
  const [skipConfirmKey, setSkipConfirmKey] = useState<string | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const hasReceipt = (debt.receiptItems?.length ?? 0) > 0;
  const linked = debt.source === "SIMPLEFIN";
  const paidOff = debt.balanceCents === 0;
  // For a paid-off debt, the one payment that actually took the balance to
  // $0 gets a green star in the ledger below instead of the plain check —
  // see pickPayoffPaymentTime (debt-payoff.ts) for why that's not just
  // whichever payment happens to be latest this cycle.
  const cycleMinimumPayments = cycleMinimum
    ? [...cycleMinimum.slots.flatMap((s) => (s.payment ? [s.payment] : [])), ...cycleMinimum.extraPayments]
    : [];
  const payoffPaymentTime = pickPayoffPaymentTime(cycleMinimumPayments, debt.balanceCents, debt.paidOffDate);
  const payoffPaymentId =
    payoffPaymentTime !== null
      ? (cycleMinimumPayments.find((p) => p.occurredOn.getTime() === payoffPaymentTime)?.id ?? null)
      : null;
  // Whether the "This Month" minimum section actually has anything to show
  // once paid off — real payment history (slots/extraPayments) still
  // counts, but an empty/future obligation doesn't (see the paidOff filter
  // below), so the section header itself shouldn't render over nothing.
  const cycleMinimumHasContent = cycleMinimum
    ? paidOff
      ? cycleMinimum.slots.some((s) => s.payment) || cycleMinimum.extraPayments.length > 0
      : // An active debt with nothing expected this month (no slots), no real
        // payments this month (no extraPayments), and a next due date that's
        // in a future month has nothing to say under "This Month" — the
        // section header shouldn't render over an empty list (which otherwise
        // showed a bare "Next due <next month>" line, 2026-08-30).
        cycleMinimum.slots.length > 0 ||
        cycleMinimum.extraPayments.length > 0 ||
        // Only a debt that actually carries a minimum gets the fallback
        // "Next due …" pointer — a no-minimum / ignore-minimum card (Sam's
        // Club) has no payment owed on its due date, so it shouldn't list one
        // (household request, 2026-09-01).
        (cycleMinimum.nextDueThisMonth && !debt.ignoreMinimumPayment && cycleMinimum.amountCents > 0)
    : false;
  const isInstallment = debt.debtType === "INSTALLMENT";
  // "Payment 3 of 12" — derived from the stored total/remaining rather than
  // its own field, so it's always in sync with whatever last updated them.
  // Checked against `!= null` rather than truthy — installmentsRemaining
  // === 0 is a legit "fully paid off" value but falsy, and the bar below
  // must still render (at 100%) for exactly that case (this used to check
  // truthy and silently hid the bar the moment an installment plan finished,
  // same bug ManualDebtEditor's own derivation fixed separately).
  const currentPayment =
    isInstallment && debt.installmentsTotal != null && debt.installmentsRemaining != null
      ? debt.installmentsTotal - debt.installmentsRemaining + 1
      : null;

  // The whole "This Month" ledger for this debt, merged into one
  // chronological list — real minimum payments, the still-open minimum, real
  // extra payments, and every projected extra paycheck, sorted by date
  // (household request, 2026-09-01: "they should be listed Sep 3, then min on
  // Sept 12 full amount, then payoff extra on 17").
  const minRegularCents = cycleMinimum?.amountCents ?? 0;
  // What an unpaid minimum line shows: the full recurring minimum, never the
  // rolling $0 a caught-up tracker reports for a cycle whose early extra
  // payment already covered it — "minimum is always paid" (household rule,
  // 2026-09-01). Arrears (amountDueCents > amountCents) still win, and keep
  // the "carried over" sub-note.
  // Never more than it takes to pay the debt off (capAtPayoffCents): a $65
  // minimum on a card with $59.27 left reads $59.27.
  const minDisplayCents = capAtPayoffCents(Math.max(minRegularCents, cycleMinimum?.amountDueCents ?? 0), debt);
  const minDueLineCents = capAtPayoffCents(minRegularCents, debt);
  // A projected extra payment that clears this debt makes every later
  // minimum moot — the balance is gone before that due date, so the line
  // drops out entirely rather than showing as still-owed (household request,
  // 2026-09-01: "this card is paid off with the extra on the 3rd, so the
  // minimum payment won't show at all").
  const projectedPayoffDate = expectedExtras.find((e) => e.isPayoff)?.paycheckDate ?? null;
  const minDroppedByPayoff = (slotDate: Date) =>
    projectedPayoffDate !== null && projectedPayoffDate.getTime() <= slotDate.getTime();

  // A payment made ahead of a slot's due date that's bigger than the minimum
  // (a $177 payment against an $84 minimum due the 27th) already satisfies the
  // cycle, but buildCycleSlots hands it the slot — so the still-scheduled
  // minimum used to vanish from this list. resolveMinimumLedger keeps it
  // listed as a "covered" line the household can skip (household request,
  // 2026-09-19). Presentation only; an unsatisfied slot is never covered.
  const ledger =
    cycleMinimum && cycleMinimum.slots.length > 0
      ? resolveMinimumLedger({
          slots: cycleMinimum.slots,
          extraPayments: cycleMinimum.extraPayments,
          // 0 disables the "covered" state — see ledgerMinimumCents.
          minimumCents: ledgerMinimumCents({
            paidOff,
            nextDueThisMonth: cycleMinimum.nextDueThisMonth,
            amountDueCents: cycleMinimum.amountDueCents,
            minimumCents: minRegularCents,
          }),
          skippedDates: new Set(cycleMinimum.skippedSlotDates ?? []),
        })
      : null;
  const ledgerExtraPayments = ledger?.extraPayments ?? cycleMinimum?.extraPayments ?? [];

  const ledgerRows: { sortMs: number; el: ReactNode }[] = [];
  if (cycleMinimum) {
    if (ledger) {
      for (const entry of ledger.entries) {
        if (entry.kind === "payment") {
          const p = entry.payment;
          ledgerRows.push({
            sortMs: p.occurredOn.getTime(),
            el: (
              <EntryLine
                key={p.id}
                state="paid"
                date={p.occurredOn}
                amountCents={p.amountCents}
                payoff={p.id === payoffPaymentId}
                pending={p.pending}
              />
            ),
          });
          continue;
        }
        if (paidOff) continue;
        if (entry.kind === "covered") {
          if (minRegularCents <= 0 || minDroppedByPayoff(entry.date)) continue;
          const isoDate = entry.date.toISOString().slice(0, 10);
          const confirmKey = `min:${debt.id}:${isoDate}`;
          const showSkipConfirm = skipConfirmKey === confirmKey;
          ledgerRows.push({
            sortMs: entry.date.getTime(),
            el: (
              <EntryLine
                key={`covered-${isoDate}`}
                state="due"
                date={entry.date}
                amountCents={minRegularCents}
                approximate={!cycleMinimum.dueDateLocked}
                muted={entry.skipped}
                trailingAction={
                  // Same shape as the payoff-plan extra's skip below: Undo
                  // only until the skipped date passes, the skip control only
                  // while not already skipped. The row only
                  // exists at all because the cycle's minimum is satisfied —
                  // an unsatisfied minimum never reaches this branch.
                  entry.skipped && isoDate >= todayISO ? (
                    <button
                      type="button"
                      disabled={skipPending}
                      onClick={() => startSkipTransition(() => toasted(() => unskipDebtMinimum(debt.id, isoDate), "Unskipped"))}
                      aria-label="Undo skipping this minimum payment"
                      title="Undo"
                      className="shrink-0 text-blue-900 dark:text-blue-300 disabled:opacity-50"
                    >
                      <Undo2 size={12} />
                    </button>
                  ) : !entry.skipped && !readOnly ? (
                    <button
                      type="button"
                      disabled={skipPending}
                      onClick={() => setSkipConfirmKey(confirmKey)}
                      aria-label="Skip this minimum payment"
                      title="Skip this minimum payment"
                      className="shrink-0 text-neutral-400 hover:text-red-600 dark:text-neutral-500 dark:hover:text-red-400 disabled:opacity-50"
                    >
                      <CircleSlash size={13} />
                    </button>
                  ) : undefined
                }
              >
                {showSkipConfirm ? (
                  <p className="ml-[23px] flex items-center gap-2 text-[11px] text-neutral-600 dark:text-neutral-400">
                    Skip this minimum payment?
                    <button
                      type="button"
                      disabled={skipPending}
                      onClick={() => {
                        setSkipConfirmKey(null);
                        startSkipTransition(() =>
                          toasted(() => skipDebtMinimum(debt.id, isoDate, minRegularCents), "Payment Skipped"),
                        );
                      }}
                      className="font-medium text-red-600 dark:text-red-400 underline disabled:opacity-50"
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      onClick={() => setSkipConfirmKey(null)}
                      className="font-medium text-blue-900 dark:text-blue-300 underline decoration-dotted"
                    >
                      Cancel
                    </button>
                  </p>
                ) : (
                  !entry.skipped && (
                    <p className="ml-[23px] text-[11px] text-neutral-500 dark:text-neutral-400">
                      Already covered by an earlier payment.
                    </p>
                  )
                )}
              </EntryLine>
            ),
          });
          continue;
        }
        const slot = { date: entry.date };
        if (minDisplayCents <= 0 || minDroppedByPayoff(slot.date)) continue;
        const isActionableSlot =
          slot.date.getTime() === cycleMinimum.dueDate.getTime() &&
          (!lookBack || slot.date.getTime() === cycleMinimum.nextDueDate.getTime());
        const proximity = dueDateProximity(slot.date);
        ledgerRows.push({
          sortMs: slot.date.getTime(),
          el: isActionableSlot ? (
            <EntryLine
              key={slot.date.getTime()}
              state="due"
              date={slot.date}
              amountCents={minDisplayCents}
              approximate={!cycleMinimum.dueDateLocked}
              dateClassName={proximity.textClassName}
              dateTitle={proximity.label}
              onToggle={() => startMinTransition(() => toasted(() => markDebtPaymentPaid(cycleMinimum.debtPaymentId), "Payment Marked Paid"))}
              disabled={readOnly || minPending}
            >
              {minDisplayCents > cycleMinimum.amountCents && (
                <p className="ml-[23px] flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400">
                  Includes {formatCents(minDisplayCents - cycleMinimum.amountCents)} carried over from an
                  earlier cycle
                  {!readOnly && (
                    <button
                      type="button"
                      disabled={minPending}
                      onClick={() => startMinTransition(() => toasted(() => settleDebtAmountDue(cycleMinimum.debtPaymentId), "Marked Caught Up"))}
                      title="This is wrong — I'm actually caught up on this debt"
                      className="font-medium text-blue-900 dark:text-blue-300 underline decoration-dotted disabled:opacity-50"
                    >
                      Mark Caught Up
                    </button>
                  )}
                </p>
              )}
            </EntryLine>
          ) : (
            <EntryLine
              key={slot.date.getTime()}
              state="due"
              date={slot.date}
              amountCents={minDueLineCents}
              // Same flag as the actionable slot above — every slot here is
              // walked forward from the tracker's own nextDueDate at a fixed
              // cadence, so an unconfirmed anchor makes every one of them a
              // projection, not just whichever happens to be "actionable"
              // (real report, 2026-09-07: Klarna - Puma's Sep 3 slot — the
              // exact one known to be wrong — kept showing with no "~" at
              // all, since only the later Sep 17 slot ever received this
              // prop).
              approximate={!cycleMinimum.dueDateLocked}
              dateClassName={proximity.textClassName}
              dateTitle={proximity.label}
            />
          ),
        });
      }
    } else if (
      !paidOff &&
      cycleMinimum.nextDueThisMonth &&
      !debt.ignoreMinimumPayment &&
      minRegularCents > 0
    ) {
      // No occurrence lands this month as a slot, but the tracked next due
      // date itself is still this month — a plain pointer (see the 2026-08-30
      // fallback). Suppressed for a no-minimum card and once paid off.
      ledgerRows.push({
        sortMs: cycleMinimum.dueDate.getTime(),
        el: (
          <EntryLine
            key="next-due"
            state="due"
            date={cycleMinimum.dueDate}
            amountCents={minDueLineCents}
            approximate={!cycleMinimum.dueDateLocked}
            dateClassName={dueDateProximity(cycleMinimum.dueDate).textClassName}
            dateTitle={dueDateProximity(cycleMinimum.dueDate).label}
          />
        ),
      });
    }
  }
  // Real payments this month beyond the required minimum — paid ahead,
  // rounding-up, or (for a no-minimum card, where page.tsx folds every
  // payment in here) just every payment. Rendered as a plain neutral "paid"
  // line, same as a minimum payment: the emerald + banknote-arrow "extra
  // principal" treatment is reserved for the paydown plan's own extras
  // (household call, 2026-09-02) — a routine payment on a no-minimum card
  // isn't a bonus principal hit, it's just the payment. A real payment the
  // plan matched to one of its paydays (planExtraPaymentIds) *is* the plan's
  // extra, so it keeps that treatment once paid (household request,
  // 2026-10-05: Amazon's Oct 2 $108.33 read as an ordinary payment).
  const planExtraPaymentIds = new Set(cycleMinimum?.planExtraPaymentIds ?? []);
  for (const p of ledgerExtraPayments) {
    const isPlanExtra = planExtraPaymentIds.has(p.id);
    ledgerRows.push({
      sortMs: p.occurredOn.getTime(),
      el: (
        <EntryLine
          key={p.id}
          state={isPlanExtra ? "expected" : "paid"}
          cleared={isPlanExtra}
          date={p.occurredOn}
          amountCents={p.amountCents}
          payoff={p.id === payoffPaymentId}
          pending={p.pending}
        />
      ),
    });
  }
  // Every projected upcoming extra paycheck for this debt this cycle — an
  // open bullet until a real synced payment covers it (extra.confirmed).
  // Only the current cycle's own pending line (extra.pending) ever gets a
  // skip control — a later-in-month simulated line isn't something to skip
  // yet (household decision, 2026-09-04). Also gated on !extra.confirmed:
  // `confirmed` comes from real posted money (matchDebtPayments, see
  // payoff-planner.tsx's own comment on it) landing independently of this
  // simulation's own pending flag, so a line can go pending -> confirmed
  // without ever stopping being "pending" here — offering to Skip something
  // a real payment already covers would just mark it skipped *underneath*
  // its own checkmark instead of doing anything meaningful (household
  // question, 2026-09-14, asked about the identical bill-skip gate: "will
  // you make skip gate[d] if it isn't [paid]? for both bill and extra
  // payment" — RecurringBill's own Skip already gates on !paidThisCycle,
  // this is the same principle here).
  for (const [i, extra] of expectedExtras.entries()) {
    const isoDate = extra.paycheckDate.toISOString().slice(0, 10);
    const confirmKey = `${debt.id}:${isoDate}`;
    const showSkipConfirm = skipConfirmKey === confirmKey;
    ledgerRows.push({
      sortMs: extra.paycheckDate.getTime(),
      el: (
        <EntryLine
          key={`x-${i}`}
          state="expected"
          cleared={extra.confirmed}
          date={extra.paycheckDate}
          amountCents={extra.amountCents}
          payoff={extra.isPayoff}
          muted={extra.skipped}
          poolBreakdown={extra.poolBreakdown}
          trailingAction={
            // Undo only until the skipped date passes — the household's rule
            // for every skip (2026-09-20; skipped bills, extras and covered
            // minimums alike): that's the window to change your mind, and
            // afterward there's nothing left to undo back into — the payday
            // already came and went without this extra going out.
            extra.skipped && isoDate >= todayISO ? (
              <button
                type="button"
                disabled={skipPending}
                onClick={() => startSkipTransition(() => toasted(() => unskipPayoffExtra(debt.id, isoDate), "Unskipped"))}
                aria-label="Undo skipping this extra payment"
                title="Undo"
                className="shrink-0 text-blue-900 dark:text-blue-300 disabled:opacity-50"
              >
                <Undo2 size={12} />
              </button>
            ) : extra.pending && !extra.confirmed && !extra.skipped && !readOnly ? (
              <button
                type="button"
                disabled={skipPending}
                onClick={() => setSkipConfirmKey(confirmKey)}
                aria-label="Skip this extra payment"
                title="Skip this extra payment"
                className="shrink-0 text-neutral-400 hover:text-red-600 dark:text-neutral-500 dark:hover:text-red-400 disabled:opacity-50"
              >
                <CircleSlash size={13} />
              </button>
            ) : undefined
          }
        >
          {showSkipConfirm && (
            <p className="ml-[23px] flex items-center gap-2 text-[11px] text-neutral-600 dark:text-neutral-400">
              Skip this extra payment?
              <button
                type="button"
                disabled={skipPending}
                onClick={() => {
                  setSkipConfirmKey(null);
                  startSkipTransition(() =>
                    toasted(
                      () => skipPayoffExtra(debt.id, isoDate, extra.amountCents, extra.isPayoff),
                      "Payment Skipped",
                    ),
                  );
                }}
                className="font-medium text-red-600 dark:text-red-400 underline disabled:opacity-50"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => setSkipConfirmKey(null)}
                className="font-medium text-blue-900 dark:text-blue-300 underline decoration-dotted"
              >
                Cancel
              </button>
            </p>
          )}
        </EntryLine>
      ),
    });
  }
  ledgerRows.sort((a, b) => a.sortMs - b.sortMs);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: debt.id,
    disabled: !draggable,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative rounded-xl border p-4 ${isDragging ? "z-10 opacity-90 shadow-lg" : ""} ${
        paidOff
          ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20"
          : attackOrderIndex !== null
            ? "border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20"
            : "border-blue-100 dark:border-neutral-800"
      }`}
    >
      {attackOrderIndex !== null && (
        <span className="font-comfortaa absolute -top-2 -left-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-900 dark:bg-blue-700 text-base text-white ring-2 ring-white dark:ring-neutral-950">
          {attackOrderIndex + 1}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-1.5">
          {draggable && (
            // Full-size touch target (44px) — replaces the old up/down
            // chevron pair, which was ~13px and hard to hit reliably on
            // mobile.
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={`Drag to reorder ${debt.name} in the payoff attack order`}
              title="Drag to Reorder"
              className="-ml-1 flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center text-neutral-400 dark:text-neutral-500 active:cursor-grabbing"
            >
              <GripVertical size={18} />
            </button>
          )}
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-tight font-medium text-neutral-900 dark:text-neutral-100">
              {/* Curated table only, no allowGuess — same reasoning as
                  DebtPaymentCard's identical addition (debt-payment-card.tsx):
                  debt.name can be a household's own free-text override, not
                  always a real business name, so guessing a domain for it
                  risks a wrong logo. A curated hit (Klarna/Affirm/Chase/
                  Verizon/etc., including once renamed to one) still shows
                  normally (household request, 2026-09-13). MerchantLogos
                  (not MerchantLogo) — a composite BNPL name like
                  "Nike - Klarna" shows both logos, in either word order.
                  debtLogoSearchText also searches the raw synced account
                  name and, only as a last resort, the account's
                  institution name — so a rename that drops the one word a
                  pattern needed ("Capital One Venture" -> "Venture (3021)")
                  still doesn't lose the logo, without unconditionally
                  risking a wrong second one from an inaccurate institution
                  name (household request, 2026-09-14: "revert the double
                  brand icon"). */}
              <MerchantLogos
                merchant={debtLogoSearchText(debt.name, debt.accountRawName ?? null, debt.accountOrgName ?? null)}
                size={16}
                max={debt.kind === "BNPL" ? 2 : 1}
              />
              {debt.name}
              {(linked ? (
                  <span title="Synced from a Connected Account" className="shrink-0">
                    <Link2 size={13} className="text-blue-700 dark:text-blue-400" />
                  </span>
                ) : (
                  <span title="Manual — Not Synced to a Connected Account" className="shrink-0 text-neutral-400 dark:text-neutral-500">
                    <Link2Off size={13} />
                  </span>
                ))}
              {/* Only a card can realistically run a balance back up after
                  payoff — a loan or a BNPL plan is a fixed, closed schedule,
                  so "watching for new charges" is meaningless there. `kind`,
                  not `debtType`: a loan is REVOLVING too (see DebtKind in
                  schema.prisma), only BNPL is INSTALLMENT. Sits next to the
                  linked icon it qualifies rather than down in the Paid Off
                  line (household layout request, 2026-09-09). */}
              {paidOff && linked && debt.kind === "CARD" && (
                <span title="Watching for New Charges" className="shrink-0 text-blue-700 dark:text-blue-400">
                  <Binoculars size={12} />
                </span>
              )}
              {/* Receipt for the original BNPL purchase (Receipt.debtId) —
                  toggles the itemization panel below, same as a /transactions
                  row's receipt affordance (household request, 2026-09-01). */}
              {hasReceipt && (
                <button
                  type="button"
                  onClick={() => setReceiptOpen((v) => !v)}
                  aria-expanded={receiptOpen}
                  aria-label={receiptOpen ? "Hide Receipt" : "View Receipt"}
                  title={receiptOpen ? "Hide Receipt" : "View Receipt"}
                  className="shrink-0 text-emerald-700 dark:text-emerald-400"
                >
                  <Receipt size={13} />
                </button>
              )}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className={`leading-tight font-medium ${paidOff ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
            {formatCents(debt.balanceCents)}
          </p>
        </div>
      </div>

      {/* The plan's own label ("Sam's Kobes", "Hard Drive for Server — 0%
          promo, pay off by 10/23") on its own full-width row right below the
          name/balance header, ahead of the APR/due-date line (household
          layout request, 2026-09-09) — a long one wraps in full here instead
          of truncating against the balance column. leading-tight on the
          balance figure above matters here: without it, that default
          line-height (larger font than this xs label) pads extra space below
          the header that this row's own mt-0.5 then stacks on top of, so the
          gap read as much bigger than the same margin looks anywhere else on
          the card. */}
      {debt.label && (
        <p className="mt-0.5 flex items-start gap-1 text-xs font-normal text-blue-900 dark:text-blue-300">
          <Bookmark size={11} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{debt.label}</span>
        </p>
      )}

      {/* APR/minimum/due-date, projected payoff, and setup/pattern links all
          moved to their own full-width rows below the name/balance header
          (2026-09-05 household report) — nested inside that header's
          min-w-0 column, they were squeezed against the balance figure and
          wrapped awkwardly ("due on the\n21st") well before the card's real
          width ran out. Same fix debt.label already had below. */}
      {paidOff ? (
        <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          <PartyPopper size={13} /> Paid Off
          {debt.paidOffDate && ` ${formatDate(debt.paidOffDate, { month: "short", day: "numeric", year: "numeric" })}`}
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-neutral-400">
            {(debt.aprBasisPoints / 100).toFixed(2)}% APR ·{" "}
            {!isInstallment && debt.ignoreMinimumPayment
              ? "No Minimum"
              : isInstallment
                ? `${formatCents(debt.minPaymentCents)}/payment`
                : `${formatCents(debt.minPaymentCents)}/mo`}
            {/* Day-of-month only, never a month name — this is a fixed
                recurring fact ("due on the 4th of every cycle"), not
                this cycle's specific date, which the ledger below
                handles (and which can legitimately be in a different
                month for a household paying ahead of schedule). */}
            {cycleMinimum && (
              <span title={cycleMinimum.dueDateLocked ? undefined : "Approximate — Not Yet Confirmed"}>
                {` · due on the ${cycleMinimum.dueDateLocked ? "" : "~"}${ordinal(cycleMinimum.dueDate.getUTCDate())}`}
              </span>
            )}
          </p>
          {payoffDate && (
            <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400">
              Projected Payoff: {formatDate(payoffDate, { month: "short", year: "numeric" })}
            </p>
          )}
        </>
      )}
      {needsSetup && (
        // Editing (balance/terms) and deleting both live in Account
        // Settings now for every debt, linked or manual (2026-08-16
        // consolidation) — and this row no longer renders its own
        // DebtPaymentRow at all, so without this a debt needing setup
        // had no visible "go fix it" link anywhere here.
        <Link
          href="/settings/accounts"
          className="mt-1 inline-block rounded-full bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/60"
        >
          Needs Setup — Edit in Settings →
        </Link>
      )}
      {patternCount > 0 && (
        <Link
          href={`/transactions?status=debt&debtId=${debt.id}`}
          className="mt-1 flex items-center gap-1 text-xs text-blue-800 dark:text-blue-400 hover:underline"
        >
          <Repeat size={11} />
          {patternCount} Venmo pattern{patternCount === 1 ? "" : "s"}
        </Link>
      )}

      {currentPayment && debt.installmentsTotal && (
        <InstallmentProgressBar className="mt-2" currentPayment={currentPayment} total={debt.installmentsTotal} />
      )}

      <PlanReceiptSection
        items={debt.receiptItems}
        totalCents={debt.receiptTotalCents}
        className="mt-2"
        controlledOpen={receiptOpen}
      />

      {!linked && suggestedAccount && !suggestionDismissed && !readOnly && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-1.5">
          <span className="text-xs text-emerald-800 dark:text-emerald-300">
            Looks like <span className="font-medium">{suggestedAccount.name}</span> — link it?
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSuggestionDismissed(true)}
              aria-label="Dismiss Account Suggestion"
              title="Dismiss Suggestion"
              className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            >
              <X size={13} />
            </button>
            <button
              onClick={() => startLinkTransition(() => toasted(() => linkDebtAccount(debt.id, suggestedAccount.id), "Account Linked"))}
              disabled={linkPending}
              aria-label="Link Suggested Account"
              title="Link Account"
              className="rounded-lg bg-emerald-700 dark:bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {linkPending ? <span aria-label="Linking Account">…</span> : <Link2 size={12} />}
            </button>
          </div>
        </div>
      )}

      {(cycleMinimumHasContent || expectedExtras.length > 0) && ledgerRows.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-blue-100 dark:border-neutral-800 pt-2">
          {/* One date-ordered ledger (see ledgerRows above) — real minimum
              payments, the still-open minimum, real extras, and every
              projected extra paycheck merged chronologically. Every row is
              full-width with the same icon/label/amount layout, so the
              trailing dollar figures land on the same right edge. */}
          <ul className="flex flex-col gap-1.5 text-xs">{ledgerRows.map((r) => r.el)}</ul>
        </div>
      )}
    </li>
  );
}
