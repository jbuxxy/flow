"use client";

import { useTransition } from "react";
import { deleteGoal } from "./actions";

export function DeleteGoalButton({ goalId, goalName }: { goalId: string; goalName: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex justify-end border-t border-neutral-100 dark:border-neutral-800 pt-4">
      <button
        onClick={() => {
          if (!confirm(`Delete "${goalName}"? This removes its contribution history too.`)) return;
          // deleteGoal redirects to /savings on success — that navigation is the
          // confirmation; no toast (and no try/catch, which would swallow the
          // redirect signal).
          startTransition(() => deleteGoal(goalId));
        }}
        disabled={pending}
        className="text-sm font-medium text-red-600 dark:text-red-400 disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}
