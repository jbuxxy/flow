import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { oneTimeBucketStatus } from "@/lib/buckets";

describe("oneTimeBucketStatus", () => {
  // Tesla Down Payment: one $5,999.94 charge against a $5,999.94 target sent
  // two pushes (threshold + per-transaction). It must read as fully funded.
  test("exactly the target is fully funded (the Tesla case)", () => {
    assert.deepEqual(oneTimeBucketStatus(599_994, 599_994), { fullyFunded: true, pctFunded: 100 });
  });

  test("over the target is still fully funded, percent capped at 100", () => {
    assert.deepEqual(oneTimeBucketStatus(700_000, 599_994), { fullyFunded: true, pctFunded: 100 });
  });

  test("partial progress reports a floored percent and is not funded", () => {
    // a $2,000 charge of three toward a $6,000 target
    assert.deepEqual(oneTimeBucketStatus(200_000, 600_000), { fullyFunded: false, pctFunded: 33 });
  });

  test("nothing yet, and a zero target never counts as funded", () => {
    assert.deepEqual(oneTimeBucketStatus(0, 600_000), { fullyFunded: false, pctFunded: 0 });
    assert.deepEqual(oneTimeBucketStatus(500, 0), { fullyFunded: false, pctFunded: 0 });
  });
});
