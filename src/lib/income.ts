import { db } from "@/lib/db";
import { monthlyEquivalentCents, addPaycheckCadence } from "@/lib/income-calc";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { offsetSumByCreditId, countedIncomeCents } from "@/lib/reimbursements";
import { detectRecurringIncome } from "@/lib/income-detect";
import { todayAsUTCDate } from "@/lib/date";
import { MAX_CATCHUP_CYCLES } from "@/lib/recurring-bills";
import { MATCH_WINDOW_DAYS, catchupCycleWindow, fastForwardCycleDate } from "@/lib/bill-match-window";
import type { IncomeSchedule } from "@/lib/debt-payoff";

export { paychecksPerYear, monthlyEquivalentCents } from "@/lib/income-calc";
export type { IncomeCalcMethod } from "@/lib/income-calc";

// The household's earliest-tracked income with a known next pay date, used
// to project real paycheck dates for the debt payoff planner (attack-order
// extra payments, the payment calendar, dashboard/bucket integrations) —
// any cadence, not just BIWEEKLY. A household with several incomes only
// gets one schedule here; picking the oldest-tracked one is the same
// "earliest wins" convention debts/page.tsx used for its old BIWEEKLY-only
// lookup. Returns null if no income has a nextPayDate set yet (manual-only
// income, or none configured) — callers fall back to a flat smoothed
// monthly extra amount in that case (see simulatePayoff's `income` param).
export async function getPrimaryIncomeSchedule(householdId: string): Promise<IncomeSchedule | null> {
  const income = await db.income.findFirst({
    where: { householdId, nextPayDate: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { nextPayDate: true, cadence: true },
  });
  return income?.nextPayDate ? { nextPayDate: income.nextPayDate, cadence: income.cadence } : null;
}

// The one household-wide "how much do we make a month" figure — feeds both
// the /income total and the /buckets allocation summary, so both read the
// same number computed the same way. Reads the method/P2P settings the
// household picked on /settings (see IncomeCalcMethod, schema.prisma)
// rather than taking them as params, so every caller automatically stays in
// sync with a settings change instead of needing its own fetch+thread-through.
export async function getIncomeSummary(householdId: string) {
  const [household, incomes, adHoc] = await Promise.all([
    db.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { incomeCalcMethod: true, includeP2PInIncomeCalc: true },
    }),
    db.income.findMany({ where: { householdId }, orderBy: { createdAt: "asc" } }),
    getAdHocIncomeThisMonth(householdId),
  ]);

  const recurringCents = incomes.reduce(
    (sum, i) => sum + monthlyEquivalentCents(i, household.incomeCalcMethod),
    0,
  );
  const p2pCents = household.includeP2PInIncomeCalc ? adHoc.totalCents : 0;
  const confirmedMonthlyCents = recurringCents + p2pCents;

  // Nothing confirmed yet: rather than let the whole app read "$0 income"
  // (which makes /budget's allocator and the /buckets cap summary look
  // broken), fall back to what income detection already sees in the synced
  // deposits. It's still surfaced as an estimate everywhere it's shown, and
  // the "confirm this recurring income" card stays up until the household
  // acts. Detection excludes dismissed suggestions, so an explicit "not
  // income" dismissal correctly drops back to $0.
  let estimatedMonthlyCents = 0;
  if (incomes.length === 0) {
    const suggestions = await detectRecurringIncome(householdId);
    estimatedMonthlyCents = suggestions.reduce(
      (sum, s) => sum + monthlyEquivalentCents(s, household.incomeCalcMethod),
      0,
    );
  }

  return {
    incomes,
    totalMonthlyCents: confirmedMonthlyCents || estimatedMonthlyCents,
    confirmedMonthlyCents,
    estimatedMonthlyCents,
    isEstimated: confirmedMonthlyCents === 0 && estimatedMonthlyCents > 0,
    method: household.incomeCalcMethod,
    includeP2PInIncomeCalc: household.includeP2PInIncomeCalc,
  };
}

export type MonthlyIncomeStatus = {
  id: string;
  name: string;
  amountCents: number;
  received: boolean;
  receivedDate: Date | null;
  expectedDate: Date;
};

// Generous but bounded — even a BIWEEKLY income stuck for months without a
// synced match (nextPayDate never rolled forward) still catches up to the
// current month well within this, without risking a runaway loop on bad data.
const MAX_PROJECTED_OCCURRENCES = 60;

