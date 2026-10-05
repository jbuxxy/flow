"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { showToast } from "@/lib/toast";
import { linkBillNoticeToBill, linkBillNoticeToDebt, dismissBillNotice } from "@/app/settings/email/actions";

export type BillNoticeToLink = {
  id: string;
  billerName: string;
  amountDueCents: number;
  dueDate: string | null; // YYYY-MM-DD
};

export type LinkCandidate = { id: string; name: string };

// The manual half of bill-notice matching (see matchBillNoticeAmounts,
// src/lib/bill-notice-sync.ts) for a notice the fuzzy name match couldn't
// place on its own (AMBIGUOUS) or found nothing for (UNMATCHED). Modeled on
// ReceiptLinker: a compact "which one is this?" picker plus a dismiss.
export function BillNoticeLinker({
  notice,
  billCandidates,
  debtCandidates,
}: {
  notice: BillNoticeToLink;
  billCandidates: LinkCandidate[];
  debtCandidates: LinkCandidate[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pickBill = (billId: string) =>
    startTransition(async () => {
      setError(null);
      const res = await linkBillNoticeToBill(notice.id, billId);
      if (!res.ok) setError(res.error);
      else showToast("Bill Notice Linked");
    });

  const pickDebt = (debtId: string) =>
    startTransition(async () => {
      setError(null);
      const res = await linkBillNoticeToDebt(notice.id, debtId);
      if (!res.ok) setError(res.error);
      else showToast("Bill Notice Linked");
    });

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-900 dark:bg-amber-950/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {notice.billerName} · {formatCents(notice.amountDueCents)}
          </p>
          <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-neutral-400">{notice.dueDate ? `Due ${notice.dueDate}` : "No Due Date"}</p>
        </div>
        <button
          onClick={() =>
            startTransition(async () => {
              await dismissBillNotice(notice.id);
              showToast("Dismissed");
            })
          }
          disabled={pending}
          aria-label="Not One I Track"
          title="Not One I Track"
          className="shrink-0 rounded-lg border border-neutral-300 p-1.5 text-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400"
        >
          <X size={13} />
        </button>
      </div>

      {billCandidates.length === 0 && debtCandidates.length === 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-neutral-400">No bills or debts tracked yet to link this to.</p>
      )}

      {billCandidates.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {billCandidates.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => pickBill(c.id)}
                disabled={pending}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-blue-100 px-2.5 py-1.5 text-left text-xs disabled:opacity-50 dark:border-neutral-800"
              >
                <span className="min-w-0 truncate">{c.name}</span>
                <span className="shrink-0 text-gray-500 dark:text-neutral-400">Bill</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {debtCandidates.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {debtCandidates.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => pickDebt(c.id)}
                disabled={pending}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-blue-100 px-2.5 py-1.5 text-left text-xs disabled:opacity-50 dark:border-neutral-800"
              >
                <span className="min-w-0 truncate">{c.name}</span>
                <span className="shrink-0 text-gray-500 dark:text-neutral-400">Debt</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
