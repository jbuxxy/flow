import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  currentMonthOccurrenceOfDay,
  dayCountStatus,
  dayOfMonthUTC,
  dueDateProximity,
  dueStatus,
  expectedStatus,
  formatDate,
  formatISODate,
  nextOccurrenceOfDay,
  ordinal,
  todayAsUTCDate,
} from "@/lib/date";
import { utc } from "../helpers.ts";

describe("todayAsUTCDate", () => {
  test("anchors the caller's LOCAL calendar day to UTC midnight", () => {
    // A raw `new Date()` read via getUTC* would be Sep 1 here; todayAsUTCDate
    // must stay on Aug 31 (the whole 2026-08-31 TZ-sweep incident).
    const denverEvening = new Date("2026-08-31T23:30:00-06:00");
    const result = todayAsUTCDate(denverEvening);
    assert.equal(result.getUTCFullYear(), 2026);
    assert.equal(result.getUTCMonth(), 7); // August
    assert.equal(result.getUTCDate(), 31);
    assert.equal(result.getUTCHours(), 0);
  });

  test("defaults to now", () => {
    assert.ok(todayAsUTCDate() instanceof Date);
  });
});

describe("ordinal", () => {
  test("basic suffixes", () => {
    assert.equal(ordinal(1), "1st");
    assert.equal(ordinal(2), "2nd");
    assert.equal(ordinal(3), "3rd");
    assert.equal(ordinal(4), "4th");
  });

  test("the 11–13 exception", () => {
    assert.equal(ordinal(11), "11th");
    assert.equal(ordinal(12), "12th");
    assert.equal(ordinal(13), "13th");
    assert.equal(ordinal(111), "111th");
    assert.equal(ordinal(112), "112th");
    assert.equal(ordinal(113), "113th");
  });

  test("21/22/23 keep the normal suffix", () => {
    assert.equal(ordinal(21), "21st");
    assert.equal(ordinal(22), "22nd");
    assert.equal(ordinal(23), "23rd");
  });
});

describe("nextOccurrenceOfDay", () => {
  test("this month when the day has not passed (inclusive of today)", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    assert.deepEqual(nextOccurrenceOfDay(15, now), utc(2026, 3, 15));
    assert.deepEqual(nextOccurrenceOfDay(10, now), utc(2026, 3, 10)); // >= today
  });

  test("rolls to next month when the day has passed", () => {
    const now = new Date("2026-03-20T12:00:00Z");
    assert.deepEqual(nextOccurrenceOfDay(5, now), utc(2026, 4, 5));
  });

  test("clamps to the shorter month's real last day", () => {
    // From April, day 31 -> April 30 (clamped, and 30 >= today so no roll).
    const now = new Date("2026-04-01T12:00:00Z");
    assert.deepEqual(nextOccurrenceOfDay(31, now), utc(2026, 4, 30));
    // Roll into a shorter month: from Jan 31, day 30 has passed -> Feb, clamped to 28.
    const jan31 = new Date("2026-01-31T12:00:00Z");
    assert.deepEqual(nextOccurrenceOfDay(30, jan31), utc(2026, 2, 28));
  });
});

describe("currentMonthOccurrenceOfDay", () => {
  test("never rolls forward, clamps to month length", () => {
    const now = new Date("2026-02-25T12:00:00Z");
    assert.deepEqual(currentMonthOccurrenceOfDay(3, now), utc(2026, 2, 3)); // already passed, still Feb
    assert.deepEqual(currentMonthOccurrenceOfDay(31, now), utc(2026, 2, 28)); // clamp
  });
});

describe("dayCountStatus", () => {
  const copy = {
    overdue: (n: number) => `overdue ${n}`,
    today: "today",
    upcoming: (n: number) => `in ${n}`,
    later: () => "later",
  };
  const colors = { overdue: "o", today: "t", upcoming: "u", later: "l" };

  test("buckets by whole-day distance from today (UTC)", () => {
    const today = todayAsUTCDate();
    const plus = (days: number) => new Date(today.getTime() + days * 86_400_000);

    assert.equal(dayCountStatus(plus(-1), copy, colors).label, "overdue 1");
    assert.equal(dayCountStatus(plus(0), copy, colors).label, "today");
    assert.equal(dayCountStatus(plus(7), copy, colors).label, "in 7");
    assert.equal(dayCountStatus(plus(8), copy, colors).label, "later");
    assert.equal(dayCountStatus(plus(7), copy, colors).className, "u");
  });
});

describe("expectedStatus / dueStatus", () => {
  test("expectedStatus passes null through", () => {
    assert.equal(expectedStatus(null), null);
  });

  test("singular vs plural days", () => {
    const today = todayAsUTCDate();
    const oneDayAgo = new Date(today.getTime() - 86_400_000);
    assert.match(expectedStatus(oneDayAgo)!.label, /1 Day Ago$/);
    const twoDaysAgo = new Date(today.getTime() - 2 * 86_400_000);
    assert.match(expectedStatus(twoDaysAgo)!.label, /2 Days Ago$/);
  });

  test("dueStatus takes an ISO string", () => {
    const today = todayAsUTCDate();
    const iso = today.toISOString().slice(0, 10);
    assert.equal(dueStatus(iso).label, "Due today");
  });
});

describe("dueDateProximity", () => {
  test("overdue by 1 day is singular", () => {
    const today = todayAsUTCDate();
    const yesterday = new Date(today.getTime() - 86_400_000);
    assert.equal(dueDateProximity(yesterday).label, "Overdue by 1 day");
  });

  test("far-out dates read as a plain date", () => {
    const today = todayAsUTCDate();
    const far = new Date(today.getTime() + 40 * 86_400_000);
    assert.match(dueDateProximity(far).label, /^Not due until /);
  });
});

describe("formatDate / formatISODate", () => {
  test("upgrades day:'numeric' to two digits and anchors to UTC", () => {
    assert.equal(formatDate(utc(2026, 8, 1), { month: "short", day: "numeric" }), "Aug 01");
    assert.equal(formatISODate("2026-08-01", { month: "short", day: "numeric" }), "Aug 01");
  });
});

describe("dayOfMonthUTC", () => {
  test("reads the UTC day from an ISO date string", () => {
    assert.equal(dayOfMonthUTC("2026-08-01"), 1);
    assert.equal(dayOfMonthUTC("2026-12-31"), 31);
  });
});
