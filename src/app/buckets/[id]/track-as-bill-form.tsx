"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Info, X } from "lucide-react";
import {
  createBillFromTransaction,
  createBillCategory,
  suggestBillCategory,
  attachExtraBillCharge,
  linkTransactionToExistingBill,
} from "@/app/bills/actions";
import { createDebtPaymentFromTransaction } from "@/app/debts/actions";
import { createIncomeFromTransaction } from "@/app/income/actions";
import { SemiMonthlyDaysFields } from "@/app/income/semi-monthly-days-fields";
import { showToast } from "@/lib/toast";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";
import { AddDebtModal } from "./add-debt-modal";
import { SelectField } from "@/components/select-field";
import { MoneyInput } from "@/components/money-input";
import { DayOfMonthPicker } from "@/components/day-of-month-picker";
import { CADENCE_OPTIONS } from "@/lib/cadence-label";

// Mirrors amountToleranceCents in src/lib/recurring-bills.ts — not imported
// directly since that module also imports the Prisma client (server-only)
// and this is a "use client" component; just a prefill default anyway, the
// server re-derives/validates its own tolerance independently on submit.
function defaultToleranceCents(amountCents: number): number {
  return Math.max(Math.round(amountCents * 0.3), 500);
}

type Mode = "bill" | "debt" | "income";
const DEBT_KIND_GROUP_LABEL: Record<"CARD" | "LOAN", string> = {
  CARD: "Card Payment",
  LOAN: "Loan Payment",
};
// Same three cadences Income supports (PaycheckCadence) — see AddIncomeForm.
const INCOME_CADENCE_OPTIONS = [
  { value: "BIWEEKLY", label: "Biweekly (26/Yr)" },
  { value: "SEMI_MONTHLY", label: "Semi-Monthly (24/Yr)" },
  { value: "MONTHLY", label: "Monthly" },
];

