"use client";

import { useTransition } from "react";
import { toggleGoalReminder } from "./actions";
import { showToast } from "@/lib/toast";

export function ReminderToggle({ goalId, enabled }: { goalId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
      <input
        type="checkbox"
        checked={enabled}
        disabled={pending}
        onChange={(e) => {
          const on = e.target.checked;
          startTransition(async () => {
            try {
              await toggleGoalReminder(goalId, on);
              showToast(on ? "Reminder On" : "Reminder Off");
            } catch {
              showToast("Something Went Wrong", "error");
            }
          });
        }}
        className="h-4 w-4 rounded border-neutral-300 dark:border-neutral-700"
      />
      Weekly Reminder to Transfer Money Toward This Goal
    </label>
  );
}
