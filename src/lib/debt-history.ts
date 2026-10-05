import { db } from "@/lib/db";
import { currentDateKey, currentPeriodKey } from "@/lib/period";
import { isDemoHousehold } from "@/lib/demo";

// Mirrors recordNetWorthSnapshot (src/lib/networth-history.ts) — upserted on
// every /debts load so today's row always reflects the latest computed
// total rather than whatever it was on first load that day.
export async function recordDebtSnapshot(householdId: string, totalDebtCents: number): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const dateKey = currentDateKey();
  await db.debtSnapshot.upsert({
    where: { householdId_dateKey: { householdId, dateKey } },
    create: { householdId, dateKey, totalDebtCents },
    update: { totalDebtCents },
  });
}

export type DebtTrend = { deltaCents: number; sinceDateKey: string };

// Reconstructs what the household's total debt looked like on the 1st of
// the current month, for a household with no snapshot from back then (this
// feature's first month in production, or any month whose 1st was never
// visited). Approximated from this month's debt-payment transactions
// (amountCents > 0, isTransfer, debtId set — same filter debt-payments.ts
// uses to identify a paydown) added back onto today's total; new charges
// added to a debt since month start aren't tracked anywhere, so a revolving
// balance that grew this month will read as a smaller paydown than reality,
// never a wrong-direction one. Persisted once so later loads reuse it
// instead of recomputing.
async function backfillMonthStartSnapshot(
  householdId: string,
  currentTotalDebtCents: number,
  monthStartKey: string,
): Promise<number> {
  const monthStart = new Date(`${monthStartKey}T00:00:00.000Z`);
  const paidThisMonth = await db.transaction.aggregate({
    where: { householdId, isTransfer: true, debtId: { not: null }, amountCents: { gt: 0 }, occurredOn: { gte: monthStart } },
    _sum: { amountCents: true },
  });
  const totalDebtCentsAtMonthStart = currentTotalDebtCents + (paidThisMonth._sum.amountCents ?? 0);
  await db.debtSnapshot.upsert({
    where: { householdId_dateKey: { householdId, dateKey: monthStartKey } },
    create: { householdId, dateKey: monthStartKey, totalDebtCents: totalDebtCentsAtMonthStart },
    update: {},
  });
  return totalDebtCentsAtMonthStart;
}

// Same month-to-date comparison as getNetWorthTrend: today's total against
// the earliest snapshot recorded this calendar month, backfilling that
// reference point from payment history the first time a given month has no
// snapshot yet. Returns null only on the 1st itself, when there's nothing
// to compare against.
export async function getDebtTrend(householdId: string, currentTotalDebtCents: number): Promise<DebtTrend | null> {
  const todayKey = currentDateKey();
  const monthStartKey = `${currentPeriodKey()}-01`;
  const reference = await db.debtSnapshot.findFirst({
    where: { householdId, dateKey: { gte: monthStartKey, lt: todayKey } },
    orderBy: { dateKey: "asc" },
  });
  if (reference) {
    return { deltaCents: currentTotalDebtCents - reference.totalDebtCents, sinceDateKey: reference.dateKey };
  }
  if (todayKey === monthStartKey) return null;
  const totalDebtCentsAtMonthStart = await backfillMonthStartSnapshot(householdId, currentTotalDebtCents, monthStartKey);
  return { deltaCents: currentTotalDebtCents - totalDebtCentsAtMonthStart, sinceDateKey: monthStartKey };
}
