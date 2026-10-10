"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { CreditCard, EyeOff, Pencil, PartyPopper, Receipt, Target, X } from "lucide-react";
import { formatCents, parseDollarsToCents, formatBasisPoints } from "@/lib/money";
import { formatDate, dayOfMonthUTC, ordinal, nextOccurrenceOfDay, currentMonthOccurrenceOfDay } from "@/lib/date";
import { DayOfMonthPicker } from "@/components/day-of-month-picker";
import { DebtLabelEditor } from "@/components/debt-label-editor";
import { InlineSaveButton } from "@/components/inline-save-button";
import { useActionToast } from "@/lib/use-action-toast";
import { withToast } from "@/lib/toast";

const toasted = withToast;
import { InstallmentProgressBar } from "@/components/installment-progress-bar";
import { ExpandableSummary } from "./expandable-summary";
import { PlanReceiptSection, type PlanReceiptItem } from "@/components/plan-receipt-section";
import {
  renameDebt,
  updateDebtBalance,
  updateDebtTerms,
  updateInstallmentTerms,
  updateDebtKind,
  setDebtIncludedInPayoffPlan,
  hideDebt,
  linkDebtAccount,
  type RenameDebtState,
  type UpdateBalanceState,
  type UpdateTermsState,
  type UpdateInstallmentState,
} from "@/app/debts/actions";
import { MoneyInput } from "@/components/money-input";
import { PercentInput } from "@/components/percent-input";
import { SelectField } from "@/components/select-field";
import { BucketCategoryFields } from "@/components/bucket-category-fields";
import { type CategoryOption } from "@/app/bills/category-picker";
import { CADENCE_OPTIONS } from "@/lib/cadence-label";

const initialRenameState: RenameDebtState = {};
const initialBalanceState: UpdateBalanceState = {};
const initialTermsState: UpdateTermsState = {};
const initialInstallmentState: UpdateInstallmentState = {};

type Cadence = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL";

export type ManualDebt = {
  id: string;
  name: string;
  debtType: "REVOLVING" | "INSTALLMENT";
  // CARD/LOAN only meaningful when debtType is REVOLVING — always BNPL
  // otherwise (see DebtKind's doc comment in schema.prisma).
  kind: "CARD" | "LOAN" | "BNPL";
  balanceCents: number;
  aprBasisPoints: number;
  minPaymentCents: number;
  // REVOLVING only — see Debt.ignoreMinimumPayment in schema.prisma.
  ignoreMinimumPayment: boolean;
  installmentsTotal: number | null;
  installmentsRemaining: number | null;
  // INSTALLMENT only — the matchInstallmentPayments matching anchor (see
  // src/lib/debt-payments.ts). Null for a legacy BNPL debt from before this
  // tracker existed, until the household fills one in here.
  purchaseDate: string | null; // ISO date
  includeInPayoffPlan: boolean;
  paidOffDate: string | null; // ISO date — see nextPaidOffDate, src/lib/debt-payoff.ts
  label: string | null;
  // Itemization from the email receipt for the original purchase, once
  // linked to this plan (Receipt.debtId / linkReceiptToPlan).
  receiptItems: PlanReceiptItem[] | null;
  receiptTotalCents: number | null;
};

// The manual-debt counterpart to SyncedDebtTermsForm — a synced debt's
// terms/balance come from the bank feed and are edited there, but a manual
// debt (never linked to an account) has nowhere else to have its balance
// updated or be deleted. Ported from DebtRow's own edit form (2026-08-16
// account-settings consolidation, same move SyncedDebtTermsForm made for
// linked debts) — /debts now only links to here for editing/deleting any
// debt, synced or manual.
//
// The name field used to have its own tiny form + checkmark submit button,
// separate from the "real" Save button for the rest of the fields —
// redundant, same fix as AccountEditor (see its doc comment): the name
// input is now a plain field inside the SAME `<form>` as the installment
// fields (or, for a REVOLVING debt, the balance + APR/min/due-date terms
// fields) — one submit calls `renameFormAction` plus whichever of
// `installmentFormAction`/(`termsFormAction` + `balanceFormAction`) applies,
// against the same FormData, and there's exactly one visible Save button.
// Balance used to live in its own separate sibling `<form>` below this one;
// merged in (2026-08-18) so the settable fields read top-to-bottom the same
// way a synced debt's read-only summary does (balance, then rate/payment/due
// date) instead of being split across two boxes with two Save buttons — see
// AccountEditor for the synced-side equivalent (no balance field there since
// a synced balance comes from the bank feed, not user input).
type BucketOption = { id: string; name: string };

