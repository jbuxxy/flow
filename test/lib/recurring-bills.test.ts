import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addCadence,
  amountToleranceCents,
  extraChargeToleranceCents,
  isBillCycleSkipActive,
  skipShownOnBillRow,
  nextBillDueDate,
  subtractCadence,
} from "@/lib/recurring-bills";
import { MATCH_WINDOW_DAYS } from "@/lib/bill-match-window";
import { utc } from "../helpers.ts";

describe("addCadence / subtractCadence", () => {
  test("each cadence, UTC arithmetic", () => {
    assert.deepEqual(addCadence(utc(2026, 1, 15), "MONTHLY"), utc(2026, 2, 15));
    assert.deepEqual(addCadence(utc(2026, 1, 15), "ANNUAL"), utc(2027, 1, 15));
    assert.deepEqual(addCadence(utc(2026, 1, 1), "BIWEEKLY"), utc(2026, 1, 15));
    assert.deepEqual(addCadence(utc(2026, 1, 1), "WEEKLY"), utc(2026, 1, 8));
  });

  test("subtractCadence is the inverse for day-based cadences", () => {
    assert.deepEqual(subtractCadence(utc(2026, 1, 15), "BIWEEKLY"), utc(2026, 1, 1));
    assert.deepEqual(subtractCadence(utc(2026, 1, 8), "WEEKLY"), utc(2026, 1, 1));
    assert.deepEqual(subtractCadence(utc(2027, 1, 15), "ANNUAL"), utc(2026, 1, 15));
  });
});

describe("nextBillDueDate", () => {
  test("non-MONTHLY just rolls one cadence period", () => {
    assert.deepEqual(nextBillDueDate("WEEKLY", utc(2026, 3, 2), [utc(2026, 2, 20)]), utc(2026, 3, 9));
  });

  test("MONTHLY with no history rolls one month", () => {
    assert.deepEqual(nextBillDueDate("MONTHLY", utc(2026, 3, 15), []), utc(2026, 4, 15));
  });

  test("MONTHLY with history snaps to the median day-of-month, in the next month", () => {
    // history days: 3, 5, 4 -> sorted 3,4,5 -> median index floor(3/2)=1 -> 4.
    const history = [utc(2026, 1, 3), utc(2026, 2, 5), utc(2026, 3, 4)];
    assert.deepEqual(nextBillDueDate("MONTHLY", utc(2026, 3, 4), history), utc(2026, 4, 4));
  });

  test("MONTHLY median clamps to a shorter target month", () => {
    // median day 31, previous due Jan 31 -> next month Feb, clamped to 28.
    const history = [utc(2025, 12, 31), utc(2026, 1, 31), utc(2025, 11, 30)];
    assert.deepEqual(nextBillDueDate("MONTHLY", utc(2026, 1, 31), history), utc(2026, 2, 28));
  });
});

describe("amountToleranceCents", () => {
  test("wider of 30% or a $5 floor", () => {
    assert.equal(amountToleranceCents(100_00), 30_00); // 30%
    assert.equal(amountToleranceCents(9_64), 500); // floor
  });
});

describe("extraChargeToleranceCents", () => {
  test("wider of 10% or a $0.50 floor", () => {
    assert.equal(extraChargeToleranceCents(20_00), 200); // 10%
    assert.equal(extraChargeToleranceCents(2_00), 50); // floor ($0.20 would be 10%)
  });

  test("much tighter than amountToleranceCents for the same small fee", () => {
    // The exact real-world case this exists for: a $2.00 ancillary fee.
    // amountToleranceCents' $5 floor alone would admit almost any charge
    // from $0 to $7 as "the same fee" — extraChargeToleranceCents must not.
    const feeCents = 2_00;
    assert.ok(extraChargeToleranceCents(feeCents) < amountToleranceCents(feeCents));
  });
});

describe("isBillCycleSkipActive", () => {
  test("a skip is active right after skipBillCycle advances nextDueDate one cadence forward", () => {
    // Summit Gas, skipped Sep 9 -> nextDueDate advances to Oct 9 (MONTHLY, no
    // history, same as every real skipBillCycle call).
    assert.ok(isBillCycleSkipActive("MONTHLY", utc(2026, 9, 9), utc(2026, 10, 9)));
  });

  test("a stale skip from a cycle that's since rolled past again is not active", () => {
    // The Oct 9 skip above got superseded by a real payment (or a second
    // skip) that moved nextDueDate on to Nov 9 — the Sep 9 skip no longer
    // maps forward to the bill's current nextDueDate.
    assert.ok(!isBillCycleSkipActive("MONTHLY", utc(2026, 9, 9), utc(2026, 11, 9)));
  });

  test("not active before any skip at all (nextDueDate still equals the skip candidate itself)", () => {
    assert.ok(!isBillCycleSkipActive("MONTHLY", utc(2026, 9, 9), utc(2026, 9, 9)));
  });

  test("works for non-MONTHLY cadences too", () => {
    assert.ok(isBillCycleSkipActive("WEEKLY", utc(2026, 9, 2), utc(2026, 9, 9)));
    assert.ok(!isBillCycleSkipActive("WEEKLY", utc(2026, 9, 2), utc(2026, 9, 16)));
  });
});

test("MATCH_WINDOW_DAYS stays well under half a week", () => {
  assert.ok(MATCH_WINDOW_DAYS < 3.5);
});

describe("skipShownOnBillRow", () => {
  test("last month's skip stops standing in for this month's due line", () => {
    // Lakeside Gas: skipped Sep 9 (still active — nextDueDate is Oct 9), but in
    // October the row has to show the Oct 9 bill, not "Skipped Sep 09".
    assert.equal(skipShownOnBillRow(utc(2026, 9, 9), utc(2026, 10, 1)), null);
    // Same skip, still September: shown.
    assert.deepEqual(skipShownOnBillRow(utc(2026, 9, 9), utc(2026, 9, 1)), utc(2026, 9, 9));
    // A cycle skipped early (October's, skipped in late September) shows.
    assert.deepEqual(skipShownOnBillRow(utc(2026, 10, 2), utc(2026, 9, 1)), utc(2026, 10, 2));
    assert.equal(skipShownOnBillRow(undefined, utc(2026, 10, 1)), null);
  });
});
