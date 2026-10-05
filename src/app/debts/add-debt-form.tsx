"use client";

import { useActionState, useRef, useState } from "react";
import { createDebt, type DebtFormState } from "./actions";
import { RevolvingDebtFields } from "./revolving-debt-fields";
import { MoneyInput } from "@/components/money-input";
import { PercentInput } from "@/components/percent-input";
import { SelectField } from "@/components/select-field";
import { Modal } from "@/components/modal";
import { AddButton } from "@/components/add-button";
import { useActionToast } from "@/lib/use-action-toast";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";

const initialState: DebtFormState = {};

type BucketOption = { id: string; name: string };

export function AddDebtForm({
  buckets,
  defaultBucketId,
  categories,
}: {
  buckets: BucketOption[];
  defaultBucketId: string | null;
  categories: CategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createDebt, initialState);
  const [kind, setKind] = useState<"CARD" | "LOAN" | "BNPL">("CARD");
  // Derived, not stored — BNPL is the only kind that maps to INSTALLMENT;
  // CARD/LOAN both use the REVOLVING field set/mechanics (see DebtKind's doc
  // comment in schema.prisma).
  const debtType = kind === "BNPL" ? "INSTALLMENT" : "REVOLVING";
  const [cadence, setCadence] = useState("BIWEEKLY");
  const [bucketId, setBucketId] = useState(defaultBucketId ?? buckets[0]?.id ?? "");
  // Bumped on a successful add to force RevolvingDebtFields to remount —
  // its own `dueDay` state (SelectField-backed, not touched by a native
  // form reset) needs clearing the same way `cadence`/`bucketId` do below.
  const [revolvingKey, setRevolvingKey] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  // Purely a visual pre-fill for the INSTALLMENT branch below — the server
  // defaults (and creates, on first use) a "BNPL" category regardless once
  // upsertInstallmentDebtPayment's resolvedCategoryId logic runs.
  const bucketCategories = categories.filter((c) => c.bucketId === bucketId);
  const bnplCategoryId = bucketCategories.find((c) => c.name.toLowerCase() === "bnpl")?.id ?? null;

  useActionToast(pending, state, {
    success: "Debt Added",
    onSuccess: () => {
      formRef.current?.reset();
      setKind("CARD");
      setCadence("BIWEEKLY");
      setRevolvingKey((k) => k + 1);
      setBucketId(defaultBucketId ?? buckets[0]?.id ?? "");
      setOpen(false);
    },
  });

  return (
    <>
      <AddButton label="Add a Debt" onClick={() => setOpen(true)} />
      <Modal open={open} onClose={() => setOpen(false)} title="Add a Debt">
      <form ref={formRef} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="debtType" value={debtType} />
      <div className="flex gap-2 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="kind"
            value="CARD"
            checked={kind === "CARD"}
            onChange={() => setKind("CARD")}
          />
          Card
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="kind"
            value="LOAN"
            checked={kind === "LOAN"}
            onChange={() => setKind("LOAN")}
          />
          Loan
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="kind"
            value="BNPL"
            checked={kind === "BNPL"}
            onChange={() => setKind("BNPL")}
          />
          BNPL
        </label>
      </div>

      <input
        name="name"
        placeholder="Name (e.g. Capital One Venture)"
        required
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
      />

      {debtType === "REVOLVING" ? (
        <RevolvingDebtFields key={revolvingKey} />
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            Label (optional — what was this actually for?)
            <input
              name="label"
              placeholder="e.g. Sarah's laptop"
              className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
          </label>
          <div className="flex gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Payment Amount
              <MoneyInput
                name="paymentAmount"
                required
                className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
              />
            </label>
            <label className="flex w-20 shrink-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              APR %
              <PercentInput
                name="apr"
                defaultPercent={0}
                required
                className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            Number of Payments
            <div className="relative mt-1">
              <input
                name="totalPayments"
                type="number"
                min={1}
                required
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 pr-20 text-base text-neutral-900 dark:text-neutral-100 focus:border-blue-900 focus:outline-none"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500">
                Payments
              </span>
            </div>
          </label>
          <div className="flex gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Cadence
              <SelectField
                name="cadence"
                value={cadence}
                onChange={setCadence}
                searchable={false}
                options={[
                  { value: "WEEKLY", label: "Weekly" },
                  { value: "BIWEEKLY", label: "Every 2 Weeks" },
                  { value: "MONTHLY", label: "Monthly" },
                  { value: "ANNUAL", label: "Yearly" },
                ]}
                className="mt-1"
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Purchase Date
              <input
                name="purchaseDate"
                type="date"
                required
                className="mt-1 block h-[46px] w-full appearance-none rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            First Payment Date (optional — leave blank if the first payment is at purchase)
            <input
              name="firstPaymentDate"
              type="date"
              className="mt-1 block h-[46px] w-full appearance-none rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
          </label>
          <div className={buckets.length > 0 ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2"}>
            {buckets.length > 0 && (
              <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                Bucket
                <SelectField
                  name="bucketId"
                  value={bucketId}
                  onChange={setBucketId}
                  options={buckets.map((b) => ({ value: b.id, label: b.name }))}
                  className="mt-1"
                />
              </label>
            )}
            <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Category
              <div className="mt-1">
                <CategoryPicker
                  key={bucketId}
                  categories={bucketCategories}
                  defaultCategoryId={bnplCategoryId}
                  bucketId={bucketId || null}
                  name="categoryId"
                />
              </div>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            Amount Tolerance (optional — how much a payment can vary and still match)
            <MoneyInput
              name="tolerance"
              placeholder="Auto"
              className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
          </label>
        </div>
      )}

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || (debtType === "INSTALLMENT" && buckets.length > 0 && !bucketId)}
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add Debt"}
      </button>
      </form>
      </Modal>
    </>
  );
}
