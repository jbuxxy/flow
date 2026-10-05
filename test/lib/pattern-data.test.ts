import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { serializePatternDates } from "@/lib/pattern-data";
import type { PaymentReceiptSource } from "@/lib/payment-receipt";
import { utc } from "../helpers.ts";

const NO_RECEIPT: PaymentReceiptSource = {
  merchant: "Venmo",
  resolvedMerchant: null,
  resolvedMerchantIsPerson: false,
  receiptItems: null,
  receiptNote: null,
  receiptPaidWith: null,
  receiptTotalCents: null,
  receipt: null,
};

// Minimal shape serializePatternDates actually reads — every other
// RecurringPattern scalar (counterpartyName, label, ...) passes through via
// the caller's own spread, untouched by this function.
function pattern(overrides: {
  nextDueDate?: Date | null;
  lastPaidDate?: Date | null;
  cadence?: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL" | null;
  createdAt?: Date;
  transactions?: ({ id: string; amountCents: number; occurredOn: Date } & Partial<PaymentReceiptSource>)[];
}) {
  return {
    nextDueDate: overrides.nextDueDate ?? null,
    lastPaidDate: overrides.lastPaidDate ?? null,
    cadence: overrides.cadence ?? null,
    createdAt: overrides.createdAt ?? utc(2026, 1, 1),
    transactions: (overrides.transactions ?? []).map((t) => ({ ...NO_RECEIPT, ...t })),
  };
}

const monthStart = utc(2026, 9, 1);
const monthEnd = utc(2026, 10, 1);

describe("serializePatternDates", () => {
  test("unscheduled pattern (no cadence/nextDueDate) reads not-paid with no ledger", () => {
    const result = serializePatternDates(pattern({}), monthStart, monthEnd);
    assert.equal(result.cyclePaid, false);
    assert.deepEqual(result.currentCyclePayments, []);
    assert.equal(result.nextDueDate, null);
    assert.equal(result.lastPaidDate, null);
  });

  test("scheduled pattern with a matching payment this month reads paid, with ISO dates", () => {
    const result = serializePatternDates(
      pattern({
        nextDueDate: utc(2026, 9, 9),
        cadence: "MONTHLY",
        transactions: [{ id: "t1", amountCents: -5000, occurredOn: utc(2026, 9, 9) }],
      }),
      monthStart,
      monthEnd,
    );
    assert.equal(result.cyclePaid, true);
    assert.equal(result.nextDueDate, "2026-09-09");
    assert.equal(result.currentCyclePayments.length, 1);
    assert.equal(result.currentCyclePayments[0].occurredOn, "2026-09-09");
    // Signed Transaction.amountCents (negative = money in) comes back
    // absolute, same convention DebtPaymentCard's paymentsAbs uses.
    assert.equal(result.currentCyclePayments[0].amountCents, 5000);
  });

  test("scheduled pattern with nothing matched this month reads not-paid", () => {
    const result = serializePatternDates(
      pattern({ nextDueDate: utc(2026, 9, 9), cadence: "MONTHLY", transactions: [] }),
      monthStart,
      monthEnd,
    );
    assert.equal(result.cyclePaid, false);
    assert.deepEqual(result.currentCyclePayments, []);
  });

  test("lastPaidDate converts to an ISO date string when present", () => {
    const result = serializePatternDates(pattern({ lastPaidDate: utc(2026, 8, 15) }), monthStart, monthEnd);
    assert.equal(result.lastPaidDate, "2026-08-15");
  });

  test("full payments history (not just this cycle) is also ISO-converted and abs'd", () => {
    const result = serializePatternDates(
      pattern({
        transactions: [
          { id: "t1", amountCents: -1234, occurredOn: utc(2026, 7, 3) },
          { id: "t2", amountCents: 5678, occurredOn: utc(2026, 8, 3) },
        ],
      }),
      monthStart,
      monthEnd,
    );
    assert.deepEqual(result.payments, [
      { id: "t1", amountCents: 1234, occurredOn: "2026-07-03", receipt: null },
      { id: "t2", amountCents: 5678, occurredOn: "2026-08-03", receipt: null },
    ]);
  });

  test("each payment carries its receipt (or null) through to the cycle ledger", () => {
    const result = serializePatternDates(
      pattern({
        nextDueDate: utc(2026, 9, 10),
        cadence: "MONTHLY",
        transactions: [
          {
            id: "t1",
            amountCents: 15000,
            occurredOn: utc(2026, 9, 10),
            resolvedMerchant: "Jamie Rivera",
            resolvedMerchantIsPerson: true,
            receiptPaidWith: "Venmo",
            receiptNote: "September tuition",
            receipt: { occurredOn: utc(2026, 9, 9), receivedAt: utc(2026, 9, 10) },
          },
          { id: "t0", amountCents: 15000, occurredOn: utc(2026, 8, 10) },
        ],
      }),
      monthStart,
      monthEnd,
    );
    assert.deepEqual(result.currentCyclePayments[0].receipt, {
      hasReceipt: true,
      receiptItems: null,
      receiptNote: "September tuition",
      // P2P person payee — the card's own "Venmo - Name" line already says it.
      receiptPaidWith: null,
      receiptDate: "2026-09-09",
      receiptTotalCents: null,
    });
    assert.equal(result.payments.find((p) => p.id === "t0")!.receipt, null);
  });
});
