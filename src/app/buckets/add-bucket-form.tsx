"use client";

import { useActionState, useState } from "react";
import { createBucket, type CreateBucketState } from "./actions";
import { MoneyInput } from "@/components/money-input";
import { Modal } from "@/components/modal";
import { AddButton } from "@/components/add-button";
import { SelectField } from "@/components/select-field";
import { useActionToast } from "@/lib/use-action-toast";
import { BUCKET_TYPE_DESCRIPTION, BUCKET_TYPE_OPTIONS, type BucketType } from "./bucket-type";

const initialState: CreateBucketState = {};

export function AddBucketForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createBucket, initialState);
  const [bucketType, setBucketType] = useState<BucketType>("SPEND");
  const oneTime = bucketType === "ONE_TIME";

  useActionToast(pending, state, { success: "Bucket Saved", onSuccess: () => setOpen(false) });

  return (
    <>
      <AddButton label="Add a Bucket" onClick={() => setOpen(true)} />
      <Modal open={open} onClose={() => setOpen(false)} title="Add a Bucket">
        <form action={formAction} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              name="name"
              placeholder={oneTime ? "e.g. Tesla Down Payment" : "e.g. Gas"}
              required
              className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
            <MoneyInput
              name="monthlyCap"
              placeholder={oneTime ? "$6,000" : "$200"}
              required
              className="w-28 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
          </div>

          <input type="hidden" name="trackingMode" value={oneTime ? "SPEND" : bucketType} />
          {oneTime && <input type="hidden" name="excludedFromAllocation" value="on" />}

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            What This Bucket Tracks
            <SelectField
              value={bucketType}
              onChange={(v) => setBucketType(v as BucketType)}
              searchable={false}
              options={BUCKET_TYPE_OPTIONS}
            />
            <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
              {BUCKET_TYPE_DESCRIPTION[bucketType]}
            </span>
          </label>

          {/* Type-specific extras go below the description. Only One-Time has
              one today; the others carry their threshold/alert options on the
              per-bucket settings page, not here at creation. */}
          {oneTime && (
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                name="transactionAlertEnabled"
                className="h-4 w-4 shrink-0 accent-blue-900 dark:accent-blue-700"
              />
              Notify Me When This Payment Is Made
            </label>
          )}

          {state.error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {state.error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add Bucket"}
          </button>
        </form>
      </Modal>
    </>
  );
}
