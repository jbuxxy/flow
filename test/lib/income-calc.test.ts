import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addPaycheckCadence,
  monthlyEquivalentCents,
  paychecksPerYear,
  subtractPaycheckCadence,
  semiMonthlyDaysOrDefault,
  inferSemiMonthlyDays,
  formatSemiMonthlyDays,
} from "@/lib/income-calc";
import { utc } from "../helpers.ts";

describe("paychecksPerYear", () => {
  test("per cadence", () => {
    assert.equal(paychecksPerYear("BIWEEKLY"), 26);
    assert.equal(paychecksPerYear("SEMI_MONTHLY"), 24);
    assert.equal(paychecksPerYear("MONTHLY"), 12);
  });
});

describe("addPaycheckCadence / subtractPaycheckCadence", () => {
  test("BIWEEKLY is exactly +/- 14 days", () => {
    assert.deepEqual(addPaycheckCadence(utc(2026, 1, 2), "BIWEEKLY"), utc(2026, 1, 16));
    assert.deepEqual(subtractPaycheckCadence(utc(2026, 1, 16), "BIWEEKLY"), utc(2026, 1, 2));
  });

  test("SEMI_MONTHLY steps between the two pay days, never a 3rd paycheck in a 31-day month", () => {
    const days = [1, 15];
    assert.deepEqual(addPaycheckCadence(utc(2026, 10, 1), "SEMI_MONTHLY", days), utc(2026, 10, 15));
    // Used to be Oct 1 → 16 → 31: three paychecks projected into October.
    assert.deepEqual(addPaycheckCadence(utc(2026, 10, 15), "SEMI_MONTHLY", days), utc(2026, 11, 1));
    assert.deepEqual(addPaycheckCadence(utc(2026, 12, 15), "SEMI_MONTHLY", days), utc(2027, 1, 1));
    assert.deepEqual(subtractPaycheckCadence(utc(2026, 11, 1), "SEMI_MONTHLY", days), utc(2026, 10, 15));
    assert.deepEqual(subtractPaycheckCadence(utc(2027, 1, 1), "SEMI_MONTHLY", days), utc(2026, 12, 15));
  });

  test("SEMI_MONTHLY: 31 means the last day of the month", () => {
    const days = [15, 31];
    assert.deepEqual(addPaycheckCadence(utc(2026, 2, 15), "SEMI_MONTHLY", days), utc(2026, 2, 28));
    assert.deepEqual(addPaycheckCadence(utc(2026, 2, 28), "SEMI_MONTHLY", days), utc(2026, 3, 15));
    assert.deepEqual(addPaycheckCadence(utc(2026, 4, 15), "SEMI_MONTHLY", days), utc(2026, 4, 30));
    assert.deepEqual(subtractPaycheckCadence(utc(2026, 3, 15), "SEMI_MONTHLY", days), utc(2026, 2, 28));
  });

  test("SEMI_MONTHLY: a year of steps lands back on the same day (no drift)", () => {
    let d = utc(2026, 1, 1);
    for (let i = 0; i < 24; i++) d = addPaycheckCadence(d, "SEMI_MONTHLY", [1, 15]);
    assert.deepEqual(d, utc(2027, 1, 1));
  });

  test("SEMI_MONTHLY: an off-schedule date snaps onto the schedule", () => {
    // A row projected by the old "+15 days" math.
    assert.deepEqual(addPaycheckCadence(utc(2026, 10, 16), "SEMI_MONTHLY", [1, 15]), utc(2026, 11, 1));
  });

  test("SEMI_MONTHLY without stored days guesses a pair from the date", () => {
    assert.deepEqual(semiMonthlyDaysOrDefault([], utc(2026, 10, 1)), [1, 15]);
    assert.deepEqual(semiMonthlyDaysOrDefault(null, utc(2026, 10, 15)), [1, 15]);
    assert.deepEqual(semiMonthlyDaysOrDefault(null, utc(2026, 10, 31)), [15, 31]);
    assert.deepEqual(semiMonthlyDaysOrDefault(null, utc(2026, 10, 5)), [5, 20]);
    assert.deepEqual(semiMonthlyDaysOrDefault(null, utc(2026, 10, 22)), [7, 22]);
    // Stored days win, sorted; an invalid pair falls back.
    assert.deepEqual(semiMonthlyDaysOrDefault([20, 5], utc(2026, 10, 1)), [5, 20]);
    assert.deepEqual(semiMonthlyDaysOrDefault([15, 15], utc(2026, 10, 1)), [1, 15]);
    assert.deepEqual(addPaycheckCadence(utc(2026, 10, 1), "SEMI_MONTHLY"), utc(2026, 10, 15));
  });

  test("MONTHLY uses UTC month arithmetic", () => {
    assert.deepEqual(addPaycheckCadence(utc(2026, 1, 15), "MONTHLY"), utc(2026, 2, 15));
    assert.deepEqual(subtractPaycheckCadence(utc(2026, 3, 15), "MONTHLY"), utc(2026, 2, 15));
  });

  test("MONTHLY overshoots at a long-to-short month edge (documented, not a perfect inverse)", () => {
    // Jan 31 minus one month via setUTCMonth lands on a normalized March 3.
    assert.deepEqual(subtractPaycheckCadence(utc(2026, 1, 31), "MONTHLY"), utc(2025, 12, 31));
    assert.deepEqual(subtractPaycheckCadence(utc(2026, 3, 31), "MONTHLY"), utc(2026, 3, 3));
  });
});

