"use client";

import { useActionState, useRef, useState } from "react";
import { updateGoal, type UpdateGoalState } from "./actions";
import { MoneyInput } from "@/components/money-input";
import { Modal } from "@/components/modal";
import { useActionToast } from "@/lib/use-action-toast";

const initialState: UpdateGoalState = {};

export function EditGoalForm({
  goalId,
  name,
  description,
  targetAmountCents,
  targetDate,
}: {
  goalId: string;
  name: string;
  description: string | null;
  targetAmountCents: number;
  targetDate: Date | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateGoal, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useActionToast(pending, state, { success: "Goal Saved", onSuccess: () => setOpen(false) });

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-gray-500 dark:text-neutral-400 underline"
      >
        Edit
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit Goal">
        <form ref={formRef} action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="goalId" value={goalId} />
          <input
            name="name"
            defaultValue={name}
            placeholder="e.g. Tesla down payment"
            required
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
          />
          <textarea
            name="description"
            defaultValue={description ?? ""}
            placeholder="What's it for? (optional)"
            rows={2}
            className="resize-none rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
          />
          <div className="flex gap-2">
            <MoneyInput
              name="targetAmount"
              defaultCents={targetAmountCents}
              placeholder="Target $"
              required
              className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
            <input
              name="targetDate"
              type="date"
              defaultValue={targetDate ? targetDate.toISOString().slice(0, 10) : ""}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
          </div>
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
            {pending ? "Saving…" : "Save"}
          </button>
        </form>
      </Modal>
    </>
  );
}
