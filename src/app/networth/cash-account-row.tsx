"use client";

import { useTransition } from "react";
import { Link2, Wallet, PiggyBank, Trash2 } from "lucide-react";
import { formatCents } from "@/lib/money";
import { excludeCashAccount } from "./actions";
import type { AccountType } from "@prisma/client";
import { RowActions, type RowAction } from "@/components/row-actions";

export function CashAccountRow({
  account,
}: {
  account: {
    id: string;
    name: string;
    displayName: string | null;
    orgName: string | null;
    accountType: AccountType;
    balanceCents: number;
  };
}) {
  const [pending, startTransition] = useTransition();
  const displayName = account.displayName ?? account.name;
  const institution = account.orgName ?? (account.accountType === "CHECKING" ? "Checking" : "Savings");

  const actions: RowAction[] = [
    {
      key: "stop-counting",
      icon: Trash2,
      label: "Stop Counting",
      tone: "danger",
      disabled: pending,
      confirmMessage: `Stop counting "${displayName}" in net worth? It keeps syncing — you can add it back anytime from "Connected but not counted."`,
      successToast: "No Longer Counted",
      onClick: () => startTransition(() => excludeCashAccount(account.id)),
    },
  ];

  return (
    <li className="flex flex-col gap-1 rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-1.5 text-sm">
      {/* Row 1: type icon + friendly name + sync link icon (left), balance (right). */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span title={institution} className="shrink-0 text-gray-400 dark:text-neutral-500">
            {account.accountType === "CHECKING" ? <Wallet size={14} /> : <PiggyBank size={14} />}
          </span>
          <p className="min-w-0 truncate font-medium text-neutral-900 dark:text-neutral-100">{displayName}</p>
          <span title={`Linked to ${account.orgName ?? "a Connected Account"}`} className="shrink-0">
            <Link2 size={14} className="text-blue-700 dark:text-blue-400" />
          </span>
        </div>
        <span className="shrink-0 font-medium text-neutral-900 dark:text-neutral-100">
          {formatCents(account.balanceCents)}
        </span>
      </div>

      {/* Only two rows for a cash account (no "As Of" line) — the kebab rides
          on the institution line. */}
      <RowActions actions={actions} dense>
        <p className="truncate text-xs text-gray-500 dark:text-neutral-400">{institution}</p>
      </RowActions>
    </li>
  );
}
