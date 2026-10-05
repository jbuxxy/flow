"use client";

import { useState, useTransition } from "react";
import { Bookmark, Check, X } from "lucide-react";
import { updateDebtLabel } from "@/app/debts/actions";
import { showToast } from "@/lib/toast";

// The debt-row counterpart to TransactionLabelEditor (same click-to-edit
// UX, same Bookmark glyph) — pulled off of ManualDebtEditor's bigger
// "edit balance/APR/etc." Save form (2026-08-26 household request) so a
// promo-deadline note or "what was this for" can be changed on its own,
// without touching the terms fields sitting in that same panel.
export function DebtLabelEditor({
  debtId,
  label,
  className = "",
}: {
  debtId: string;
  label: string | null;
  // Merged onto the root element — lets a caller reflow this within its own
  // flex row (e.g. ManualDebtEditor's title line pushing it to a wrapped
  // second row while that row's own name field is being edited).
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label ?? "");
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={label ? `Edit Label: ${label}` : "Add Label"}
        title={label ?? "Add Label"}
        className={`inline-flex min-w-0 items-center gap-1 text-xs ${label ? "text-blue-900 dark:text-blue-300" : "text-neutral-400 dark:text-neutral-600"} ${className}`}
      >
        <Bookmark size={11} className="shrink-0" />
        {label && <span className="min-w-0 truncate">{label}</span>}
      </button>
    );
  }

  return (
    <div className={`flex min-w-0 flex-1 items-center gap-1.5 ${className}`}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        // This editor lives inside ManualDebtEditor's own outer <form> (the
        // balance/APR/etc. Save form) — Enter here must save the label, not
        // bubble up and submit that unrelated form.
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          startTransition(async () => {
            try {
              await updateDebtLabel(debtId, value);
              setEditing(false);
              showToast("Label Saved");
            } catch {
              showToast("Something Went Wrong", "error");
            }
          });
        }}
        placeholder="e.g. 0% promo — pay off by 10/23/26"
        maxLength={120}
        autoFocus
        className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs focus:border-blue-900 focus:outline-none"
      />
      <button
        type="button"
        onClick={() =>
          startTransition(async () => {
            try {
              await updateDebtLabel(debtId, value);
              setEditing(false);
              showToast("Label Saved");
            } catch {
              showToast("Something Went Wrong", "error");
            }
          })
        }
        disabled={pending}
        aria-label="Save Label"
        title="Save"
        className="shrink-0 text-blue-900 dark:text-blue-300"
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        onClick={() => {
          setValue(label ?? "");
          setEditing(false);
        }}
        aria-label="Cancel Editing Label"
        title="Cancel"
        className="shrink-0 text-neutral-500 dark:text-neutral-400"
      >
        <X size={14} />
      </button>
    </div>
  );
}