export function ManualDebtEditor({
  debt,
  nextDueDate,
  dueDateLocked,
  cadence: trackedCadence,
  toleranceCents,
  bucketId: trackedBucketId,
  buckets,
  defaultBucketId,
  categoryId: trackedCategoryId,
  categories,
  linkableAccounts,
  details,
}: {
  debt: ManualDebt;
  nextDueDate: string | null;
  // REVOLVING only — whether nextDueDate is a household-confirmed date vs
  // an app guess (see debt-row.tsx's own "~"-prefixed approximate due date,
  // which this mirrors for the read-only summary line below).
  dueDateLocked: boolean;
  // INSTALLMENT only — the linked DebtPayment's current cadence/tolerance,
  // when a tracker already exists (see settings/accounts/page.tsx).
  cadence: Cadence | null;
  toleranceCents: number | null;
  bucketId: string | null;
  buckets: BucketOption[];
  defaultBucketId: string | null;
  categoryId: string | null;
  categories: CategoryOption[];
  // Every CREDIT_CARD/LOAN synced account — lets a manual card/loan (never
  // linked to a bank feed) convert to a synced one once SimpleFIN actually
  // starts reporting the matching real-world account, without losing this
  // debt's history (label, receipt, payoff-plan membership, DebtPayment
  // tracker) by deleting and re-adding it. `linkedElsewhere` flags an
  // account some other debt already claims (a bank reconnect can leave a
  // household's real, already-configured debt pointed at a stale account
  // while a brand new blank duplicate claims the live one) — linkDebtAccount
  // auto-unlinks the loser, so this just warns before it happens. REVOLVING
  // only — a BNPL plan (INSTALLMENT) has no bank-account counterpart to
  // link to. Household request, 2026-09-14.
  linkableAccounts: { id: string; name: string; linkedElsewhere: boolean }[];
  // The expanded panel (terms tiles / BNPL payment schedule) — built on the
  // server by settings/accounts/page.tsx, which has the payment history.
  details: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const renameWithId = renameDebt.bind(null, debt.id);
  const [renameState, renameFormAction, renamePending] = useActionState(renameWithId, initialRenameState);
  const { justSaved } = useActionToast(renamePending, renameState, { success: "Debt Saved" });
  const [balanceState, balanceFormAction, balancePending] = useActionState(updateDebtBalance, initialBalanceState);
  const updateTermsWithId = updateDebtTerms.bind(null, debt.id);
  const [termsState, termsFormAction, termsPending] = useActionState(updateTermsWithId, initialTermsState);
  const updateInstallmentWithId = updateInstallmentTerms.bind(null, debt.id);
  const [installmentState, installmentFormAction, installmentPending] = useActionState(
    updateInstallmentWithId,
    initialInstallmentState,
  );
  const [payoffPending, startPayoffTransition] = useTransition();
  const [hidePending, startHideTransition] = useTransition();
  const [kindPending, startKindTransition] = useTransition();
  const [linkAccountId, setLinkAccountId] = useState("");
  const [linkPending, startLinkTransition] = useTransition();
  const [cadence, setCadence] = useState<Cadence>(trackedCadence ?? "BIWEEKLY");
  const [dueDay, setDueDay] = useState(nextDueDate ? String(dayOfMonthUTC(nextDueDate)) : "");
  // Set imperatively (not React state) right before an ambiguous submit
  // actually goes through — see the form's onSubmit — so the same click
  // that resolves the confirm() dialog also carries the answer, instead of
  // needing a second click after a state-driven re-render.
  const dueDateConfirmedRef = useRef<HTMLInputElement>(null);
  // Re-seed whenever the tracked due date itself changes — this component
  // stays mounted across a save (key={d.id} on the list above never
  // changes), so its useState initializer only ever ran once, at first
  // mount. Without this, a tracker that gets attached/advanced by a
  // background sync while this settings tab stays open left dueDay stuck at
  // its original (often blank) value forever, and every later Save silently
  // resubmitted that stale value — real household report, 2026-08-21: this
  // is how a debt's tracked minimum payment/due date drifted out of sync
  // with the plain-English "Min $/mo" field with no way to notice or fix it
  // short of a hard page reload. setState during render (not an effect) —
  // React's own recommended pattern for "reset state when a prop changes":
  // compare against the last-seen prop value and adjust in the same render
  // pass, so there's no extra render/flash of the stale value.
  const [prevNextDueDate, setPrevNextDueDate] = useState(nextDueDate);
  if (nextDueDate !== prevNextDueDate) {
    setPrevNextDueDate(nextDueDate);
    setDueDay(nextDueDate ? String(dayOfMonthUTC(nextDueDate)) : "");
  }
  const [bucketId, setBucketId] = useState(trackedBucketId ?? defaultBucketId ?? buckets[0]?.id ?? "");
  const [ignoreMinimum, setIgnoreMinimum] = useState(debt.ignoreMinimumPayment);
  const isInstallment = debt.debtType === "INSTALLMENT";
  const paidOff = debt.balanceCents === 0;
  // Receipt itemization for the original BNPL purchase — toggled from a
  // receipt icon up here in the title bar (next to the type/plan icons),
  // same affordance DebtRow uses on /debts and a /transactions row uses for
  // its own receipt (household request, 2026-09-01: keep it in sync).
  const [receiptOpen, setReceiptOpen] = useState(false);
  const hasReceipt = (debt.receiptItems?.length ?? 0) > 0;
  // "Payment 3 of 12" — mirrors debt-row.tsx's currentPayment derivation,
  // except checked for null rather than truthy: a fully paid-off debt has
  // installmentsRemaining === 0, which is a legit value but falsy, and the
  // progress bar needs to render (at 100%) for exactly that case now that
  // it's shown for paid-off debts too.
  const currentPayment =
    isInstallment && debt.installmentsTotal != null && debt.installmentsRemaining != null
      ? debt.installmentsTotal - debt.installmentsRemaining + 1
      : null;

  // Icon-only Payoff-Plan toggle, shared by both the installment and
  // revolving layouts (household layout request, 2026-09-08) — mirrors the
  // Target classification badge up by the debt name, fires its own action
  // on tap (not part of the form submit), same as before.
  const payoffToggle = (
    <button
      type="button"
      disabled={payoffPending}
      aria-pressed={debt.includeInPayoffPlan}
      onClick={() => startPayoffTransition(() => toasted(() => setDebtIncludedInPayoffPlan(debt.id, !debt.includeInPayoffPlan), debt.includeInPayoffPlan ? "Removed from Payoff Plan" : "Added to Payoff Plan"))}
      aria-label="Include in Payoff Plan"
      title="Payoff Plan"
      className={`inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${
        debt.includeInPayoffPlan
          ? "border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-950/40 dark:text-emerald-400"
          : "border-neutral-300 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
      }`}
    >
      <Target size={15} />
    </button>
  );

  return (
    <li
      className={`rounded-lg border px-3 py-2 text-sm ${
        paidOff
          ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20"
          : "border-blue-100 dark:border-neutral-800"
      }`}
    >
      <form
        action={(formData) => {
          renameFormAction(formData);
          if (isInstallment) installmentFormAction(formData);
          else {
            termsFormAction(formData);
            balanceFormAction(formData);
          }
          setEditing(false);
        }}
        onSubmit={(e) => {
          // A plain day-of-month is ambiguous exactly when it's genuinely
          // changing to a day that's already gone by this month: is the
          // household correcting *this* cycle's due date (now overdue), or
          // stating a real change that's not due until next month? Same
          // gate this app already uses for a "notable but not forbidden"
          // edit (the loan-balance check just below) rather than a full
          // date picker (household decision, 2026-09-06) — asks only on an
          // actual change, not every resave of an already-settled date, and
          // updateDebtTerms's own fallback (debts/actions.ts) still resolves
          // it sanely if this somehow doesn't fire.
          if (!isInstallment && dueDay) {
            const day = Number(dueDay);
            const originalDay = nextDueDate ? dayOfMonthUTC(nextDueDate) : null;
            if (Number.isInteger(day) && day >= 1 && day <= 31 && day !== originalDay) {
              const rollForward = nextOccurrenceOfDay(day);
              const thisMonth = currentMonthOccurrenceOfDay(day);
              if (rollForward.getTime() !== thisMonth.getTime()) {
                const useThisMonth = confirm(
                  `The ${ordinal(day)} has already passed this month.\n\n` +
                    `Click OK to use ${formatDate(thisMonth, { month: "short", day: "numeric" })} for the current, already-due cycle.\n` +
                    `Click Cancel to use ${formatDate(rollForward, { month: "short", day: "numeric" })} instead (skips this cycle).`,
                );
                if (dueDateConfirmedRef.current) dueDateConfirmedRef.current.value = useThisMonth ? "this" : "next";
              }
            }
          }
          // Loans shouldn't casually regain balance the way a card can — no
          // server-side block, just a confirm gate (this app's usual style
          // for notable-but-not-forbidden edits).
          if (isInstallment || debt.kind !== "LOAN") return;
          const raw = new FormData(e.currentTarget).get("balance");
          const newCents = typeof raw === "string" ? parseDollarsToCents(raw) : null;
          if (
            newCents !== null &&
            newCents > debt.balanceCents &&
            !confirm(
              `This loan's balance is going up (${formatCents(debt.balanceCents)} → ${formatCents(newCents)}). Continue?`,
            )
          ) {
            e.preventDefault();
          }
        }}
      >
      <input type="hidden" name="debtId" value={debt.id} />
      <input type="hidden" name="dueDateConfirmed" ref={dueDateConfirmedRef} />
      {/* flex-wrap only while editing, name input + cancel/X (order-2) on
          line one, every other badge/icon pushed to a wrapped line two
          (order-3) — 2026-08-26 household request. A flex-basis:0 flex-1
          item (the input) doesn't actually force a wrap on its own —
          flex-wrap only breaks a line once its items' *hypothetical* sizes
          (basis, not however much flex-grow later hands them) exceed the
          container, and a zero-basis input plus a handful of small icons
          always measures well under that, so everything still fit on one
          crowded row with the input just getting whatever was left over.
          The zero-height, 100%-basis spacer right after the cancel button
          is what actually forces the break: a full-width flex item can
          never share a line with anything, so nothing order-3-or-later can
          land next to it, and h-0 keeps that break invisible instead of
          leaving a blank line. Not editing, no order overrides apply and
          the spacer doesn't render, so everything just sits in plain DOM
          order on one line, same as always. */}
      <p
        className={`flex items-center gap-x-1.5 gap-y-0.5 leading-tight font-medium text-neutral-900 dark:text-neutral-100 ${editing ? "flex-wrap" : "min-w-0"}`}
      >
        {editing ? (
          <input
            name="name"
            defaultValue={debt.name}
            required
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-1.5 py-0.5 text-sm font-medium focus:border-blue-900 focus:outline-none"
          />
        ) : (
          <span className="min-w-0 truncate">{debt.name}</span>
        )}
        {/* Forces the line break (see the comment above this <p>) —
            positioned here in the DOM, ahead of every order-3 item below,
            purely so the source-order tiebreak within that shared order
            tier puts it first; `order` alone is what actually decides its
            VISUAL position (after the input and the order-2 cancel
            button), not this DOM placement. */}
        {editing && <span className="order-3 h-0 basis-full" aria-hidden="true" />}
        <span
          role="img"
          aria-label="Tracked as a Debt"
          title="Tracked as a Debt"
          className={`shrink-0 text-red-700 dark:text-red-400 ${editing ? "order-3" : ""}`}
        >
          <CreditCard size={12} />
        </span>
        {!paidOff && debt.includeInPayoffPlan && (
          <span
            role="img"
            aria-label="Included in the Debt Payoff Plan"
            title="Included in the Debt Payoff Plan"
            className={`shrink-0 text-emerald-600 dark:text-emerald-400 ${editing ? "order-3" : ""}`}
          >
            <Target size={12} />
          </span>
        )}
        {hasReceipt && (
          <button
            type="button"
            onClick={() => setReceiptOpen((v) => !v)}
            aria-expanded={receiptOpen}
            aria-label={receiptOpen ? "Hide Receipt" : "View Receipt"}
            title={receiptOpen ? "Hide Receipt" : "View Receipt"}
            className={`shrink-0 text-emerald-700 dark:text-emerald-400 ${editing ? "order-3" : ""}`}
          >
            <Receipt size={12} />
          </button>
        )}
        {/* Right after the type icon(s), inline-editable on its own (2026-08-26
            — pulled out of the Save form below, same click-to-edit UX as a
            transaction's own label). */}
        <DebtLabelEditor debtId={debt.id} label={debt.label} className={editing ? "order-3" : ""} />
        {/* Right-aligned while not editing (Edit paired with Hide, far
            right, via DOM order + ml-auto). Reordered (via CSS `order`,
            DOM position unchanged) right after the name while editing, so
            it reads as the input row's own cancel button — `order` alone
            handles this; physically moving the button in the JSX would
            have broken the ml-auto-driven not-editing layout instead, since
            that depends on DOM position when no order override applies. */}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-label={editing ? "Cancel Editing Debt" : "Edit Debt"}
          title={editing ? "Cancel" : "Edit"}
          className={`shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 ${editing ? "order-2" : "ml-auto"}`}
        >
          {editing ? <X size={14} /> : <Pencil size={14} />}
        </button>
        {/* Hides regardless of paid-off status (2026-08-21) — a still-owed
            debt the household wants gone from view no longer needs an
            immediate, permanent delete of its own; that happens from the
            Hidden Accounts & Debts page (/settings/hidden) instead —
            immediately for a manual debt like this, via deleteHiddenItem. A
            paid-off CARD/LOAN self-heals back into view the moment it
            regains a balance (unhideDebtPaymentIfBalanceReturned,
            src/lib/debt-payments.ts); a paid-off BNPL plan never will — a
            new purchase creates a brand new Debt row — so it just sits
            hidden until deleted, same as a still-owed debt hidden manually. Hidden entirely while editing
            (2026-08-26) — the edit panel already has its own close-out via
            the cancel/X button, so a second, unrelated action sitting next
            to the reflowed icon/label row while editing was just noise. */}
        {!editing && (
          <button
            type="button"
            onClick={() => {
              // Always confirm()-gated (2026-09-23) — this used to skip the
              // dialog once paid off, on the theory that no balance was at
              // risk, but hiding still drops it out of the payoff-plan
              // simulation and every list on this page, so a misclick on a
              // dense settings row deserved the same guard either way.
              const message = paidOff
                ? `Remove "${debt.name}" from view? This only hides the card, nothing is deleted — it can be permanently removed later from the cleanup section once hidden a year.`
                : `Remove "${debt.name}" from view? It still has a balance — this only hides the card, nothing is deleted. It can be permanently removed later from the cleanup section once hidden a year.`;
              if (confirm(message)) startHideTransition(() => toasted(() => hideDebt(debt.id), "Debt Hidden"));
            }}
            disabled={hidePending}
            aria-label="Remove from View"
            title="Remove from View"
            className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
          >
            <EyeOff size={13} />
          </button>
        )}
      </p>
      {renameState.error && <p className="text-xs text-red-600 dark:text-red-400">{renameState.error}</p>}

      {editing && (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-blue-100 dark:border-neutral-800 p-3">
          {isInstallment ? (
            <>
              {/* Fixed field order (household layout request, 2026-09-08):
                  Amount·APR·Payoff / Next Payment·Cadence / Purchase Date·
                  First Payment / Bucket·Category / Tolerance. */}
              <div className="flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Amount
                  <MoneyInput
                    name="paymentAmount"
                    defaultCents={debt.minPaymentCents}
                    placeholder="Payment $"
                    className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                  />
                </label>
                <label className="flex w-20 shrink-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  APR
                  <PercentInput
                    name="apr"
                    defaultPercent={debt.aprBasisPoints / 100}
                    placeholder="APR %"
                    className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                  />
                </label>
                {payoffToggle}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  {/* "Next Payment," not "Current" — the number entered here
                      is the payment that's still due (household feedback,
                      2026-09-12): installmentsRemainingFrom (debts/actions.ts)
                      computes totalPayments - currentPayment + 1, so 4/4
                      means one payment (the 4th) still remains, not that all
                      4 are already made. Internal field/variable name
                      (currentPayment, here and in InstallmentProgressBar/
                      debt-row.tsx/debt-payment-card.tsx) is unchanged — only
                      this visible label, which is what read backwards. */}
                  Next Payment
                  <div className="mt-1 flex items-center rounded-lg border border-neutral-300 dark:border-neutral-700 focus-within:border-blue-900">
                    <input
                      name="currentPayment"
                      type="number"
                      min={1}
                      defaultValue={currentPayment ?? 1}
                      aria-label="Next Payment Number"
                      className="w-full min-w-0 bg-transparent px-2 py-2 text-center text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none"
                    />
                    <span className="shrink-0 text-sm text-neutral-400 dark:text-neutral-500">/</span>
                    <input
                      name="totalPayments"
                      type="number"
                      min={1}
                      defaultValue={debt.installmentsTotal ?? 1}
                      aria-label="Total Payments"
                      className="w-full min-w-0 bg-transparent px-2 py-2 text-center text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none"
                    />
                  </div>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Cadence
                  <SelectField
                    name="cadence"
                    value={cadence}
                    onChange={(v) => setCadence(v as Cadence)}
                    searchable={false}
                    options={CADENCE_OPTIONS}
                    className="mt-1"
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Purchase Date
                  <input
                    name="purchaseDate"
                    type="date"
                    defaultValue={debt.purchaseDate ?? undefined}
                    className="mt-1 block h-[38px] w-full min-w-0 appearance-none rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  <span title="When it isn't the purchase date — only moves the plan while no payment has matched yet">
                    First Payment
                  </span>
                  <input
                    name="firstPaymentDate"
                    type="date"
                    defaultValue={nextDueDate ?? undefined}
                    className="mt-1 block h-[38px] w-full min-w-0 appearance-none rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                  />
                </label>
              </div>
              <BucketCategoryFields
                buckets={buckets}
                bucketId={bucketId}
                onBucketChange={setBucketId}
                categories={categories}
                defaultCategoryId={trackedCategoryId}
              />
              <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                Amount Tolerance (how much a payment can vary and still auto-match)
                <MoneyInput
                  name="tolerance"
                  defaultCents={toleranceCents ?? 10}
                  className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
              </label>
              {installmentState.error && <p className="text-xs text-red-600 dark:text-red-400">{installmentState.error}</p>}
            </>
          ) : (
            <>
              {/* Fixed field order (household layout request, 2026-09-08):
                  Card/Loan · Payoff · Balance / APR · Minimum · Due Date /
                  no-minimum opt-out / Bucket · Category. */}
              <div className="flex items-center gap-2">
                <div className="flex h-[38px] w-fit shrink-0 items-center gap-1 rounded-lg border border-neutral-300 dark:border-neutral-700 p-0.5 text-xs">
                  {(["CARD", "LOAN"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      disabled={kindPending}
                      onClick={() => startKindTransition(() => toasted(() => updateDebtKind(debt.id, k), "Type Saved"))}
                      className={`flex h-full items-center rounded-md px-2 font-medium disabled:opacity-50 ${
                        debt.kind === k
                          ? "bg-blue-900 dark:bg-blue-700 text-white"
                          : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {k === "CARD" ? "Card" : "Loan"}
                    </button>
                  ))}
                </div>
                {payoffToggle}
                <MoneyInput
                  name="balance"
                  defaultCents={debt.balanceCents}
                  placeholder="Balance $"
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  APR
                  <PercentInput
                    name="apr"
                    defaultPercent={debt.aprBasisPoints / 100}
                    placeholder="APR %"
                    className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Minimum
                  <MoneyInput
                    name="minPayment"
                    defaultCents={debt.minPaymentCents}
                    placeholder="Min $/mo"
                    disabled={ignoreMinimum}
                    className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none disabled:opacity-50"
                  />
                </label>
                <DayOfMonthPicker
                  name="dueDay"
                  value={dueDay}
                  onChange={setDueDay}
                  label="Due Date"
                  unconfirmed={!dueDateLocked}
                />
              </div>
              <label className="inline-flex w-fit items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                <input
                  type="checkbox"
                  name="ignoreMinimum"
                  checked={ignoreMinimum}
                  onChange={(e) => setIgnoreMinimum(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-neutral-300 dark:border-neutral-700"
                />
                No real minimum — don&apos;t track one
              </label>
              <BucketCategoryFields
                buckets={buckets}
                bucketId={bucketId}
                onBucketChange={setBucketId}
                categories={categories}
                defaultCategoryId={trackedCategoryId}
              />
              {/* Convert this manual debt to a synced one, once SimpleFIN
                  actually has a matching account for it — reuses the same
                  linkDebtAccount action the auto-suggestion banner and a
                  synced debt's own "Linked Account" control (above) use.
                  Only shown when there's actually a real candidate. A
                  `linkedElsewhere` option means some other debt already
                  claims that account (see linkableAccounts' own comment) —
                  confirmed before linking, since it un-links that other
                  debt as a side effect. */}
              {linkableAccounts.length > 0 && (
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Link to a Connected Account
                  <div className="mt-1 flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <SelectField
                        name="linkAccountId"
                        value={linkAccountId}
                        onChange={setLinkAccountId}
                        options={[
                          { value: "", label: "Not Linked" },
                          ...linkableAccounts.map((a) => ({ value: a.id, label: a.linkedElsewhere ? `${a.name} — Linked to Another Debt` : a.name })),
                        ]}
                      />
                    </span>
                    <button
                      type="button"
                      disabled={linkPending || !linkAccountId}
                      onClick={() => {
                        const target = linkableAccounts.find((a) => a.id === linkAccountId);
                        if (
                          target?.linkedElsewhere &&
                          !confirm(
                            `"${target.name}" is already linked to another debt. Linking it here will unlink it from there instead (that debt becomes manual, nothing is deleted). Continue?`,
                          )
                        )
                          return;
                        startLinkTransition(() => toasted(() => linkDebtAccount(debt.id, linkAccountId), "Account Linked"));
                      }}
                      className="shrink-0 rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {linkPending ? "…" : "Link"}
                    </button>
                  </div>
                </label>
              )}
              {termsState.error && <p className="text-xs text-red-600 dark:text-red-400">{termsState.error}</p>}
              {balanceState.error && <p className="text-xs text-red-600 dark:text-red-400">{balanceState.error}</p>}
            </>
          )}
          <InlineSaveButton
            pending={renamePending || (isInstallment ? installmentPending : termsPending || balancePending)}
            justSaved={justSaved}
            disabled={buckets.length > 0 && !bucketId}
          />
        </div>
      )}

      <ExpandableSummary
        storageKey={debt.id}
        summary={
          paidOff ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <PartyPopper size={13} /> Paid Off
              {debt.paidOffDate && ` ${formatDate(new Date(debt.paidOffDate), { month: "short", day: "numeric", year: "numeric" })}`}
            </span>
          ) : (
            <span className="block text-xs text-gray-500 dark:text-neutral-400">
              {formatBasisPoints(debt.aprBasisPoints)} APR ·{" "}
              {!isInstallment && debt.ignoreMinimumPayment
                ? "No Minimum"
                : isInstallment
                  ? `${formatCents(debt.minPaymentCents)}/payment`
                  : `${formatCents(debt.minPaymentCents)}/mo`}
              {isInstallment && debt.installmentsTotal
                ? ` · ${debt.installmentsTotal} payment${debt.installmentsTotal === 1 ? "" : "s"}`
                : ""}
              {/* REVOLVING only — matches debt-row.tsx's own "· due on the
                  Nth" fragment (the "~" + tooltip for an unconfirmed date is
                  the same convention too) so a manual card/loan's due day is
                  visible right here instead of only on /debts. */}
              {!isInstallment && nextDueDate && (
                <span title={dueDateLocked ? undefined : "Approximate — Not Yet Confirmed"}>
                  {` · due on the ${dueDateLocked ? "" : "~"}${ordinal(dayOfMonthUTC(nextDueDate))}`}
                </span>
              )}
            </span>
          )
        }
        balance={
          <span className={`font-medium ${paidOff ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {paidOff ? formatCents(0) : `-${formatCents(debt.balanceCents)}`}
          </span>
        }
        footer={
          isInstallment &&
          currentPayment &&
          debt.installmentsTotal && (
            // Its own full-width row (2026-08-26 — used to share the row with
            // the balance amount above via flex-1, which left it stopping
            // short of the card's true right edge instead of running the full
            // width like everything else in the card).
            <InstallmentProgressBar className="mt-1.5" currentPayment={currentPayment} total={debt.installmentsTotal} />
          )
        }
      >
        {details}
      </ExpandableSummary>
      </form>
      <PlanReceiptSection
        items={debt.receiptItems}
        totalCents={debt.receiptTotalCents}
        className="mt-2"
        controlledOpen={receiptOpen}
      />
    </li>
  );
}
