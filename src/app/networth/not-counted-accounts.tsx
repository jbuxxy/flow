"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { formatCents } from "@/lib/money";
import { trackAccountAsAsset, includeCashAccount } from "./actions";
import { showToast } from "@/lib/toast";

// Two different underlying mechanisms behind one UI: an INVESTMENT account
// has nothing counting it until an Asset row links to it (trackAccountAsAsset
// creates one — see AssetRow's delete, which removes that row and lands the
// account right back in this list). A CHECKING/SAVINGS account has no Asset
// row at all — it's excludedFromNetWorth on the Account itself instead (see
// CashAccountRow's delete). Both read as the same "synced but not counted,
// one click to fix" case from here.
export type NotCountedAccountData = {
  id: string;
  name: string;
  orgName: string | null;
  balanceCents: number;
  kind: "investment" | "cash";
};

function Row({ account }: { account: NotCountedAccountData }) {
  const [pending, startTransition] = useTransition();
  const [tracked, setTracked] = useState(false);

  if (tracked) return null;

  return (
    <li className="flex flex-col gap-1 rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-1.5 text-sm">
      {/* Same shape as the counted rows: friendly name (left) + amount
          (right), then the institution / status line below. */}
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate font-medium text-neutral-900 dark:text-neutral-100">{account.name}</p>
        <span className="shrink-0 font-medium text-neutral-900 dark:text-neutral-100">
          {formatCents(Math.max(account.balanceCents, 0))}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs text-gray-500 dark:text-neutral-400">
          {account.orgName ? `${account.orgName} • ` : ""}Not Counted
        </p>
        <button
          onClick={() =>
            startTransition(async () => {
              try {
                if (account.kind === "investment") await trackAccountAsAsset(account.id);
                else await includeCashAccount(account.id);
                setTracked(true);
                showToast("Now Counted in Net Worth");
              } catch {
                showToast("Something Went Wrong", "error");
              }
            })
          }
          disabled={pending}
          aria-label="Count in Net Worth"
          title="Count in Net Worth"
          className="-my-1 shrink-0 rounded-lg bg-blue-900 dark:bg-blue-700 p-1.5 text-white disabled:opacity-50"
        >
          {pending ? <span aria-label="Adding Account">…</span> : <Plus size={14} />}
        </button>
      </div>
    </li>
  );
}

export function NotCountedAccounts({ accounts }: { accounts: NotCountedAccountData[] }) {
  if (accounts.length === 0) return null;

  return (
    <div className="rounded-xl border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4">
      <h2 className="text-sm font-semibold text-blue-900 dark:text-blue-300">
        Connected but Not Counted ({accounts.length})
      </h2>
      <p className="mt-1 text-xs text-blue-800 dark:text-blue-400">
        These accounts are already synced — add them to net worth with one click.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {accounts.map((a) => (
          <Row key={a.id} account={a} />
        ))}
      </ul>
    </div>
  );
}
