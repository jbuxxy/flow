"use client";

import { preservingScroll } from "@/lib/preserve-scroll";
import { useState, useTransition } from "react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { reassignTransaction } from "./actions";
import { showToast } from "@/lib/toast";
import { TrackAsBillForm } from "./[id]/track-as-bill-form";
import { TransactionLabelEditor } from "@/components/transaction-label-editor";
import { MerchantLogo } from "@/components/merchant-logo";
import { PendingIcon } from "@/components/pending-icon";
import { SelectField } from "@/components/select-field";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";

type UncategorizedTxn = {
  id: string;
  merchant: string;
  rawDescription: string | null;
  amountCents: number;
  occurredOn: Date;
  pending: boolean;
  notes: string | null;
  label: string | null;
  aiSuggestedBucketId: string | null;
  aiSuggestedCategoryId: string | null;
  account: { name: string; orgName: string | null } | null;
};

type BucketOption = { id: string; name: string; trackingMode: "SPEND" | "RECURRING" | "MIXED" };
type DebtOption = { id: string; name: string };
type BillOption = { id: string; name: string };

// A debit's disposition: either normal one-off spend (any SPEND/MIXED
// bucket, or a debt payment) or a recurring bill/subscription (any
// RECURRING/MIXED bucket, via TrackAsBillForm). Offered as two explicit tabs
// rather than inferred from the AI guess alone — the guess is just a
// starting point, and it's often wrong in exactly this dimension (a
// one-off purchase from a normally-subscription merchant, or vice versa),
// so backing out and picking the other one has to be one click, the same
// "offer both, let the household pick" treatment BNPL suggestions already
// get (bill vs. debt vs. income in TrackAsBillForm itself).
function DebitAssign({
  txn,
  buckets,
  debts,
  categories,
  existingBills,
  onDone,
}: {
  txn: UncategorizedTxn;
  buckets: BucketOption[];
  debts: DebtOption[];
  categories: CategoryOption[];
  existingBills: BillOption[];
  onDone: () => void;
}) {
  const spendBuckets = buckets.filter((b) => b.trackingMode !== "RECURRING");
  const recurringBuckets = buckets.filter((b) => b.trackingMode !== "SPEND");
  const suggested = txn.aiSuggestedBucketId ? buckets.find((b) => b.id === txn.aiSuggestedBucketId) : null;
  const showSpendTab = spendBuckets.length > 0 || debts.length > 0;
  const showRecurringTab = recurringBuckets.length > 0;

  const [mode, setMode] = useState<"spend" | "recurring">(
    suggested?.trackingMode === "RECURRING" && showRecurringTab ? "recurring" : showSpendTab ? "spend" : "recurring",
  );
  const defaultSpendValue =
    txn.aiSuggestedBucketId && spendBuckets.some((b) => b.id === txn.aiSuggestedBucketId)
      ? `bucket:${txn.aiSuggestedBucketId}`
      : spendBuckets[0]
        ? `bucket:${spendBuckets[0].id}`
        : debts[0]
          ? `debt:${debts[0].id}`
          : "";
  const [selection, setSelection] = useState(defaultSpendValue);
  const [categoryId, setCategoryId] = useState<string | null>(txn.aiSuggestedCategoryId);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      {(suggested || txn.aiSuggestedCategoryId) && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">
          AI Guess:{" "}
          {[
            suggested ? `${suggested.name}${suggested.trackingMode === "RECURRING" ? " (recurring)" : ""}` : null,
            txn.aiSuggestedCategoryId ? categories.find((c) => c.id === txn.aiSuggestedCategoryId)?.name : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {showSpendTab && showRecurringTab && (
        <div className="flex w-fit rounded-lg border border-blue-100 dark:border-neutral-800 p-0.5">
          <button
            type="button"
            onClick={() => setMode("spend")}
            aria-pressed={mode === "spend"}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${
              mode === "spend" ? "bg-blue-900 dark:bg-blue-700 text-white" : "text-neutral-500 dark:text-neutral-400"
            }`}
          >
            Single
          </button>
          <button
            type="button"
            onClick={() => setMode("recurring")}
            aria-pressed={mode === "recurring"}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${
              mode === "recurring" ? "bg-blue-900 dark:bg-blue-700 text-white" : "text-neutral-500 dark:text-neutral-400"
            }`}
          >
            Recurring
          </button>
        </div>
      )}

      {mode === "spend" ? (
        <div className="flex items-center gap-2">
          <SelectField
            value={selection}
            onChange={setSelection}
            small
            searchable={false}
            options={[
              ...spendBuckets.map((b) => ({ value: `bucket:${b.id}`, label: b.name, group: "Bucket" })),
              ...debts.map((d) => ({ value: `debt:${d.id}`, label: d.name, group: "Debt Payment" })),
            ]}
            className="min-w-0 flex-1"
          />
          {selection.startsWith("bucket:") && (
            <div className="w-32 shrink-0">
              <CategoryPicker
                key={selection}
                categories={categories.filter((c) => c.bucketId === selection.slice("bucket:".length))}
                defaultCategoryId={categoryId}
                bucketId={selection.slice("bucket:".length)}
                onSelect={setCategoryId}
                small
              />
            </div>
          )}
          <button
            onClick={() =>
              startTransition(async () => {
                const [kind, id] = selection.split(":");
                await preservingScroll(() =>
                  reassignTransaction(txn.id, kind === "debt" ? { debtId: id } : { bucketId: id, categoryId }),
                );
                onDone();
                showToast("Transaction Assigned");
              })
            }
            disabled={pending || !selection}
            className="shrink-0 rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {pending ? "…" : "Assign"}
          </button>
        </div>
      ) : (
        <TrackAsBillForm
          transactionId={txn.id}
          defaultName={txn.merchant}
          defaultAmountCents={txn.amountCents}
          categories={categories}
          debts={[]}
          existingBills={existingBills}
          buckets={recurringBuckets}
          allowBill
          forceBillMode
          onDone={onDone}
          onCancel={() => setMode("spend")}
        />
      )}
    </div>
  );
}

function Row({
  txn,
  buckets,
  debts,
  categories,
  existingBills,
  labelSuggestions,
}: {
  txn: UncategorizedTxn;
  buckets: BucketOption[];
  debts: DebtOption[];
  categories: CategoryOption[];
  existingBills: BillOption[];
  labelSuggestions: string[];
}) {
  const [handled, setHandled] = useState(false);

  if (handled) return null;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-medium text-neutral-900 dark:text-neutral-100">
            <MerchantLogo merchant={txn.merchant} description={txn.rawDescription} size={16} allowGuess />
            <span className="truncate">{txn.merchant}</span>
            {txn.pending && <PendingIcon />}
          </p>
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            {formatDate(txn.occurredOn, { month: "short", day: "numeric" })}
            {txn.account && ` · ${txn.account.orgName ? `${txn.account.orgName} ` : ""}${txn.account.name}`}
            {txn.notes && ` · ${txn.notes}`}
          </p>
          <TransactionLabelEditor transactionId={txn.id} label={txn.label} suggestions={labelSuggestions} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-medium text-neutral-900 dark:text-neutral-100">
            {formatCents(txn.amountCents)}
          </span>
        </div>
      </div>

      <DebitAssign
        txn={txn}
        buckets={buckets}
        debts={debts}
        categories={categories}
        existingBills={existingBills}
        onDone={() => setHandled(true)}
      />
    </li>
  );
}