// Bills don't have an equivalent function — every RecurringBill is MONTHLY
// (see bucket-bills-section.tsx), so its own BillRow card already covers
// the month with no separate projection needed. Income doesn't have that
// luxury: a BIWEEKLY/SEMI_MONTHLY paycheck lands 2-3 times a month, which a
// single IncomeRow card can't represent — every paycheck due this calendar
// month, or already received this month, shown
// as either "Received on X" or "Expected on Y". Only incomes with a
// nextPayDate (a real schedule) qualify — a manual income the household
// never gave a next-pay-date has nothing to project here, same as it has no
// expectedStatus badge on its own IncomeRow.
//
// Unlike a bill (usually one due date a month), a BIWEEKLY/SEMI_MONTHLY
// income lands 2, occasionally 3, times in the same calendar month — a
// single nextPayDate/lastReceivedDate check only ever surfaced one of them.
// This rolls nextPayDate forward by cadence to project every further
// occurrence that still lands in this month, and separately looks at every
// real linked Transaction (see matchIncomePayments) this month to catch
// every receipt, not just the most recent one.
export async function getIncomeThisMonth(householdId: string): Promise<MonthlyIncomeStatus[]> {
  const periodKey = currentPeriodKey();
  // Transaction.occurredOn is @db.Date, same as nextPayDate/lastReceivedDate
  // — all three are UTC midnight for their calendar day, so all three get
  // intersected against UTC month edges (utcPeriodBounds), not local ones.
  // (An earlier version of this comment claimed occurredOn was a plain
  // DateTime instant needing local bounds instead — it isn't; that was
  // itself the 2026-09-11 bug this now avoids, not a real distinction.)
  const { start: utcStart, end: utcEnd } = utcPeriodBounds(periodKey);

  const incomes = await db.income.findMany({
    where: { householdId, nextPayDate: { not: null } },
    include: { payments: { where: { occurredOn: { gte: utcStart, lt: utcEnd } }, select: { occurredOn: true } } },
  });

  const entries: MonthlyIncomeStatus[] = [];

  for (const income of incomes) {
    for (const payment of income.payments) {
      entries.push({
        id: `${income.id}:${payment.occurredOn.toISOString()}`,
        name: income.name,
        amountCents: income.amountCents,
        received: true,
        receivedDate: payment.occurredOn,
        expectedDate: payment.occurredOn,
      });
    }
    // A manual income (no accountId) never gets a linked Transaction — its
    // single lastReceivedDate is the only record of a receipt, so it's only
    // consulted when no real payment already covered this month (avoids
    // double-counting a synced income that also has lastReceivedDate set).
    if (
      income.payments.length === 0 &&
      income.lastReceivedDate &&
      income.lastReceivedDate >= utcStart &&
      income.lastReceivedDate < utcEnd
    ) {
      entries.push({
        id: `${income.id}:last`,
        name: income.name,
        amountCents: income.amountCents,
        received: true,
        receivedDate: income.lastReceivedDate,
        expectedDate: income.lastReceivedDate,
      });
    }

    let cursor = income.nextPayDate!;
    for (let i = 0; i < MAX_PROJECTED_OCCURRENCES && cursor < utcEnd; i++) {
      if (cursor >= utcStart) {
        entries.push({
          id: `${income.id}:${cursor.toISOString()}`,
          name: income.name,
          amountCents: income.amountCents,
          received: false,
          receivedDate: null,
          expectedDate: cursor,
        });
      }
      cursor = addPaycheckCadence(cursor, income.cadence);
    }
  }

  return entries.sort((a, b) => a.expectedDate.getTime() - b.expectedDate.getTime());
}

export type RecentPayday = {
  key: string;
  name: string;
  amountCents: number;
  receivedDate: Date;
};

// A tracked paycheck posts a few days early or late — a window this wide
// still reads as "just landed" without dragging a check from the prior
// cycle back onto the dashboard.
const PAYDAY_WINDOW_DAYS = 3;

// A tracked Income can be a $4 dividend as easily as a paycheck — a floor
// keeps the celebration card for money that actually moves the needle. Tune
// here if a smaller real paycheck ever gets missed.
const MIN_PAYDAY_CENTS = 10_000;

