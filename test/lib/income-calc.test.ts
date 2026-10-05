import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addPaycheckCadence,
  monthlyEquivalentCents,
  paychecksPerYear,
  subtractPaycheckCadence,
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

  test("SEMI_MONTHLY is the +/- 15 day approximation", () => {
    assert.deepEqual(addPaycheckCadence(utc(2026, 1, 1), "SEMI_MONTHLY"), utc(2026, 1, 16));
    assert.deepEqual(addPaycheckCadence(utc(2026, 1, 16), "SEMI_MONTHLY"), utc(2026, 1, 31));
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
