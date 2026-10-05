"use client";

import { useState, useTransition } from "react";
import { Link2, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { unlinkReimbursement, type ReimbursementCandidate } from "@/app/transactions/actions";
import { showToast } from "@/lib/toast";

// A bill payment's "this got reimbursed" confirmation — read-only display
// (plus unlink) of whatever's already linked via a RecurringPattern pinned
// to this bill (matchReimbursements, src/lib/reimbursements.ts) or manually
// from the credit's own side (ReimbursementLinker, /transactions). No
// search/link-a-new-one affordance here on purpose (2026-08-26 household
// feedback: this row should just confirm what's already matched, not be a
// second place to set one up). A debit can have more than one reimbursing
// credit (a bill split between people), so `linked` is a list.
export function BillReimbursementLinker({ linked }: { linked: ReimbursementCandidate[] }) {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState(linked);

  if (current.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {current.map((r) => (
        <div key={r.id} className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <Link2 size={12} className="shrink-0" />
          <span className="truncate">
            Reimbursed {formatCents(Math.abs(r.amountCents))} ·{" "}
            {formatDate(new Date(r.occurredOn), { month: "short", day: "numeric" })}
          </span>
          <button
            onClick={() => {
              if (
                !confirm(
                  `Clear this reimbursement match? The ${formatCents(Math.abs(r.amountCents))} credit goes back to needing a call, and this bill's net drops the reimbursed amount.`,
                )
              )
                return;
              startTransition(async () => {
                try {
                  await unlinkReimbursement(r.id);
                  setCurrent((c) => c.filter((x) => x.id !== r.id));
                  showToast("Reimbursement Unlinked");
                } catch {
                  showToast("Something Went Wrong", "error");
                }
              });
            }}
            disabled={pending}
            aria-label="Unlink Reimbursement"
            title="Unlink"
            className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