// Dashboard "Payday" celebration card — a tracked paycheck that posted in
// the last few days. Mirrors getDebtsPaidOffThisWeek: a short backward
// window, dismissed per-occurrence (SuggestionDismissal kind "PAYDAY") so a
// second check landing after the card was dismissed brings it back instead
// of staying hidden. Reads the real posted Transaction amount (a paycheck
// varies check to check), and only falls back to a manual income's
// lastReceivedDate when it has no linked account to match a transaction
// against — a synced income always has the transaction, so consulting both
// would double-count it.
export async function getRecentPaydays(householdId: string): Promise<RecentPayday[]> {
  const cutoff = new Date(Date.now() - PAYDAY_WINDOW_DAYS * DAY_MS);

  const [payments, manualIncomes] = await Promise.all([
    db.transaction.findMany({
      where: { householdId, isIncome: true, incomeId: { not: null }, occurredOn: { gte: cutoff } },
      orderBy: { occurredOn: "desc" },
      select: { id: true, amountCents: true, occurredOn: true, income: { select: { name: true } } },
    }),
    db.income.findMany({
      where: { householdId, accountId: null, lastReceivedDate: { gte: cutoff } },
      select: { id: true, name: true, amountCents: true, lastReceivedDate: true },
    }),
  ]);

  const entries: RecentPayday[] = payments.map((p) => ({
    key: p.id,
    name: p.income?.name ?? "Paycheck",
    amountCents: Math.abs(p.amountCents),
    receivedDate: p.occurredOn,
  }));

  for (const inc of manualIncomes) {
    entries.push({
      key: `${inc.id}:${inc.lastReceivedDate!.toISOString().slice(0, 10)}`,
      name: inc.name,
      amountCents: inc.amountCents,
      receivedDate: inc.lastReceivedDate!,
    });
  }

  return entries
    .filter((e) => e.amountCents >= MIN_PAYDAY_CENTS)
    .sort((a, b) => b.receivedDate.getTime() - a.receivedDate.getTime());
}

export async function isPaydayDismissed(householdId: string, keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  const dismissed = await db.suggestionDismissal.count({
    where: { householdId, kind: "PAYDAY", key: { in: keys } },
  });
  return dismissed >= keys.length;
}

export async function dismissPayday(householdId: string, keys: string[]): Promise<void> {
  await db.suggestionDismissal.createMany({
    data: keys.map((key) => ({ householdId, kind: "PAYDAY", key })),
    skipDuplicates: true,
  });
}

export type AdHocIncomeEntry = {
  id: string;
  name: string;
  amountCents: number;
  occurredOn: Date;
};

// A P2P credit labeled "counts as income" (a RecurringPattern with
// countsAsIncome:true, e.g. haircuts paid over Venmo) gets isIncome:true but
// is never linked to a tracked Income record — its merchant text ("Venmo")
// never matches matchIncomePayments' exact-name check above, and nothing
// else creates one on its own. Without this it's invisible on /income:
// counted in monthly-report.ts's actuals, but not shown anywhere here. This
// surfaces every such transaction for the current month as its own list —
// incomeId:null is what distinguishes it from a real paycheck receipt
// (already covered by getIncomeThisMonth).
export async function getAdHocIncomeThisMonth(householdId: string): Promise<{
  entries: AdHocIncomeEntry[];
  totalCents: number;
}> {
  // UTC bounds, not local periodBounds — occurredOn is a UTC-midnight
  // @db.Date (see getIncomeThisMonth's comment on this same distinction).
  const { start, end } = utcPeriodBounds(currentPeriodKey());

  const transactions = await db.transaction.findMany({
    where: { householdId, isIncome: true, incomeId: null, occurredOn: { gte: start, lt: end } },
    orderBy: { occurredOn: "desc" },
    select: { id: true, merchant: true, label: true, amountCents: true, occurredOn: true },
  });

  // A credit split across debt-payment offsets (see TransactionOffset) only
  // counts as income for its unallocated remainder — a trailer-sale deposit
  // that paid off two loans is mostly not spendable income.
  const offsetSums = await offsetSumByCreditId(transactions.map((t) => t.id));

  const entries = transactions
    .map((t) => ({
      id: t.id,
      name: t.label || t.merchant,
      amountCents: countedIncomeCents(Math.abs(t.amountCents), offsetSums.get(t.id) ?? 0),
      occurredOn: t.occurredOn,
    }))
    .filter((e) => e.amountCents > 0);

  return { entries, totalCents: entries.reduce((sum, e) => sum + e.amountCents, 0) };
}

const DAY_MS = 86_400_000;

