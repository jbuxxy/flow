import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { addCadenceISO } from "@/lib/cadence-label";
import { excludeFromBucketHistory } from "@/lib/bucket-composition";
import { occurrencesInPeriod } from "@/lib/cycle-slots";

// Household report 2026-09-30: a yearly Usenet subscription (paid 2026-09-29)
// switched Monthly -> Yearly in BillRow's edit form kept its one-month-out
// due date, and its $12 charge inflated the budget plan's history.
describe("addCadenceISO", () => {
  test("yearly re-projects a full year past the last payment", () => {
    assert.equal(addCadenceISO("2026-09-29", "ANNUAL"), "2027-09-29");
  });
  test("monthly/biweekly/weekly match addCadence", () => {
    assert.equal(addCadenceISO("2026-09-29", "MONTHLY"), "2026-10-29");
    assert.equal(addCadenceISO("2026-09-29", "BIWEEKLY"), "2026-10-13");
    assert.equal(addCadenceISO("2026-09-29", "WEEKLY"), "2026-10-06");
  });
  test("accepts a full ISO timestamp", () => {
    assert.equal(addCadenceISO("2026-09-29T00:00:00.000Z", "ANNUAL"), "2027-09-29");
  });
});

describe("excludeFromBucketHistory", () => {
  test("drops yearly bill payments from RECURRING and MIXED buckets", () => {
    assert.equal(excludeFromBucketHistory("RECURRING", "ANNUAL"), true);
    assert.equal(excludeFromBucketHistory("MIXED", "ANNUAL"), true);
  });
  test("keeps them in a SPEND bucket (no projection would add them back)", () => {
    assert.equal(excludeFromBucketHistory("SPEND", "ANNUAL"), false);
  });
  test("keeps non-yearly bills and non-bill spend", () => {
    assert.equal(excludeFromBucketHistory("RECURRING", "MONTHLY"), false);
    assert.equal(excludeFromBucketHistory("MIXED", null), false);
    assert.equal(excludeFromBucketHistory(undefined, "ANNUAL"), false);
  });
  test("the projection adds a yearly bill back only in its due month", () => {
    const next = new Date(Date.UTC(2027, 8, 29));
    const oct = occurrencesInPeriod(next, "ANNUAL", new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 10, 1)));
    const sep = occurrencesInPeriod(next, "ANNUAL", new Date(Date.UTC(2027, 8, 1)), new Date(Date.UTC(2027, 9, 1)));
    assert.equal(oct.length, 0);
    assert.equal(sep.length, 1);
  });
});
