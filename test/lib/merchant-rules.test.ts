import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pickMerchantRule, ROUTING_OVER_MAX_CENTS, routingBounds } from "@/lib/merchant-rules";

describe("routingBounds", () => {
  test("'under' stores [0, threshold]; 'over' stores [threshold, sentinel max]", () => {
    assert.deepEqual(routingBounds("under", 5_000), { amountMinCents: 0, amountMaxCents: 5_000 });
    assert.deepEqual(routingBounds("over", 5_000), { amountMinCents: 5_000, amountMaxCents: ROUTING_OVER_MAX_CENTS });
  });
});

describe("pickMerchantRule", () => {
  const base = { amountMinCents: null, amountMaxCents: null, source: "AI", confidence: 0.6 };

  test("a bounded rule whose window contains the amount beats the base rule", () => {
    const bounded = { amountMinCents: 0, amountMaxCents: 2_000, source: "USER", confidence: 1 };
    assert.equal(pickMerchantRule([base, bounded], 1_500), bounded);
    assert.equal(pickMerchantRule([base, bounded], 3_000), base); // outside window -> base
  });

  test("uses abs(amount)", () => {
    const bounded = { amountMinCents: 0, amountMaxCents: 2_000, source: "USER", confidence: 1 };
    assert.equal(pickMerchantRule([base, bounded], -1_500), bounded);
  });

  test("narrowest window wins, then USER over AI, then higher confidence", () => {
    const wide = { amountMinCents: 0, amountMaxCents: 10_000, source: "USER", confidence: 1 };
    const narrow = { amountMinCents: 0, amountMaxCents: 3_000, source: "AI", confidence: 0.5 };
    assert.equal(pickMerchantRule([wide, narrow], 1_000), narrow);

    const userRule = { amountMinCents: 0, amountMaxCents: 5_000, source: "USER", confidence: 0.2 };
    const aiRule = { amountMinCents: 0, amountMaxCents: 5_000, source: "AI", confidence: 0.9 };
    assert.equal(pickMerchantRule([aiRule, userRule], 1_000), userRule);
  });

  test("no matching bounded rule and no base rule -> undefined", () => {
    const bounded = { amountMinCents: 0, amountMaxCents: 100, source: "USER", confidence: 1 };
    assert.equal(pickMerchantRule([bounded], 9_999), undefined);
  });

  test("boundary amounts are inclusive", () => {
    const bounded = { amountMinCents: 1_000, amountMaxCents: 2_000, source: "USER", confidence: 1 };
    assert.equal(pickMerchantRule([bounded], 1_000), bounded);
    assert.equal(pickMerchantRule([bounded], 2_000), bounded);
    assert.equal(pickMerchantRule([bounded], 999), undefined);
  });
});
