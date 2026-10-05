import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchOneTimeBucket } from "@/lib/one-time-bucket-match";

const buckets = [{ id: "tesla", name: "Tesla Down Payment", monthlyCapCents: 1_000_000 }];

describe("matchOneTimeBucket", () => {
  test("name match + amount within [0.5, 1.5]x the target -> auto-file (commit: true)", () => {
    assert.deepEqual(matchOneTimeBucket(buckets, "TESLA MOTORS", 900_000), { bucketId: "tesla", commit: true });
    assert.deepEqual(matchOneTimeBucket(buckets, "Tesla Inc", 1_400_000), { bucketId: "tesla", commit: true });
  });

  test("name match but amount way off -> weak hint (commit: false)", () => {
    assert.deepEqual(matchOneTimeBucket(buckets, "Tesla Service", 2_500_000), { bucketId: "tesla", commit: false });
  });

  test("amount very close but no name signal -> weak hint", () => {
    const generic = [{ id: "dp", name: "Down Payment", monthlyCapCents: 1_000_000 }];
    assert.deepEqual(matchOneTimeBucket(generic, "SOME ESCROW CO", 1_050_000), { bucketId: "dp", commit: false });
  });

  test("no match at all -> null", () => {
    assert.equal(matchOneTimeBucket(buckets, "Starbucks", 700), null);
  });

  test("skips buckets with a non-positive cap", () => {
    assert.equal(matchOneTimeBucket([{ id: "x", name: "Tesla", monthlyCapCents: 0 }], "Tesla", 500), null);
  });

  test("stopwords in the bucket name don't count as a name signal", () => {
    // "Payment" / "Fund" are stopwords -> "New Roof Fund" -> significant word "roof".
    const b = [{ id: "roof", name: "New Roof Fund", monthlyCapCents: 500_000 }];
    assert.deepEqual(matchOneTimeBucket(b, "ABC ROOFING LLC", 480_000), { bucketId: "roof", commit: true });
    assert.equal(matchOneTimeBucket(b, "Payment Processing", 480_000)?.commit, false); // amount-only hint, no name
  });
});
