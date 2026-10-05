import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { simulateMerchantRoute, describeRouteBand } from "@/lib/merchant-route";

const rule = (min: number | null, max: number | null) => ({
  amountMinCents: min,
  amountMaxCents: max,
  source: "USER",
  confidence: 1,
});

// A household's split rules for one big-box store: $60+ to Groceries,
// under $60 to Retail, base rule also Retail.
const splitRules = [rule(6_000, 2_000_000_000), rule(0, 6_000), rule(null, null)];
const txns = [
  { amountCents: 15_000, bucketId: "groceries" },
  { amountCents: 9_000, bucketId: "groceries" },
  { amountCents: 2_500, bucketId: "retail" },
  { amountCents: 4_000, bucketId: "retail" },
];

describe("simulateMerchantRoute", () => {
  test("a whole-merchant route moves nothing when amount bands cover every purchase", () => {
    // Regression 2026-10-02: the base rule loses to the bands, so routing
    // "everything" would have carved Groceries for spend that never moves.
    const r = simulateMerchantRoute(splitRules, null, txns);
    assert.equal(r.movedCount, 0);
    assert.equal(r.movedCentsByBucket.size, 0);
  });

  test("a band reusing an existing window takes over exactly that window", () => {
    const r = simulateMerchantRoute(splitRules, { minCents: 0, maxCents: 6_000 }, txns);
    assert.equal(r.movedCount, 2);
    assert.equal(r.movedCentsByBucket.get("retail"), 6_500);
    assert.equal(r.movedCentsByBucket.get("groceries"), undefined);
  });

  test("with no amount rules, a whole-merchant route moves everything", () => {
    const r = simulateMerchantRoute([rule(null, null)], null, txns);
    assert.equal(r.movedCount, 4);
    assert.equal(r.movedCentsByBucket.get("groceries"), 24_000);
  });

  test("describeRouteBand", () => {
    assert.equal(describeRouteBand({ minCents: 0, maxCents: 6_000 }), "up to $60");
    assert.equal(describeRouteBand({ minCents: 6_000, maxCents: 2_000_000_000 }), "$60 and up");
    assert.equal(describeRouteBand({ minCents: 2_000, maxCents: 6_000 }), "$20–$60");
  });
});
