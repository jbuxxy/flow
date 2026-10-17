import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { debtHasBalance, debtIsPaidOff, OWED_DEBT_WHERE } from "@/lib/debt-balance";

describe("debt-balance", () => {
  test("a $0 balance is paid off, unless the balance is unknown", () => {
    assert.equal(debtIsPaidOff({ balanceCents: 0 }), true);
    assert.equal(debtIsPaidOff({ balanceCents: 0, balanceUnknown: true }), false);
    assert.equal(debtIsPaidOff({ balanceCents: 1200 }), false);
  });

  test("still owed: a positive balance or an unknown one", () => {
    assert.equal(debtHasBalance({ balanceCents: 1200 }), true);
    assert.equal(debtHasBalance({ balanceCents: 0, balanceUnknown: true }), true);
    assert.equal(debtHasBalance({ balanceCents: 0 }), false);
  });

  test("where-fragment matches the same rule", () => {
    assert.deepEqual(OWED_DEBT_WHERE, { OR: [{ balanceCents: { gt: 0 } }, { balanceUnknown: true }] });
  });
});
