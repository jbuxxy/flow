import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { addMonthsClamped, stepCadence } from "@/lib/cadence-step";
import { addCadence, nextBillDueDate, subtractCadence } from "@/lib/recurring-bills";
import { addBillCadence } from "@/lib/debt-payoff";
import { addCadenceISO } from "@/lib/cadence-label";
import { utc } from "../helpers.ts";

describe("addMonthsClamped", () => {
  test("a day-31 anchor clamps to February instead of overflowing into March", () => {
    // Regression: raw setUTCMonth(+1) took Jan 31 to Mar 3 (2026-10-08 review).
    assert.deepEqual(addMonthsClamped(utc(2027, 1, 31), 1), utc(2027, 2, 28));
    assert.deepEqual(addMonthsClamped(utc(2028, 1, 31), 1), utc(2028, 2, 29));
    assert.deepEqual(addMonthsClamped(utc(2027, 3, 31), -1), utc(2027, 2, 28));
  });

  test("anchorDay carries a walk back to the 31st after a short month", () => {
    assert.deepEqual(addMonthsClamped(utc(2027, 2, 28), 1, 31), utc(2027, 3, 31));
    assert.deepEqual(addMonthsClamped(utc(2027, 1, 31), 3), utc(2027, 4, 30));
  });

  test("rolls the year in both directions", () => {
    assert.deepEqual(addMonthsClamped(utc(2026, 12, 31), 1), utc(2027, 1, 31));
    assert.deepEqual(addMonthsClamped(utc(2027, 1, 15), -1), utc(2026, 12, 15));
  });

  test("keeps any time of day", () => {
    const d = new Date("2027-01-31T15:30:00Z");
    assert.equal(addMonthsClamped(d, 1).toISOString(), "2027-02-28T15:30:00.000Z");
  });
});

describe("stepCadence", () => {
  test("ANNUAL from Feb 29 lands on Feb 28", () => {
    assert.deepEqual(stepCadence(utc(2028, 2, 29), "ANNUAL"), utc(2029, 2, 28));
  });

  test("WEEKLY / BIWEEKLY step by days, any count", () => {
    assert.deepEqual(stepCadence(utc(2027, 1, 31), "WEEKLY"), utc(2027, 2, 7));
    assert.deepEqual(stepCadence(utc(2027, 1, 31), "BIWEEKLY", -2), utc(2027, 1, 3));
  });

  test("every former copy now agrees on the month-end step", () => {
    const jan31 = utc(2027, 1, 31);
    assert.deepEqual(addCadence(jan31, "MONTHLY"), utc(2027, 2, 28));
    assert.deepEqual(addBillCadence(jan31, "MONTHLY"), utc(2027, 2, 28));
    assert.equal(addCadenceISO("2027-01-31", "MONTHLY"), "2027-02-28");
    assert.deepEqual(subtractCadence(utc(2027, 3, 31), "MONTHLY"), utc(2027, 2, 28));
    // nextBillDueDate with no history falls through to the same step.
    assert.deepEqual(nextBillDueDate("MONTHLY", jan31, []), utc(2027, 2, 28));
  });
});
