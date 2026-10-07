import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { balanceReturnSkipsOpenOccurrence, shouldRefreshAmountDueOnEmailConfirm } from "@/lib/debt-payments";

describe("shouldRefreshAmountDueOnEmailConfirm", () => {
  test("true when the cycle is untouched (amountDueCents still equals the old baseline)", () => {
    assert.equal(shouldRefreshAmountDueOnEmailConfirm(3_500, 3_500), true);
  });

  test("false when a payment already reduced amountDueCents this cycle", () => {
    assert.equal(shouldRefreshAmountDueOnEmailConfirm(1_000, 3_500), false);
  });

  test("false when arrears already inflated amountDueCents above the old baseline", () => {
    assert.equal(shouldRefreshAmountDueOnEmailConfirm(7_000, 3_500), false);
  });
});

describe("balanceReturnSkipsOpenOccurrence", () => {
  const due = new Date(Date.UTC(2026, 9, 4)); // Oct 4

  test("a charge after the due date's statement closed skips the occurrence (Sam's Club, 2026-10-07)", () => {
    assert.equal(balanceReturnSkipsOpenOccurrence(due, new Date(Date.UTC(2026, 9, 4))), true);
    assert.equal(balanceReturnSkipsOpenOccurrence(due, new Date(Date.UTC(2026, 9, 7))), true);
  });

  test("a charge inside the 21-day statement window skips it", () => {
    assert.equal(balanceReturnSkipsOpenOccurrence(due, new Date(Date.UTC(2026, 8, 14))), true);
  });

  test("a charge 21+ days before the due date may make the statement, so it stays open", () => {
    assert.equal(balanceReturnSkipsOpenOccurrence(due, new Date(Date.UTC(2026, 8, 13))), false);
    assert.equal(balanceReturnSkipsOpenOccurrence(due, new Date(Date.UTC(2026, 8, 1))), false);
  });
});
