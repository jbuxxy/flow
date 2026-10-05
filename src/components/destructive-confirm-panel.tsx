"use client";

import { useActionState, useState } from "react";
import type { ReactNode } from "react";
import { useActionToast } from "@/lib/use-action-toast";

type ConfirmPanelState = { error?: string };

// Shared shape behind DangerZone (settings/danger-zone.tsx) and
// PurgeFinancialDataPanel (settings/database/purge-financial-data-panel.tsx)
// — both were a collapsed red-outline trigger that expands into a "type X to
// confirm" form bound to a server action via useActionState. One
// implementation, parameterized by copy/labels/the confirm field's name and
// the bound action.
export function DestructiveConfirmPanel({
  title,
  description,
  triggerLabel,
  confirmFieldName,
  confirmFieldLabel,
  submitLabel,
  pendingLabel,
  successToast,
  action,
  initialState,
}: {
  title: string;
  description: string;
  triggerLabel: string;
  confirmFieldName: string;
  confirmFieldLabel: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  // Fired on a successful confirm. These actions usually redirect on success so
  // the toast may not outlive the navigation — it's kept mainly so the error
  // branch surfaces, and for the rare non-redirecting caller.
  successToast: string;
  action: (prevState: ConfirmPanelState, formData: FormData) => Promise<ConfirmPanelState>;
  initialState: ConfirmPanelState;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, initialState);
  useActionToast(pending, state, { success: successToast });

  return (
    <div className="rounded-2xl border border-red-200 dark:border-red-900/60 p-4">
      <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">{title}</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">{description}</p>

      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="mt-3 rounded-lg border border-red-300 dark:border-red-900 px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400"
        >
          {triggerLabel}
        </button>
      ) : (
        <form action={formAction} className="mt-3 flex flex-col gap-2">
          <label className="text-xs text-gray-500 dark:text-neutral-400">{confirmFieldLabel}</label>
          <input
            name={confirmFieldName}
            required
            className="rounded-lg border border-red-300 dark:border-red-900 dark:bg-neutral-900 px-3 py-2 text-sm focus:border-red-600 focus:outline-none"
          />
          {state.error && <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>}
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? pendingLabel : submitLabel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
