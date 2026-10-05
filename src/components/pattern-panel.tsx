"use client";

import { useActionState, useEffect, useRef } from "react";
import { createPattern, type PatternFormState } from "@/app/transactions/actions";
import { PatternFields } from "@/components/pattern-fields";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import type { CategoryOption } from "@/app/bills/category-picker";

export type UnlabeledP2PTxn = {
  id: string;
  merchant: string;
  amountCents: number;
  occurredOn: string;
  // Both null unless a receipt has resolved this specific transaction (see
  // linkReceipt, src/lib/receipt-sync.ts) — most transactions, and every
  // household with no email connected, have neither. PatternFields treats
  // an absent counterpartyName as "match on amount alone," exactly like
  // before these existed.
  resolvedMerchant?: string | null;
  receiptNote?: string | null;
};
type BucketOption = { id: string; name: string };
type DebtOption = { id: string; name: string };
type BillOption = { id: string; name: string };

const initialState: PatternFormState = {};

// The row already knows which app this is (that's how it ended up in this
// list at all) — no reason to make the household retype "zelle" just
// because the pattern form's own default happens to be "venmo".
function detectChannelKeyword(merchant: string): string {
  const lower = merchant.toLowerCase();
  return P2P_DISCOVERY_KEYWORDS.find((k) => lower.includes(k)) ?? "venmo";
}

// The "create a pattern from this transaction" flow — used by
// transaction-row.tsx's "track as recurring" affordance (routed here
// instead of TrackAsBillForm for a P2P transaction: a RecurringBill needs a
// fixed merchant/amount, which a generic "Venmo" line and a
// variable-weekday activity like a weekly training payment don't have —
// same reasoning as the MerchantRule P2P skip in WORKING_ON.md).
export function PatternPanel({
  txn,
  buckets,
  debts = [],
  bills = [],
  categories = [],
  direction,
  defaultLabel,
  defaultTarget,
  defaultBillId,
  defaultCategoryId,
  onDone,
}: {
  txn: UnlabeledP2PTxn;
  buckets: BucketOption[];
  debts?: DebtOption[];
  bills?: BillOption[];
  categories?: CategoryOption[];
  direction: "CREDIT" | "DEBIT";
  defaultLabel?: string;
  defaultTarget?: string;
  // Set when a same-amount debit Link would suggest turns out to be a
  // tracked bill payment — the household is very likely reimbursing that
  // same bill going forward, so the pattern defaults to that instead of
  // making them look it up again in the billId dropdown.
  defaultBillId?: string;
  // Carried over from the triggering transaction's own aiSuggestedCategoryId
  // (see transaction-row.tsx) — the same "don't make them repick something
  // Flow already guessed" reasoning as defaultTarget/defaultBillId above.
  defaultCategoryId?: string;
  // Fires once the pattern is created — every caller's row survives
  // creation (it's always embedded in transaction-row.tsx now), so this is
  // always needed to close the panel back down.
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createPattern.bind(null, txn.id), initialState);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (submittedRef.current && !pending && !state.error) {
      submittedRef.current = false;
      onDone?.();
    }
  }, [state, pending, onDone]);

  return (
    <form
      action={formAction}
      onSubmit={() => {
        submittedRef.current = true;
      }}
      className="mt-1 flex flex-col gap-3 border-t border-neutral-100 dark:border-neutral-800 pt-3"
    >
      <PatternFields
        buckets={buckets}
        debts={debts}
        bills={bills}
        categories={categories}
        lockedChannelKeyword={detectChannelKeyword(txn.merchant)}
        lockedDirection={direction}
        defaults={{
          label: defaultLabel || undefined,
          amountMin: Math.max(0, Math.abs(txn.amountCents) / 100 - 5).toFixed(2),
          amountMax: (Math.abs(txn.amountCents) / 100 + 5).toFixed(2),
          // If the household turns real scheduling on, the Amount field
          // should start from this exact transaction's amount, not a
          // re-typed guess.
          amount: (Math.abs(txn.amountCents) / 100).toFixed(2),
          target: defaultTarget,
          billId: defaultBillId,
          categoryId: defaultCategoryId,
          countsAsIncome: defaultBillId ? false : undefined,
          counterpartyName: txn.resolvedMerchant ?? undefined,
          receiptNote: txn.receiptNote ?? undefined,
          // Prefilled so the date field already has a sensible starting
          // point the moment a household turns real scheduling on — cadence
          // itself stays unset (see CADENCE_OPTIONS' own default), since a
          // single transaction has no real periodicity to infer from.
          nextDueDate: txn.occurredOn,
        }}
      />
      {state.error && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Saving…" : "Create Pattern & Apply"}
      </button>
    </form>
  );
}
