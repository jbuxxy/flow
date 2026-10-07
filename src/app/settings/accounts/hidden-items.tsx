"use client";

import { useState, useTransition } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { formatDate } from "@/lib/date";
import { restoreDebt } from "@/app/debts/actions";
import { CollapseOnExit } from "@/components/collapse-on-exit";
import { deleteHiddenItem, restoreAccount } from "./actions";
import type { HiddenItem } from "@/lib/hidden-items";
import { RowActions } from "@/components/row-actions";
import { showToast } from "@/lib/toast";

// The one place a household manages everything hideDebt / restoreDebt /
// syncHousehold's own "gone from SimpleFIN" detection have touched — its
// own page at /settings/hidden. Anything can be restored here at any time
// (not gated behind the purge window; realizing you still want something
// back shouldn't wait on a clock). Delete is per-row: a manual debt goes
// immediately, anything that came from a sync (an account, or a debt still
// linked to one) keeps the year-old safety delay — see HiddenItem.deletable
// / deleteHiddenItem.
export function HiddenItems({ items }: { items: HiddenItem[] }) {
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [goneIds, setGoneIds] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visible = items.filter((i) => !goneIds.has(i.id));
  if (visible.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-neutral-400">Nothing is hidden right now.</p>
    );
  }

  function deleteConfirmMessage(item: HiddenItem): string {
    if (item.kind === "debt") {
      return `Permanently delete "${item.name}"? Its matched transactions stay in your history but are no longer counted as payments toward it. This can't be undone.`;
    }
    if (item.kind === "linked") {
      return `Permanently delete "${item.name}"? Both its account and debt records go with it. Its transactions stay in your history but lose their account/debt link. This can't be undone.`;
    }
    return `Permanently delete "${item.name}"? Its transactions stay in your history but lose their account link. This can't be undone.`;
  }

  function run(item: HiddenItem, action: "restore" | "delete") {
    setExitingId(item.id);
    startTransition(async () => {
      try {
        // A "linked" row is a hidden Debt + its still-linked hidden Account,
        // shown as one row (see getHiddenItems) — `item.id` is the account's
        // id, and restoreAccount/deleteHiddenItem("account", …) already
        // cascade to the paired debt on both ends.
        const kind = item.kind === "linked" ? "account" : item.kind;
        if (action === "restore") {
          if (kind === "debt") await restoreDebt(item.id);
          else await restoreAccount(item.id);
          showToast("Item Restored");
        } else {
          await deleteHiddenItem(kind, item.id);
          showToast("Item Deleted");
        }
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((item) => {
        const busy = exitingId === item.id;
        return (
          <li key={item.id}>
            <CollapseOnExit
              show={exitingId !== item.id}
              onExited={() => setGoneIds((prev) => new Set(prev).add(item.id))}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
                <span className="min-w-0 flex-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {item.name}
                </span>
                <span className="shrink-0 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400">
                  {item.kind === "debt" ? "Debt" : item.kind === "account" ? "Account" : "Debt + Account"}
                </span>
                <span className="flex w-full items-center sm:w-auto">
                  <RowActions
                    dense
                    actions={[
                      {
                        key: "restore",
                        icon: RotateCcw,
                        label: busy ? "Working…" : "Restore",
                        disabled: busy,
                        confirmMessage: `Restore "${item.name}"? It'll show up again in /debts, Account Settings, and its bucket.`,
                        onClick: () => run(item, "restore"),
                      },
                      item.deletable
                        ? {
                            key: "delete",
                            icon: Trash2,
                            label: "Delete",
                            tone: "danger",
                            disabled: busy,
                            confirmMessage: deleteConfirmMessage(item),
                            onClick: () => run(item, "delete"),
                          }
                        : {
                            key: "delete",
                            icon: Trash2,
                            label: "Deletable After 1 Yr",
                            disabled: true,
                          },
                    ]}
                  >
                    <span className="shrink-0 text-xs text-gray-500 dark:text-neutral-400">
                      Hidden Since{" "}
                      {formatDate(new Date(item.hiddenAt), { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                  </RowActions>
                </span>
              </div>
            </CollapseOnExit>
          </li>
        );
      })}
    </ul>
  );
}
