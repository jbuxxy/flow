import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  currentDateKey,
  currentPeriodKey,
  currentWeekBounds,
  currentWeekKey,
  daysAgo,
  monthElapsedFraction,
  periodBounds,
  periodKeyOfUTCDate,
  utcPeriodBounds,
} from "@/lib/period";
import { utc } from "../helpers.ts";

describe("currentPeriodKey / currentDateKey", () => {
  test("zero-pads month and day, reads local time", () => {
    const d = new Date("2026-03-05T12:00:00Z"); // noon UTC => same calendar day in Denver
    assert.equal(currentPeriodKey(d), "2026-03");
    assert.equal(currentDateKey(d), "2026-03-05");
  });
});

describe("periodBounds vs utcPeriodBounds", () => {
  test("utcPeriodBounds is UTC-midnight month bounds, end exclusive", () => {
    const { start, end } = utcPeriodBounds("2026-02");
    assert.deepEqual(start, utc(2026, 2, 1));
    assert.deepEqual(end, utc(2026, 3, 1));
  });

  test("periodBounds is local-time — start is not UTC midnight in Denver", () => {
    const { start, end } = periodBounds("2026-02");
    // America/Denver is behind UTC, so local midnight Feb 1 is 07:00Z Feb 1.
    assert.equal(start.getUTCHours(), 7);
    assert.equal(end.getUTCMonth(), 2); // March
  });
});

describe("periodKeyOfUTCDate", () => {
  test("reads a UTC-midnight @db.Date value's own calendar month, not the server's local reinterpretation", () => {
    // The 2026-09-11 bug this guards: currentPeriodKey(t.occurredOn) read
    // this via local getters and, in a timezone behind UTC, walked a 1st-
    // of-the-month value back into the previous month.
    assert.equal(periodKeyOfUTCDate(utc(2026, 9, 1)), "2026-09");
    assert.equal(periodKeyOfUTCDate(utc(2026, 8, 31)), "2026-08");
  });
});

describe("monthElapsedFraction", () => {
  test("day 1 of a 31-day month", () => {
    assert.ok(Math.abs(monthElapsedFraction(new Date("2026-01-01T12:00:00Z")) - 1 / 31) < 1e-9);
  });

  test("clamps at 1 on the last day", () => {
    assert.equal(monthElapsedFraction(new Date("2026-02-28T12:00:00Z")), 1);
  });
});

describe("currentWeekBounds / currentWeekKey", () => {
  test("Sunday–Sunday, UTC-midnight bounds, end exclusive", () => {
    // 2026-03-11 is a Wednesday; that week's Sunday is 2026-03-08.
    const wed = new Date("2026-03-11T12:00:00Z");
    const { start, end } = currentWeekBounds(wed);
    assert.deepEqual(start, utc(2026, 3, 8));
    assert.deepEqual(end, utc(2026, 3, 15));
    assert.equal(currentWeekKey(wed), "2026-03-08");
  });

  test("a date that is already Sunday is its own week start", () => {
    const sun = new Date("2026-03-08T12:00:00Z");
    assert.deepEqual(currentWeekBounds(sun).start, utc(2026, 3, 8));
  });

  test("handles a week that crosses a month boundary", () => {
    // 2026-04-02 is a Thursday; its Sunday is 2026-03-29.
    const thu = new Date("2026-04-02T12:00:00Z");
    assert.deepEqual(currentWeekBounds(thu).start, utc(2026, 3, 29));
    assert.deepEqual(currentWeekBounds(thu).end, utc(2026, 4, 5));
  });
});

describe("daysAgo", () => {
  test("n days before now", () => {
    const before = Date.now();
    const d = daysAgo(3);
    const after = Date.now();
    assert.ok(d.getTime() >= before - 3 * 86_400_000 - 5);
    assert.ok(d.getTime() <= after - 3 * 86_400_000 + 5);
  });
});