export function UncategorizedList({
  transactions,
  buckets,
  debts,
  categories,
  existingBills = [],
  labelSuggestions = {},
}: {
  transactions: UncategorizedTxn[];
  buckets: BucketOption[];
  debts: DebtOption[];
  categories: CategoryOption[];
  // Active RecurringBills the household could already be paying, offered in
  // the Recurring tab as "This Is A Payment For" / "Attach As An Extra
  // Charge On" (see TrackAsBillForm's doc comment) — this is exactly the
  // queue a payment matchBillPayments' automatic matcher missed on a
  // garbled bank descriptor turns up in (2026-09-22).
  existingBills?: BillOption[];
  labelSuggestions?: Record<string, string[]>;
}) {
  if (transactions.length === 0 || (buckets.length === 0 && debts.length === 0)) return null;

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
      <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
        Needs a Bucket ({transactions.length})
      </h2>
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
        Synced from your bank — pick a bucket (single or recurring), or mark it as a debt payment if
        it&apos;s really one.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {transactions.map((t) => (
          <Row
            key={t.id}
            txn={t}
            buckets={buckets}
            debts={debts}
            categories={categories}
            existingBills={existingBills}
            labelSuggestions={labelSuggestions[t.merchant] ?? []}
          />
        ))}
      </ul>
    </div>
  );
}