// The general-purpose counterpart to accepting an auto-detected bill/income
// suggestion — works on any transaction, bucketed or not, tracked or not,
// matched or not, since the household supplies amount/tolerance/cadence
// themselves instead of the detector having to infer a pattern first.
// Dispatches to one of three concepts depending on the picker:
// createBillFromTransaction (a real bill — subscription/utility/rent) for
// "+ Add a new bill/subscription" — an existing RecurringBill is usually
// already auto-claimed by matchBillPayments before a transaction ever
// reaches here on amount, so it's never offered as a second full
// bill-creation target. It's instead offered two other ways, both via
// `existingBills`: "This Is A Payment For" (linkTransactionToExistingBill)
// for the case matchBillPayments' own name-similarity matcher missed — a
// real cycle payment sitting right here that a garbled bank descriptor kept
// it from claiming automatically (2026-09-22) — or "Attach As An Extra
// Charge On" (attachExtraBillCharge, src/app/bills/actions.ts) for the
// leftover leg of a bill's own payment that will never match on amount (a
// bank fee posted as its own transaction alongside the real charge; real
// case, Cedar Creek Irrigation Debits Web's $2 online-payment fee riding next to
// its $35 bill, 2026-09-04) and has no other legal way into that bill's
// RECURRING bucket (see Bucket.trackingMode). createDebtPaymentFromTransaction
// (a card/loan's tracked recurring payment) for an existing debt — the
// `debts` prop is pre-filtered upstream (src/app/transactions/page.tsx) to
// exclude BNPL (always auto-tracked at creation, never a valid pick here)
// and any debt that already has a DebtPayment tracker, so everything listed
// is a genuine "not tracked yet" target — or createIncomeFromTransaction
// ("Recurring income") for a paycheck/credit the built-in detector never
// caught. "+ Add a new loan/card" opens AddDebtModal, which creates the new
// Debt via the exact same createDebt action Settings' AddDebtForm uses
// (household feedback 2026-08-20: the old inline stub — name+kind only,
// balance/APR/min all zero — didn't match what Settings actually asks for)
// and auto-selects it back into the picker below.
//
// Direction-gated: a debit (isDebit, money out) can only ever be a bill or a
// debt payment, never income — the reverse for a credit. No default mode
// either way for a debit — `mode` starts null and the submit button below
// stays disabled until a real type is chosen, since an always-preselected
// "bill" mode read as though no choice had been made at all. A credit has
// exactly one valid mode (income), so there's nothing to choose — no picker
// renders, mode is fixed from the start.
export function TrackAsBillForm({
  transactionId,
  defaultName,
  defaultAmountCents,
  categories,
  debts,
  existingBills = [],
  buckets,
  allowBill = true,
  forceBillMode = false,
  onDone,
  onCancel,
}: {
  transactionId: string;
  defaultName: string;
  defaultAmountCents: number;
  categories: CategoryOption[];
  debts: { id: string; name: string; kind: "CARD" | "LOAN" }[];
  // Existing RecurringBills this transaction could belong to — offered two
  // ways below: "This Is A Payment For" (linkTransactionToExistingBill,
  // bills/actions.ts) when it's the cycle's real charge that matchBillPayments'
  // automatic matcher simply missed (a bank-garbled merchant descriptor,
  // 2026-09-22), or "Attach As An Extra Charge On" (attachExtraBillCharge) for
  // an ancillary fee riding alongside an already-matched charge — see each
  // action's own doc comment. Shown even when forceBillMode is set (the
  // "Needs a bucket" queue is exactly where a missed match like this turns
  // up). Not the same list as "+ Add a new bill/subscription": picking one
  // of these never creates anything, it just links this transaction to that
  // bill.
  existingBills?: { id: string; name: string }[];
  // Only needed from a view with no bucket already implied by the page
  // (/transactions, the "Needs a bucket" queue) — createBillFromTransaction
  // otherwise just reuses the transaction's existing bucketId, same as
  // before this prop existed, and the picker below stays hidden. A
  // RecurringBill with nowhere to live would never appear anywhere (every
  // bucket page only ever queries its own bills), hence the picker.
  buckets?: { id: string; name: string }[];
  // False for a transaction whose account isn't budget-tracked (see
  // Account.budgetTracked) — a bill/subscription always carries a bucketId,
  // which such an account's spend must never get (see WORKING_ON.md), so
  // the "+ Add a new bill/subscription" option and bucket/category pickers
  // stay hidden entirely rather than letting the picker offer a mode that
  // would fail server-side anyway. Debt-payment and recurring-income
  // tracking are unaffected — a card's own payoff/credit activity is
  // exactly what budgetTracked is about, not a reason to exclude it.
  allowBill?: boolean;
  // Skips the debt/income options in the "What kind of payment is this?"
  // chooser — for a caller that already knows the target is a bill (e.g.
  // the "Needs a bucket" queue's Recurring tab, where the household already
  // picked a RECURRING/MIXED bucket, so offering "track as a debt payment"
  // instead would be a non-sequitur). Debt/income tracking stays reachable
  // elsewhere (this same form, unforced, on /transactions). The chooser
  // itself still renders when `existingBills` is non-empty even here (see
  // the render condition below) — "This Is A Payment For"/"Attach As An
  // Extra Charge On" are just as relevant from this queue as anywhere else,
  // arguably more so: it's exactly where a real payment matchBillPayments'
  // automatic matcher missed turns up (2026-09-22).
  forceBillMode?: boolean;
  // Called only after a real create succeeds — callers use this to flip
  // their own "tracked" flag. Deliberately a separate prop from onCancel
  // below (2026-08-19 fix: the bottom Cancel button used to call this same
  // onDone, which made callers mark the transaction as tracked even though
  // nothing was created — the "track as recurring" icon then stayed hidden
  // until a full page reload, since the local `tracked` state never gets
  // corrected back from the server).
  onDone: () => void;
  // Called when the household backs out without submitting — defaults to
  // onDone for any caller that genuinely doesn't distinguish the two (there
  // are none left in this codebase, but callers aren't required to pass it).
  onCancel?: () => void;
}) {
  // Positive = money out (a bill/debt payment can only be a debit); negative
  // = money in (income can only be a credit) — same signed convention used
  // everywhere else (see WORKING_ON.md).
  const isDebit = defaultAmountCents > 0;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(isDebit ? (forceBillMode ? "bill" : null) : "income");
  const [cadence, setCadence] = useState(isDebit ? "MONTHLY" : "BIWEEKLY");
  const [dueDay, setDueDay] = useState("");
  const [bucketSelection, setBucketSelection] = useState(buckets?.[0]?.id ?? "");
  const [debtList, setDebtList] = useState(debts);
  const [debtSelection, setDebtSelection] = useState("");
  const [addDebtModalOpen, setAddDebtModalOpen] = useState(false);
  const [categoryList, setCategoryList] = useState(categories);
  const [aiCategoryId, setAiCategoryId] = useState<string | null>(null);
  const [aiNewCategoryName, setAiNewCategoryName] = useState<string | null>(null);
  const [aiCategoryError, setAiCategoryError] = useState<string | null>(null);
  const [aiSuggestPending, startAiSuggest] = useTransition();
  const [creatingCategoryPending, startCreatingCategory] = useTransition();
  const [attachPending, startAttachTransition] = useTransition();
  const isDebtMode = mode === "debt";
  const isIncomeMode = mode === "income";
  // Gates the submit button — see the direction-gating doc comment above.
  const canSubmit = !isDebit ? true : mode === "bill" ? true : mode === "debt" ? Boolean(debtSelection) : false;

  function handleSuggestCategory() {
    setAiCategoryError(null);
    startAiSuggest(async () => {
      const result = await suggestBillCategory(defaultName, bucketSelection || null);
      if (result.error) {
        setAiCategoryError(result.error);
        return;
      }
      if (result.categoryId) {
        setAiCategoryId(result.categoryId);
        setAiNewCategoryName(null);
      } else if (result.newCategoryName) {
        setAiNewCategoryName(result.newCategoryName);
        setAiCategoryId(null);
      }
    });
  }

  // Runs once, automatically, the moment "+ Add a new bill/subscription" is
  // picked — no button (household feedback 2026-08-20: a manual "Suggest"
  // click was unwanted). Guarded by the ref so re-toggling away from and
  // back to bill mode doesn't re-spend an AI call every time.
  const suggestedOnceRef = useRef(false);
  useEffect(() => {
    if (mode === "bill" && !suggestedOnceRef.current) {
      suggestedOnceRef.current = true;
      handleSuggestCategory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function handleUseSuggestedCategory() {
    if (!aiNewCategoryName || !bucketSelection) return;
    startCreatingCategory(async () => {
      const result = await createBillCategory(bucketSelection, aiNewCategoryName);
      if (result.error) {
        setAiCategoryError(result.error);
        return;
      }
      if (result.category) {
        const created = result.category;
        setCategoryList((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        setAiCategoryId(created.id);
        setAiNewCategoryName(null);
      }
    });
  }

  function selectMode(v: string) {
    if (v === "__add__") {
      setAddDebtModalOpen(true);
      return;
    }
    if (v === "__bill__") {
      setMode("bill");
      setDebtSelection("");
      // Cadence deliberately NOT reset here — its picker sits above this
      // one, so a household that picks "Yearly" first and the payment kind
      // second would otherwise have it silently snapped back to Monthly
      // (household report 2026-09-30: an annual Usenet subscription saved
      // as Monthly).
      return;
    }
    if (v.startsWith("__linkBill__:")) {
      const billId = v.slice("__linkBill__:".length);
      setError(null);
      startAttachTransition(async () => {
        const result = await linkTransactionToExistingBill(transactionId, billId);
        if (result.error) {
          setError(result.error);
          return;
        }
        onDone();
        showToast("Linked to Existing Bill");
      });
      return;
    }
    if (v.startsWith("__attachBill__:")) {
      const billId = v.slice("__attachBill__:".length);
      setError(null);
      startAttachTransition(async () => {
        const result = await attachExtraBillCharge(transactionId, billId);
        if (result.error) {
          setError(result.error);
          return;
        }
        onDone();
        showToast("Attached as Extra Charge");
      });
      return;
    }
    setMode("debt");
    setDebtSelection(v);
  }

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = isIncomeMode
        ? await createIncomeFromTransaction(transactionId, {}, formData)
        : isDebtMode
          ? await createDebtPaymentFromTransaction(transactionId, {}, formData)
          : await createBillFromTransaction(transactionId, {}, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      onDone();
      showToast(isIncomeMode ? "Now Tracking Income" : isDebtMode ? "Now Tracking Debt Payment" : "Now Tracking as Bill");
    });
  }

  return (
    <>
    <form action={handleSubmit} className="mt-2 flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
      {!isDebtMode && (
        <input
          name="name"
          defaultValue={defaultName}
          required
          placeholder={isIncomeMode ? "e.g. Alex's paycheck" : "Bill name"}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
        />
      )}
      <div className="flex gap-2">
        <MoneyInput
          name="amount"
          defaultCents={defaultAmountCents}
          required
          className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
        />
        <SelectField
          name="cadence"
          value={cadence}
          onChange={setCadence}
          small
          searchable={false}
          options={isIncomeMode ? INCOME_CADENCE_OPTIONS : CADENCE_OPTIONS}
          className="flex-1"
        />
      </div>
      {isDebit && (!forceBillMode || (allowBill && existingBills.length > 0)) && (
        <SelectField
          value={isDebtMode ? debtSelection : mode === "bill" ? "__bill__" : ""}
          onChange={selectMode}
          small
          searchable={false}
          disabled={attachPending}
          placeholder={attachPending ? "Attaching…" : "What kind of payment is this?"}
          options={[
            ...(allowBill ? [{ value: "__bill__", label: "+ Add a New Bill/Subscription" }] : []),
            ...(allowBill
              ? existingBills.map((b) => ({
                  value: `__linkBill__:${b.id}`,
                  label: b.name,
                  group: "This Is A Payment For",
                }))
              : []),
            ...(allowBill
              ? existingBills.map((b) => ({
                  value: `__attachBill__:${b.id}`,
                  label: b.name,
                  group: "Attach As An Extra Charge On",
                }))
              : []),
            ...(!forceBillMode
              ? [
                  ...debtList.map((d) => ({ value: d.id, label: d.name, group: DEBT_KIND_GROUP_LABEL[d.kind] })),
                  { value: "__add__", label: "+ Add a New Loan/Card" },
                ]
              : []),
          ]}
        />
      )}
      {isDebtMode && <input type="hidden" name="debtId" value={debtSelection} />}

      {isDebtMode && (
        <div className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
          {cadence === "MONTHLY" ? (
            <DayOfMonthPicker
              name="dueDay"
              value={dueDay}
              onChange={setDueDay}
              label="Due Date (optional — confirms it right away instead of approximating from this transaction)"
              small
            />
          ) : (
            <label className="flex flex-col gap-1">
              Due Date (optional — confirms it right away instead of approximating from this transaction)
              <input
                name="nextDueDate"
                type="date"
                className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
              />
            </label>
          )}
        </div>
      )}

      {isIncomeMode && (
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
          Most Recent (or Next) Pay Date — used to project which months get a 3rd biweekly paycheck
          <input
            name="nextPayDate"
            type="date"
            className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
          />
        </label>
      )}
      {isIncomeMode && cadence === "SEMI_MONTHLY" && <SemiMonthlyDaysFields small />}

      {mode === "bill" && buckets && buckets.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
          Bucket
          <SelectField
            name="bucketId"
            value={bucketSelection}
            onChange={setBucketSelection}
            small
            options={buckets.map((b) => ({ value: b.id, label: b.name }))}
          />
        </label>
      )}

      {mode === "bill" && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-neutral-400">Category</span>
            {aiSuggestPending && <span className="text-xs text-gray-400 dark:text-neutral-500">Suggesting…</span>}
          </div>
          <CategoryPicker
            key={`${bucketSelection}-${aiCategoryId ?? "cp"}`}
            categories={categoryList.filter((c) => c.bucketId === bucketSelection)}
            defaultCategoryId={aiCategoryId ?? categoryList.find((c) => c.bucketId === bucketSelection)?.id ?? null}
            bucketId={bucketSelection || null}
            name="categoryId"
            small
          />
          {aiNewCategoryName && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-100 dark:border-neutral-800 px-2 py-1.5 text-xs">
              <span className="truncate text-neutral-600 dark:text-neutral-400">
                AI suggests a new category:{" "}
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{aiNewCategoryName}</span>
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handleUseSuggestedCategory}
                  disabled={creatingCategoryPending}
                  className="font-medium text-blue-900 dark:text-blue-300 disabled:opacity-50"
                >
                  {creatingCategoryPending ? "Adding…" : "Add"}
                </button>
                <button
                  type="button"
                  onClick={() => setAiNewCategoryName(null)}
                  aria-label="Dismiss Suggestion"
                  className="text-neutral-400 dark:text-neutral-500"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          )}
          {aiCategoryError && <p className="text-xs text-red-600 dark:text-red-400">{aiCategoryError}</p>}
        </div>
      )}

      {/* Tolerance last — the rarely-touched "how much can a payment vary"
          override, kept in the same order as bill-row.tsx's edit form
          (household layout request, 2026-09-08). */}
      {!isIncomeMode && (
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
          <span className="flex items-center gap-1">
            Tolerance
            <span
              title="How much the actual payment can vary from this amount and still count as a match — e.g. a $50 tolerance on a $200 bill matches anything from $150-$250."
              className="flex items-center text-neutral-400 dark:text-neutral-500"
            >
              <Info size={12} />
            </span>
          </span>
          <MoneyInput
            name="tolerance"
            defaultCents={defaultToleranceCents(defaultAmountCents)}
            className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
          />
        </label>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onCancel ?? onDone}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !canSubmit}
          className="rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "Tracking…" : isIncomeMode ? "Track as Income" : isDebtMode ? "Track as a Payment" : "Track as a Bill"}
        </button>
      </div>
    </form>
    <AddDebtModal
      open={addDebtModalOpen}
      onClose={() => setAddDebtModalOpen(false)}
      defaultName={defaultName}
      onCreated={(debt) => {
        setDebtList((prev) => [...prev, debt]);
        setDebtSelection(debt.id);
        setMode("debt");
        setAddDebtModalOpen(false);
      }}
    />
    </>
  );
}
