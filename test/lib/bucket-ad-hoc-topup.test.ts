import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { allocateAdHocSurplus, trimTopUpsToCounted } from "@/lib/bucket-ad-hoc-topup";

describe("allocateAdHocSurplus", () => {
  test("covers a single bucket's overage from a single source entry", () => {
    const draws = allocateAdHocSurplus(
      [{ id: "s1", remainingCents: 5000 }],
      [{ id: "b1", overageCents: 2000 }],
    );
    assert.deepEqual(draws, [{ bucketId: "b1", sourceEntryId: "s1", amountCents: 2000 }]);
  });

  test("a bucket with no overage draws nothing", () => {
    const draws = allocateAdHocSurplus(
      [{ id: "s1", remainingCents: 5000 }],
      [{ id: "b1", overageCents: 0 }, { id: "b2", overageCents: -100 }],
    );
    assert.deepEqual(draws, []);
  });

  test("an empty source pool draws nothing", () => {
    const draws = allocateAdHocSurplus([], [{ id: "b1", overageCents: 2000 }]);
    assert.deepEqual(draws, []);
  });

  test("a single bucket's overage splits across multiple source entries, oldest-given-first order preserved", () => {
    const draws = allocateAdHocSurplus(
      [{ id: "s1", remainingCents: 1000 }, { id: "s2", remainingCents: 5000 }],
      [{ id: "b1", overageCents: 3000 }],
    );
    assert.deepEqual(draws, [
      { bucketId: "b1", sourceEntryId: "s1", amountCents: 1000 },
      { bucketId: "b1", sourceEntryId: "s2", amountCents: 2000 },
    ]);
  });

  test("a single source entry funds more than one bucket, in target order given", () => {
    const draws = allocateAdHocSurplus(
      [{ id: "s1", remainingCents: 3000 }],
      [{ id: "b1", overageCents: 1000 }, { id: "b2", overageCents: 1000 }],
    );
    assert.deepEqual(draws, [
      { bucketId: "b1", sourceEntryId: "s1", amountCents: 1000 },
      { bucketId: "b2", sourceEntryId: "s1", amountCents: 1000 },
    ]);
  });

  test("earlier target buckets have first claim on the pool — a later bucket can go unfunded", () => {
    const draws = allocateAdHocSurplus(
      [{ id: "s1", remainingCents: 1500 }],
      [{ id: "b1", overageCents: 1000 }, { id: "b2", overageCents: 1000 }],
    );
    assert.deepEqual(draws, [
      { bucketId: "b1", sourceEntryId: "s1", amountCents: 1000 },
      { bucketId: "b2", sourceEntryId: "s1", amountCents: 500 },
    ]);
  });

  test("does not mutate the input arrays", () => {
    const sourceEntries = [{ id: "s1", remainingCents: 5000 }];
    const targetBuckets = [{ id: "b1", overageCents: 2000 }];
    allocateAdHocSurplus(sourceEntries, targetBuckets);
    assert.deepEqual(sourceEntries, [{ id: "s1", remainingCents: 5000 }]);
    assert.deepEqual(targetBuckets, [{ id: "b1", overageCents: 2000 }]);
  });

  test("an already-fully-drawn source entry (remainingCents 0) is skipped", () => {
    const draws = allocateAdHocSurplus(
      [{ id: "s1", remainingCents: 0 }, { id: "s2", remainingCents: 500 }],
      [{ id: "b1", overageCents: 500 }],
    );
    assert.deepEqual(draws, [{ bucketId: "b1", sourceEntryId: "s2", amountCents: 500 }]);
  });
});

describe("trimTopUpsToCounted", () => {
  const row = (id: string, src: string, amountCents: number, sec: number) => ({
    id,
    sourceTransactionId: src,
    amountCents,
    createdAt: new Date(2026, 8, 1, 0, 0, sec),
  });

  test("a fully offset source loses every draw (the $177 Mobile Deposit case)", () => {
    const out = trimTopUpsToCounted([row("a", "s1", 13_693, 0), row("b", "s1", 4_007, 0)], new Map([["s1", 0]]));
    assert.deepEqual([...out.deleteIds].sort(), ["a", "b"]);
    assert.deepEqual(out.updates, []);
  });

  test("a source that vanished from the counted map counts as 0", () => {
    assert.deepEqual(trimTopUpsToCounted([row("a", "s1", 500, 0)], new Map()).deleteIds, ["a"]);
  });

  test("partial offset revokes newest draws first, shrinking the boundary row", () => {
    const rows = [row("old", "s1", 3_000, 1), row("mid", "s1", 2_000, 2), row("new", "s1", 1_000, 3)];
    // draws total 6,000; source now counts 3,500 -> revoke 2,500
    const out = trimTopUpsToCounted(rows, new Map([["s1", 3_500]]));
    assert.deepEqual(out.deleteIds, ["new"]);
    assert.deepEqual(out.updates, [{ id: "mid", amountCents: 500 }]);
  });

  test("draws within what the source still counts are untouched; sources are independent", () => {
    const rows = [row("a", "s1", 1_000, 0), row("b", "s2", 4_000, 0)];
    const out = trimTopUpsToCounted(rows, new Map([["s1", 1_000], ["s2", 1_000]]));
    assert.deepEqual(out, { deleteIds: [], updates: [{ id: "b", amountCents: 1_000 }] });
  });
});
