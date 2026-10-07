import { db } from "@/lib/db";

// "Hidden over a year" purge-eligibility window. Still enforced server-side
// by deleteHiddenItem (src/app/settings/accounts/actions.ts) for anything
// that isn't a plain manual debt — a synced account that vanished from the
// feed, or a debt still linked to one, keeps this safety delay before it
// can be permanently deleted.
// A plain function (not a module-level constant) so it reads "now" fresh on
// each call rather than once at module load.
export function purgeCutoffDate(): Date {
  return new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
}

export type HiddenItem = {
  id: string;
  // "linked" = a hidden Debt and its still-linked hidden Account, merged
  // into one row (they're the same real-world card — see getHiddenItems).
  // Restoring/deleting a "linked" row acts on the account id (`id` here);
  // hideAccountsWithLinkedDebts / restoreAccount / deleteHiddenItem already
  // cascade to the paired debt on both ends.
  kind: "debt" | "account" | "linked";
  name: string;
  hiddenAt: string; // ISO
  // A debt the household entered by hand (no linked SimpleFIN account) —
  // deletable immediately. Accounts, debts still linked to an account, and
  // "linked" rows are never "manual": they came from a sync and only ever
  // went hidden by actually disappearing from the feed.
  manual: boolean;
  // manual, or hidden long enough ago to clear purgeCutoffDate().
  deletable: boolean;
};

export async function getHiddenItems(householdId: string): Promise<HiddenItem[]> {
  const purgeCutoff = purgeCutoffDate();
  const [debts, accounts] = await Promise.all([
    db.debt.findMany({
      where: { householdId, hiddenAt: { not: null } },
      select: { id: true, name: true, hiddenAt: true, source: true, accountId: true },
    }),
    db.account.findMany({
      where: { householdId, hiddenAt: { not: null } },
      select: { id: true, name: true, displayName: true, hiddenAt: true },
    }),
  ]);

  const accountIds = new Set(accounts.map((a) => a.id));
  // A hidden debt still pointing at a hidden account is the *same* card as
  // that account's own row (hideAccountsWithLinkedDebts always hides both
  // together) — fold it into the account's row instead of listing it a
  // second time. A hidden debt whose account was since detached (the
  // settled-loan path in syncHousehold) or was never linked at all still
  // gets its own row, same as before.
  const linkedDebtIds = new Set(debts.filter((d) => d.accountId !== null && accountIds.has(d.accountId)).map((d) => d.id));

  return [
    ...debts
      .filter((d) => !linkedDebtIds.has(d.id))
      .map((d) => {
        const manual = d.source === "MANUAL" && d.accountId === null;
        return {
          id: d.id,
          kind: "debt" as const,
          name: d.name,
          hiddenAt: d.hiddenAt!.toISOString(),
          manual,
          deletable: manual || d.hiddenAt! < purgeCutoff,
        };
      }),
    ...accounts.map((a) => {
      const hasLinkedDebt = debts.some((d) => d.accountId === a.id);
      const kind: HiddenItem["kind"] = hasLinkedDebt ? "linked" : "account";
      return {
        id: a.id,
        kind,
        name: a.displayName ?? a.name,
        hiddenAt: a.hiddenAt!.toISOString(),
        manual: false,
        deletable: a.hiddenAt! < purgeCutoff,
      };
    }),
  ];
}
