import { db } from "@/lib/db";
import { matchRecurringPattern, patternMatchData } from "@/lib/pattern-match";

// Runs once, right when a pattern is created or its amount/date rules
// change — catches transactions that already synced in as a generic
// transfer/income guess (or sat unbucketed) before this specific label
// existed to claim them. Mirrors reassignTransactionsForDebt's job for
// BNPL debts, same reasoning: the ongoing per-sync sweep only ever touches
// never-yet-categorized transactions, so it can't fix history on its own.
//
// A *scheduled* pattern (cadence + nextDueDate set — see the schema comment
// on RecurringPattern) is a no-op here: matchPatternPayments
// (src/lib/pattern-payments.ts) owns its whole history — past and future —
// via its own cycle-by-cycle catch-up walk, the same way matchBillPayments
// owns a RecurringBill's history instead of the generic categorizer. Running
// both against the same scheduled pattern would let this function's looser
// channelKeyword+amount-range check claim a transaction the cycle-aware
// engine should have evaluated on its own, more precise terms instead.
export async function reassignTransactionsForPattern(patternId: string): Promise<number> {
  const pattern = await db.recurringPattern.findUnique({ where: { id: patternId } });
  if (!pattern || pattern.cadence) return 0;

  const [allPatterns, candidates] = await Promise.all([
    db.recurringPattern.findMany({ where: { householdId: pattern.householdId, active: true, cadence: null } }),
    db.transaction.findMany({
      where: {
        householdId: pattern.householdId,
        patternId: null,
        oneOff: false,
        merchant: { contains: pattern.channelKeyword, mode: "insensitive" },
        // Only ever claims transactions still sitting at the generic
        // default (unbucketed, or a plain transfer/income guess) — never
        // overwrites a bucket a human deliberately chose.
        OR: [{ bucketId: null }, { isTransfer: true }, { isIncome: true }],
      },
      select: {
        id: true,
        merchant: true,
        amountCents: true,
        occurredOn: true,
        resolvedMerchant: true,
        receiptNote: true,
      },
    }),
  ]);

  let count = 0;
  for (const t of candidates) {
    const match = matchRecurringPattern(allPatterns, t);
    if (!match || match.id !== pattern.id) continue;

    await db.transaction.update({ where: { id: t.id }, data: patternMatchData(pattern) });
    count++;
  }
  return count;
}