// The Income counterpart to matchBillPayments (recurring-bills.ts): runs
// every sync, right after categorization. Only ever matches a tracked
// Income that has an accountId (SIMPLEFIN-sourced, or a manual one a human
// explicitly linked to an account) — a manually-entered income with nothing
// to match against just keeps its user-entered nextPayDate forever, same as
// a merchant-less manual bill never auto-advancing. On a hit: links the
// transaction (additive — doesn't touch isIncome), records
// lastReceivedDate, and rolls nextPayDate forward one cadence from the
// *expected* date, not the actual received date, so an early/late paycheck
// doesn't drift the projection.
//
// Ported matchBillPayments' two stuck-schedule fixes (2026-09-11 — this
// function used to be a single pass with neither): a self-heal fast-forward
// for when lastReceivedDate is already ahead of nextPayDate with nothing
// left to search for, and a MAX_CATCHUP_CYCLES loop so a household that
// missed several paychecks' worth of matching (a merchant-text change at
// the employer, one deposit landing outside the ±MATCH_WINDOW_DAYS window)
// has nextPayDate walk all the way back up to real time in one sync instead
// of freezing at the first miss forever — see that function's own comment
// for the real incident (2026-08-14) a single widened-window pass caused.
export async function matchIncomePayments(householdId: string): Promise<void> {
  const incomes = await db.income.findMany({
    where: { householdId, accountId: { not: null }, nextPayDate: { not: null } },
  });
  if (incomes.length === 0) return;

  // UTC midnight of the household's local "today" — nextPayDate/
  // lastReceivedDate are `@db.Date` values; a bare `new Date()` reads a day
  // ahead here after ~6pm (TZ=America/Denver).
  const now = todayAsUTCDate();

  for (const income of incomes) {
    if (!income.nextPayDate) continue;
    // Match against the immutable `merchant` snapshotted at creation, not
    // the freely-editable `name` — a household renaming "Acme Dynamics"
    // to something friendlier must not stop future deposits from matching.
    // Falls back to `name` only for rows from before `merchant` existed
    // (the migration backfills it, so this is just defense in depth).
    const matchText = income.merchant ?? income.name;

    let cyclePayDate = income.nextPayDate;

    // Self-heal: lastReceivedDate can already be ahead of nextPayDate with
    // nothing left to search for (its own qualifying transaction is
    // already linked to a past cycle) — the candidate search below would
    // never find a reason to advance past it on its own. Same grace-window
    // reasoning as matchBillPayments' own fast-forward.
    const receivedThroughMs = income.lastReceivedDate
      ? income.lastReceivedDate.getTime() + MATCH_WINDOW_DAYS * DAY_MS
      : null;
    if (receivedThroughMs !== null && cyclePayDate.getTime() <= receivedThroughMs) {
      cyclePayDate = fastForwardCycleDate(cyclePayDate, receivedThroughMs, MAX_CATCHUP_CYCLES, (d) =>
        addPaycheckCadence(d, income.cadence),
      );
      await db.income.update({ where: { id: income.id }, data: { nextPayDate: cyclePayDate } });
    }

    // One cycle at a time, not one widened pass — processing every missed
    // cycle in a single pass risks bulk-linking several separate real
    // paychecks to one cycle (matchBillPayments' 2026-08-14 incident).
    for (let i = 0; i < MAX_CATCHUP_CYCLES; i++) {
      const nextCyclePayDate = addPaycheckCadence(cyclePayDate, income.cadence);
      // Widens this cycle's own end to "now" once it's overdue — same
      // widening matchBillPayments/matchPatternPayments already do (shared
      // via catchupCycleWindow, not hand-copied a third time — the earlier
      // hand-copy is exactly how this cycle's own widening step went
      // missing in the first place: real finding, 2026-09-12 code review, a
      // paycheck posting more than MATCH_WINDOW_DAYS late (a payroll delay)
      // never had a candidate in its tight fixed window and permanently
      // stranded nextPayDate/lastReceivedDate).
      const window = catchupCycleWindow(cyclePayDate, nextCyclePayDate, now, MATCH_WINDOW_DAYS);
      if (!window) break; // this cycle isn't due yet, even loosely
      const { windowStart, windowEnd } = window;

      // Links every qualifying transaction, not just the earliest — same
      // "extras stay visible instead of silently discarded" pattern as
      // matchDebtPayments (debt-payments.ts) and matchBillPayments
      // (recurring-bills.ts). getIncomeThisMonth already renders every linked
      // payment for the current month, so an extra paycheck landing in the
      // same window as the expected one now shows up there instead of being
      // left permanently unmatched.
      const qualifying = await db.transaction.findMany({
        where: {
          householdId,
          incomeId: null,
          isIncome: true,
          accountId: income.accountId,
          merchant: { equals: matchText, mode: "insensitive" },
          occurredOn: { gte: windowStart, lte: windowEnd },
        },
        orderBy: { occurredOn: "asc" },
      });
      // No candidate for this cycle — stop here rather than guessing ahead
      // to a later cycle; a genuinely-missed paycheck should still show as
      // overdue at the cycle it's actually missing from.
      if (qualifying.length === 0) break;
      const official = qualifying[0];

      await db.transaction.updateMany({
        where: { id: { in: qualifying.map((q) => q.id) } },
        data: { incomeId: income.id },
      });

      await db.income.update({
        where: { id: income.id },
        data: { lastReceivedDate: official.occurredOn, nextPayDate: nextCyclePayDate },
      });

      cyclePayDate = nextCyclePayDate;
      if (cyclePayDate > now) break; // caught up to real time
    }
  }
}
