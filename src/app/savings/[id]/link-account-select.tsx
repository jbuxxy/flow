"use client";

import { useTransition } from "react";
import { linkGoalAccount } from "./actions";
import { SelectField } from "@/components/select-field";
import { showToast } from "@/lib/toast";

export function LinkAccountSelect({
  goalId,
  accountId,
  accounts,
}: {
  goalId: string;
  accountId: string | null;
  accounts: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();

  if (accounts.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="text-xs text-gray-500 dark:text-neutral-400">Linked Account</label>
      <SelectField
        value={accountId ?? ""}
        onChange={(v) =>
          startTransition(async () => {
            try {
              await linkGoalAccount(goalId, v);
              showToast(v ? "Account Linked" : "Account Unlinked");
            } catch {
              showToast("Something Went Wrong", "error");
            }
          })
        }
        disabled={pending}
        small
        options={[{ value: "", label: "Manual (None)" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
        className="w-48"
      />
    </div>
  );
}
