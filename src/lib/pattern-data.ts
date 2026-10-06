// PatternData's type + the Prisma-row -> prop serializer live here, NOT in
// pattern-row.tsx, specifically because every server page building this prop
// (bills/page.tsx, buckets/[id]/page.tsx, income/page.tsx, transactions/
// page.tsx) needs to call serializePatternDates() — and pattern-row.tsx is a
// "use client" file, where every export (functions included, regardless of
// whether they touch any client-only API) is a client reference. A Server
// Component calling one throws at request time, not at build/typecheck
// (real incident, 2026-09-11: shipped clean through tsc/eslint/tests, broke
// every one of those four pages in production). Keep this file plain — no
// "use client" — so it stays callable from both sides.
import type { BillCadence } from "@prisma/client";
import { cyclePaymentStatus, slotBounds } from "@/lib/cycle-slots";
import { paymentReceiptOf, type PaymentReceipt, type PaymentReceiptSource } from "@/lib/payment-receipt";

export type PatternData = {
  id: string;
  label: string;
  direction: "CREDIT" | "DEBIT";
  channelKeyword: string;
  amountMinCents: number;
  amountMaxCents: number;
  dayOfMonthStart: number | null;
  dayOfMonthEnd: number | null;
  weekdays: number[];
  bucketId: string | null;
  bucketName: string | null;
  debtId: string | null;
  debtName: string | null;
  countsAsIncome: boolean;
  billId: string | null;
  billName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  // All added 2026-09-11 — see RecurringPattern's schema comment. cadence/
  // nextDueDate null together means this pattern is unscheduled (the
  // original, still fully-supported shape) — rendered as the plain rule
  // card below, same as every pattern before this existed.
  counterpartyName: string | null;
  noteKeywords: string[];
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL" | null;
  nextDueDate: string | null;
  lastPaidDate: string | null;
  toleranceCents: number | null;
  dueDateLocked: boolean;
  // False = canceled (see cancelPattern, src/app/transactions/actions.ts) —
  // only ever still present in a page's own list at all because
  // currentPeriodPatternWhere (src/lib/pattern-match.ts) keeps a scheduled
  // pattern visible through the rest of the calendar month it was last
  // paid, mirroring RecurringBill.canceled's identical "cancel right after
  // the final payment" carry-through. Read-only once false — PatternRow
  // shows no actions at all, same as a canceled bill.
  active: boolean;
  // Full history — every transaction this pattern has ever matched, not
  // scoped to any one cycle. For "did *this* cycle get paid," see
  // cyclePaid/currentCyclePayments instead.
  payments: { id: string; occurredOn: string; amountCents: number; pending: boolean; receipt: PaymentReceipt | null }[];
  // Both server-computed via cyclePaymentStatus (src/lib/cycle-slots.ts) —
  // the same calendar-month-bounded buildCycleSlots primitive
  // DebtPaymentRow/DebtRow use, so PatternRow's own "paid this cycle"
  // checkmark can't drift from theirs the way its old client-recomputed
  // heuristic already did (real household report, 2026-09-12 — see
  // pattern-row.tsx's own comment). false/[] for an unscheduled pattern
  // (no cadence/nextDueDate — PatternRow never reads these for one).
  cyclePaid: boolean;
  currentCyclePayments: { id: string; occurredOn: string; amountCents: number; pending: boolean; receipt: PaymentReceipt | null }[];
};

// Every server page constructing a PatternData prop needs the same
// Date -> ISO-date-string conversion for nextDueDate/lastPaidDate, the same
// mapping of the raw `transactions` relation (RecurringPattern has no
// separate payment-ledger model like RecurringBill does — a match just sets
// Transaction.patternId directly) into the `payments` shape PatternData/
// CycleLedger expect, and — as of 2026-09-12 — the same cyclePaid/
// currentCyclePayments computation (cyclePaymentStatus), so all four
// call sites (bills/buckets/income/transactions pages) can't quietly drift
// apart on any of this the way BillRow/PatternRow's own client-side "is this
// paid" logic already has, twice. `monthStart`/`monthEnd` are the caller's
// own utcPeriodBounds(currentPeriodKey()) — passed in rather than
// recomputed here so a caller that already has them (most do) doesn't pay
// for a second, redundant currentPeriodKey() call.
// Transaction.amountCents is signed (negative = money in, see
// matchRecurringPattern's own sign check) — Math.abs here so the ledger
// always shows "amount paid," same convention DebtPaymentCard's own
// paymentsAbs mapping uses (src/app/bills/page.tsx). Spread the result
// *after* the raw row so it overrides these fields; every other
// RecurringPattern scalar (counterpartyName, noteKeywords, cadence,
// toleranceCents, dueDateLocked, ...) already comes through fine via the raw
// spread on its own.
export function serializePatternDates<
  T extends {
    nextDueDate: Date | null;
    lastPaidDate: Date | null;
    cadence: BillCadence | null;
    createdAt: Date;
    // Select with PAYMENT_RECEIPT_SELECT (src/lib/payment-receipt.ts) so
    // each payment carries its receipt for the card's paid line/ledger.
    transactions: ({ id: string; amountCents: number; occurredOn: Date; pending: boolean } & PaymentReceiptSource)[];
  },
>(p: T, monthStart: Date, monthEnd: Date) {
  const paymentsAbs = p.transactions.map((t) => ({
    id: t.id,
    amountCents: Math.abs(t.amountCents),
    occurredOn: t.occurredOn,
    pending: t.pending,
    receipt: paymentReceiptOf(t),
  }));
  const { cyclePaid, currentCyclePayments } =
    p.nextDueDate && p.cadence
      ? cyclePaymentStatus(
          p.nextDueDate,
          p.cadence,
          paymentsAbs,
          monthStart,
          monthEnd,
          slotBounds(monthStart, { trackerCreatedAt: p.createdAt }),
        )
      : { cyclePaid: false, currentCyclePayments: [] as typeof paymentsAbs };
  const toISO = (t: (typeof paymentsAbs)[number]) => ({ ...t, occurredOn: t.occurredOn.toISOString().slice(0, 10) });
  return {
    nextDueDate: p.nextDueDate ? p.nextDueDate.toISOString().slice(0, 10) : null,
    lastPaidDate: p.lastPaidDate ? p.lastPaidDate.toISOString().slice(0, 10) : null,
    payments: paymentsAbs.map(toISO),
    cyclePaid,
    currentCyclePayments: currentCyclePayments.map(toISO),
  };
}
