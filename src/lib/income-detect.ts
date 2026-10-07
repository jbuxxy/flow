import { db } from "@/lib/db";
import type { PaycheckCadence } from "@prisma/client";

export type IncomeSuggestion = {
  key: string;
  merchant: string;
  accountId: string;
  accountName: string;
  amountCents: number;
  cadence: PaycheckCadence;
  nextPayDate: Date;
  occurrences: number;
  transactionIds: string[];
};

// Distinguishing biweekly (steady ~14-day gaps) from semi-monthly (gaps
// alternating ~14/~17 around the 1st & 15th) needs the deviation, not just
// the average — both land near a 14-16 day mean. This is only ever a
// suggestion the user reviews before accepting, so it doesn't need to be
// exact, just a reasonable first guess.
//
// Every gap must also sit in the cadence's own window, not just the mean —
// scattered P2P credits (same-day pairs, a few days apart, then a 75-day
// silence) averaged out to ~13 days and were suggested as "twice a month".
export function classifyCadence(gaps: number[]): { cadence: PaycheckCadence; periodDays: number } | null {
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const maxDev = Math.max(...gaps.map((g) => Math.abs(g - avg)));
  const allWithin = (lo: number, hi: number) => gaps.every((g) => g >= lo && g <= hi);
  if (avg >= 12 && avg <= 16 && maxDev <= 3) return { cadence: "BIWEEKLY", periodDays: 14 };
  if (avg >= 13 && avg <= 18 && allWithin(10, 21)) return { cadence: "SEMI_MONTHLY", periodDays: 15 };
  if (avg >= 25 && avg <= 35 && allWithin(24, 38)) return { cadence: "MONTHLY", periodDays: 30 };
  return null;
}

// Finds recurring deposits (paychecks, mainly) among transactions the sync
// already flagged as income (see categorizeNewTransactions in
// simplefin-sync.ts) that aren't yet tracked as an Income source.
export async function detectRecurringIncome(householdId: string): Promise<IncomeSuggestion[]> {
  const since = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  const txns = await db.transaction.findMany({
    where: { householdId, isIncome: true, oneOff: false, occurredOn: { gte: since } },
    orderBy: { occurredOn: "asc" },
    select: {
      id: true,
      merchant: true,
      amountCents: true,
      occurredOn: true,
      accountId: true,
      account: { select: { name: true } },
    },
  });

  const groups = new Map<string, typeof txns>();
  for (const t of txns) {
    if (!t.accountId) continue;
    const normalized = t.merchant.toLowerCase().replace(/\d+/g, "").trim();
    const key = `${t.accountId}::${normalized}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const [existingIncomes, dismissals] = await Promise.all([
    db.income.findMany({
      where: { householdId, accountId: { not: null } },
      select: { accountId: true, name: true, merchant: true },
    }),
    db.suggestionDismissal.findMany({ where: { householdId, kind: "INCOME" }, select: { key: true } }),
  ]);
  // Keyed the same way a candidate group is (account + normalized merchant),
  // not by account alone — tracking one income source (e.g. a paycheck) on
  // an account must not hide every *other* distinct recurring pattern on
  // that same account from ever being reviewed or dismissed. Uses the
  // immutable `merchant` snapshot (falling back to `name` for pre-migration
  // rows), not `name` — otherwise renaming a tracked income to something
  // friendlier made its own future deposits look untracked again, endlessly
  // re-suggesting a pattern that's already being tracked.
  const trackedKeys = new Set(
    existingIncomes.map(
      (i) => `${i.accountId}::${(i.merchant ?? i.name).toLowerCase().replace(/\d+/g, "").trim()}`,
    ),
  );
  const dismissedKeys = new Set(dismissals.map((d) => d.key));

  const suggestions: IncomeSuggestion[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2 || dismissedKeys.has(key)) continue;
    const accountId = group[0].accountId!;
    if (trackedKeys.has(key)) continue;

    const gaps = group.slice(1).map((t, i) => (t.occurredOn.getTime() - group[i].occurredOn.getTime()) / 86_400_000);
    const classified = classifyCadence(gaps);
    if (!classified) continue;

    const last = group[group.length - 1];
    // The latest deposit, not the mean — it's what the user recognizes and
    // what the next one most likely looks like (raises, changed withholding).
    const amountCents = Math.abs(last.amountCents);

    suggestions.push({
      key,
      merchant: last.merchant,
      accountId,
      accountName: last.account?.name ?? "Account",
      amountCents,
      cadence: classified.cadence,
      nextPayDate: new Date(last.occurredOn.getTime() + classified.periodDays * 86_400_000),
      occurrences: group.length,
      transactionIds: group.map((t) => t.id),
    });
  }

  return suggestions;
}
