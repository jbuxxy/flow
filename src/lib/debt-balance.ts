// Paid-off vs. still-owed for a debt, aware of Debt.balanceUnknown — a card
// added with only its regular payment known sits at balanceCents 0 without
// being paid off (see the schema comment). Every check that used to read a
// bare `balanceCents <= 0` / `> 0` as "paid off" / "still owed" belongs
// here instead.

type BalanceDebt = { balanceCents: number; balanceUnknown?: boolean | null };

export function debtIsPaidOff(d: BalanceDebt): boolean {
  return !d.balanceUnknown && d.balanceCents <= 0;
}

// Still owed — a real positive balance, or one the household doesn't know.
export function debtHasBalance(d: BalanceDebt): boolean {
  return !!d.balanceUnknown || d.balanceCents > 0;
}

// Prisma where-fragment for debtHasBalance.
export const OWED_DEBT_WHERE = { OR: [{ balanceCents: { gt: 0 } }, { balanceUnknown: true }] };
