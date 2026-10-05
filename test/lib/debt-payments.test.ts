import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shouldRefreshAmountDueOnEmailConfirm } from "@/lib/debt-payments";

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
