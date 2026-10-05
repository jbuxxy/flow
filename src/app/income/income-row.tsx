"use client";

import { useActionState, useState, useTransition } from "react";
import { CheckCircle2, Link2, Trash2 } from "lucide-react";
import { formatCents } from "@/lib/money";
import { monthlyEquivalentCents } from "@/lib/income-calc";
import { useKebabEditRow } from "@/lib/use-kebab-edit-row";
import { deleteIncome, markIncomeReceived, updateIncome, type IncomeFormState } from "./actions";
import type { Income } from "@prisma/client";
import { SelectField } from "@/components/select-field";
import { MoneyInput } from "@/components/money-input";
import { RowActions, type RowAction } from "@/components/row-actions";
import { InlineSaveButton } from "@/components/inline-save-button";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";

const CADENCE_LABEL: Record<Income["cadence"], string> = {
  BIWEEKLY: "Biweekly",
  SEMI_MONTHLY: "Semi-Monthly",
  MONTHLY: "Monthly",
};

const initialState: IncomeFormState = {};

// nextPayDate always points at the next *unreceived* paycheck (rolled
// forward by matchIncomePayments once a matching deposit is found — see
// WORKING_ON.md), so this is always "still expected" framing. `status` is
// computed server-side (expectedStatus, src/lib/date.ts, called from
// income/page.tsx) and passed in rather than derived here — see that
// function's own comment for why a "use client" row can't safely (or even
// validly) do this itself.
export function IncomeRow({
  income,
  status,
}: {
  income: Income;
  status: { label: string; className: string } | null;
}) {
  const { editing, setEditing, setActionsOpen, editAction, rowActionsProps } = useKebabEditRow();
  const [cadence, setCadence] = useState(income.cadence);
  const [deletePending, startDeleteTransition] = useTransition();
  const [markPending, startMarkTransition] = useTransition();
  const updateIncomeWithId = updateIncome.bind(null, income.id);
  const [state, formAction, pending] = useActionState(updateIncomeWithId, initialState);
  const { justSaved } = useActionToast(pending, state, { success: "Income Saved" });

  const actions: RowAction[] = [
    editAction,
    {
      key: "delete",
      icon: Trash2,
      label: "Delete",
      tone: "danger",
      disabled: deletePending,
      confirmMessage: `Remove "${income.name}"?`,
      successToast: "Income Deleted",
      onClick: () => startDeleteTransition(() => deleteIncome(income.id)),
    },
  ];

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <div>
        <p className="flex items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
          {income.name}
          {income.source === "SIMPLEFIN" && (
            <span title="Synced — cadence auto-detected, edit if it guessed wrong" className="shrink-0">
              <Link2 size={14} className="text-blue-700 dark:text-blue-400" />
            </span>
          )}
        </p>
        <p className="text-sm text-gray-600 dark:text-neutral-400">
          {formatCents(income.amountCents)} / {CADENCE_LABEL[income.cadence]} ·{" "}
          {formatCents(monthlyEquivalentCents(income))}/mo avg
        </p>
        <div className="mt-1">
          <RowActions actions={actions} dense {...rowActionsProps}>
            {status && (
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>
                {status.label}
              </span>
            )}
          </RowActions>
        </div>
      </div>

      {income.nextPayDate && income.source !== "SIMPLEFIN" && (
        <div className="flex justify-end">
          <button
            onClick={() =>
              startMarkTransition(async () => {
                try {
                  await markIncomeReceived(income.id);
                  showToast("Paycheck Marked Received");
                } catch {
                  showToast("Couldn’t Mark Received", "error");
                }
              })
            }
            disabled={markPending}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-800 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 disabled:opacity-50"
          >
            <CheckCircle2 size={13} />
            {markPending ? "Marking…" : "Mark This Paycheck Received"}
          </button>
        </div>
      )}

      {editing && (
        <form
          action={(formData) => {
            formAction(formData);
            setEditing(false);
            setActionsOpen(false);
          }}
          className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-3"
        >
          {/* Name / Amount·Cadence·Pay Date — the shared inline-edit field
              order (household layout request, 2026-09-08); see bill-row.tsx. */}
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            Name
            <input
              name="name"
              defaultValue={income.name}
              required
              className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Amount
              <MoneyInput
                name="amount"
                defaultCents={income.amountCents}
                required
                className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Cadence
              <SelectField
                name="cadence"
                value={cadence}
                onChange={(v) => setCadence(v as Income["cadence"])}
                searchable={false}
                options={[
                  { value: "BIWEEKLY", label: "Biweekly (Every 2 Weeks)" },
                  { value: "SEMI_MONTHLY", label: "Semi-Monthly (Twice a Month)" },
                  { value: "MONTHLY", label: "Monthly" },
                ]}
                className="mt-1"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Pay Date
              <input
                name="nextPayDate"
                type="date"
                defaultValue={income.nextPayDate ? income.nextPayDate.toISOString().slice(0, 10) : ""}
                className="mt-1 w-full min-w-0 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
              />
            </label>
          </div>
          {state.error && <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>}
          <InlineSaveButton pending={pending} justSaved={justSaved} />
        </form>
      )}
    </li>
  );
}
