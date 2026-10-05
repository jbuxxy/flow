// Shared fixture builders for the unit tests. Kept deliberately tiny — the
// point is that each test file reads as "given this data, expect that result"
// without a wall of object literals.
import type { DebtInput, IncomeSchedule } from "@/lib/debt-payoff";
import type { SpendTx } from "@/lib/spend";

type DailySpendTx = SpendTx & { occurredOn: Date; isRecurringBucket: boolean; isOneTimeBucket?: boolean };

/** `new Date(Date.UTC(...))` — every `@db.Date` value in this app is UTC midnight. */
export function utc(year: number, month1: number, day: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day));
}

let debtSeq = 0;

export function debt(overrides: Partial<DebtInput> = {}): DebtInput {
  return {
    id: overrides.id ?? `d${++debtSeq}`,
    name: overrides.name ?? `Debt ${debtSeq}`,
    balanceCents: 100_000,
    aprBasisPoints: 2000,
    minPaymentCents: 5_000,
    ...overrides,
  };
}

export function income(overrides: Partial<IncomeSchedule> = {}): IncomeSchedule {
  return {
    nextPayDate: utc(2026, 1, 2),
    cadence: "BIWEEKLY",
    ...overrides,
  };
}

export function spendTx(overrides: Partial<SpendTx> = {}): SpendTx {
  return {
    amountCents: 1_000,
    reimbursesTransactionId: null,
    reimbursedBy: [],
    offsetsAsDebit: [],
    ...overrides,
  };
}

export function dailySpendTx(overrides: Partial<DailySpendTx> = {}): DailySpendTx {
  return {
    ...spendTx(overrides),
    occurredOn: utc(2026, 1, 1),
    isRecurringBucket: false,
    ...overrides,
  };
}