describe("monthlyEquivalentCents", () => {
  test("MONTHLY_AVERAGE (default) annualizes then divides by 12", () => {
    assert.equal(monthlyEquivalentCents({ amountCents: 100_000, cadence: "BIWEEKLY" }), Math.round((100_000 * 26) / 12));
    assert.equal(monthlyEquivalentCents({ amountCents: 200_000, cadence: "MONTHLY" }), 200_000);
    assert.equal(monthlyEquivalentCents({ amountCents: 150_000, cadence: "SEMI_MONTHLY" }), 300_000);
  });

  test("BIWEEKLY_CONSERVATIVE assumes exactly 2 checks/month — but only for BIWEEKLY", () => {
    assert.equal(
      monthlyEquivalentCents({ amountCents: 100_000, cadence: "BIWEEKLY" }, "BIWEEKLY_CONSERVATIVE"),
      200_000,
    );
    // No effect on SEMI_MONTHLY / MONTHLY.
    assert.equal(
      monthlyEquivalentCents({ amountCents: 150_000, cadence: "SEMI_MONTHLY" }, "BIWEEKLY_CONSERVATIVE"),
      300_000,
    );
  });
});

describe("inferSemiMonthlyDays", () => {
  test("1st & 15th from real deposits (SimpleFIN demo payroll)", () => {
    const dates = [utc(2026, 7, 15), utc(2026, 8, 1), utc(2026, 8, 15), utc(2026, 9, 1), utc(2026, 9, 15), utc(2026, 10, 1)];
    assert.deepEqual(inferSemiMonthlyDays(dates), [1, 15]);
  });

  test("weekend-shifted paydays don't move the schedule", () => {
    // 15th paid on the 13th and 14th, the Aug 1st paid on Jul 31.
    const dates = [utc(2026, 6, 1), utc(2026, 6, 15), utc(2026, 7, 1), utc(2026, 7, 13), utc(2026, 7, 31), utc(2026, 8, 14), utc(2026, 9, 1), utc(2026, 9, 15)];
    // Jul 31 is July's last day (counts as 31), but the 1st still outnumbers it.
    assert.deepEqual(inferSemiMonthlyDays(dates), [1, 15]);
  });

  test("15th & last day, across months of different lengths", () => {
    const dates = [utc(2026, 1, 15), utc(2026, 1, 31), utc(2026, 2, 13), utc(2026, 2, 27), utc(2026, 3, 13), utc(2026, 3, 31), utc(2026, 4, 15), utc(2026, 4, 30)];
    assert.deepEqual(inferSemiMonthlyDays(dates), [15, 31]);
  });

  test("labels", () => {
    assert.equal(formatSemiMonthlyDays([1, 15]), "1st & 15th");
    assert.equal(formatSemiMonthlyDays([15, 31]), "15th & Last Day");
  });
});
