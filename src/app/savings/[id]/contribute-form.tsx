"use client";

import { useActionState, useSyncExternalStore } from "react";
import { addContribution, type ContributeState } from "./actions";
import { useActionToast } from "@/lib/use-action-toast";
import { MoneyInput } from "@/components/money-input";
import { currentDateKey } from "@/lib/period";

const initialState: ContributeState = {};

// today's date can only be known client-side (the server's clock may not
// agree with the browser's, and reading it at SSR time would otherwise
// bake in a stale value) — useSyncExternalStore with a no-op subscribe
// (nothing ever changes after mount) keeps SSR/first-paint blank and lets
// the real client date take over immediately, without setState-in-an-effect.
function subscribeNever() {
  return () => {};
}

function getServerToday() {
  return "";
}

function getClientToday() {
  // Local-calendar "YYYY-MM-DD" — toISOString() is UTC and lands on tomorrow
  // for a viewer west of UTC in their evening, defaulting the date field to
  // the wrong day.
  return currentDateKey();
}

export function ContributeForm({ goalId }: { goalId: string }) {
  const [state, formAction, pending] = useActionState(addContribution, initialState);
  useActionToast(pending, state, { success: "Contribution Logged" });
  const today = useSyncExternalStore(subscribeNever, getClientToday, getServerToday);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="goalId" value={goalId} />
      <div className="flex gap-2">
        <MoneyInput
          name="amount"
          placeholder="Amount $"
          required
          className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
        />
        <input
          name="occurredOn"
          type="date"
          required
          defaultValue={today}
          key={today}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
        />
      </div>
      <input
        name="note"
        placeholder="Note (optional)"
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
      />
      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Adding…" : "Log Contribution"}
      </button>
    </form>
  );
}
