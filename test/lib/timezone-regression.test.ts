// The "everything shows a day ahead" bug, pinned.
//
// The server runs TZ=America/Denver (UTC-6/-7). In the household's evening,
// a raw `new Date()` read through getUTC*/toISOString is ALREADY on tomorrow's
// calendar day — and, on the last evening of a month, in next month. That has
// broken the payoff calendar, "this week's bills", income "expected this
// month", the paid checkmark, and net-worth day keys, repeatedly
// (WORKING_ON.md: 2026-08-14, 2026-08-31 x3, 2026-09-07, ...).
//
// The rule (WORKING_ON.md "Core data conventions"): "what day is it now" is the
// household's LOCAL calendar day; when that day then has to line up with a
// `@db.Date` column (UTC midnight), anchor it with todayAsUTCDate() — NEVER
// `new Date()` + getUTC*.
//
// scripts/test.sh sets TZ=America/Denver so these assertions exercise the real
// boundary. This suite changes no source — it locks the current, correct
// behavior so the next "day ahead" regression fails here first.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { currentMonthOccurrenceOfDay, nextOccurrenceOfDay, todayAsUTCDate } from "@/lib/date";
import { currentDateKey, currentPeriodKey, currentWeekBounds, currentWeekKey } from "@/lib/period";
import { utc } from "../helpers.ts";

// 2026-08-31, 22:00 in Denver (MDT, UTC-6) === 2026-09-01T04:00:00Z.
// The classic failure instant: local day is still Aug 31; UTC day is Sep 1.
const denverEveningLastOfMonth = new Date("2026-09-01T04:00:00Z");

describe("the raw-new-Date() hazard is real here", () => {
  test("with TZ=America/Denver, this instant is 'tomorrow' (and next month) in UTC", () => {
    assert.equal(denverEveningLastOfMonth.getUTCFullYear(), 2026);
    assert.equal(denverEveningLastOfMonth.getUTCMonth(), 8); // September — the wrong month
    assert.equal(denverEveningLastOfMonth.getUTCDate(), 1); // the 1st — the wrong day
    // ...while the household's own clock still says August 31.
    assert.equal(denverEveningLastOfMonth.getMonth(), 7); // August
    assert.equal(denverEveningLastOfMonth.getDate(), 31);
  });
});

describe("todayAsUTCDate stays on the household's calendar day", () => {
  test("Denver evening on the last of the month -> Aug 31 UTC midnight, NOT Sep 1", () => {
    const today = todayAsUTCDate(denverEveningLastOfMonth);
    assert.deepEqual(today, utc(2026, 8, 31));
    assert.equal(today.getUTCHours(), 0);
    // The bug would have produced this:
    assert.notDeepEqual(today, utc(2026, 9, 1));
  });

  test("an early-morning UTC instant that is still 'yesterday' in Denver also holds", () => {
    // 2026-03-02T02:00Z === 2026-03-01 19:00 MST in Denver.
    const t = todayAsUTCDate(new Date("2026-03-02T02:00:00Z"));
    assert.deepEqual(t, utc(2026, 3, 1));
  });
});

describe("period / week keys read the household clock, not UTC", () => {
  test("currentPeriodKey / currentDateKey at the Denver-evening month edge", () => {
    assert.equal(currentPeriodKey(denverEveningLastOfMonth), "2026-08"); // not "2026-09"
    assert.equal(currentDateKey(denverEveningLastOfMonth), "2026-08-31"); // not "2026-09-01"
  });

  test("currentWeekBounds / currentWeekKey don't slide a week forward in the evening", () => {
    // 2026-08-31 is a Monday in Denver; that week's Sunday is 2026-08-30.
    const { start, end } = currentWeekBounds(denverEveningLastOfMonth);
    assert.deepEqual(start, utc(2026, 8, 30));
    assert.deepEqual(end, utc(2026, 9, 6));
    assert.equal(currentWeekKey(denverEveningLastOfMonth), "2026-08-30");
  });
});

describe("due-date resolution doesn't skip a cycle in the evening", () => {
  test("nextOccurrenceOfDay: the 31st, evening of the 31st -> today, not next month", () => {
    // 31 >= today(31) in the household's clock, so it resolves to THIS month.
    assert.deepEqual(nextOccurrenceOfDay(31, denverEveningLastOfMonth), utc(2026, 8, 31));
  });

  test("currentMonthOccurrenceOfDay: still August's occurrence", () => {
    assert.deepEqual(currentMonthOccurrenceOfDay(15, denverEveningLastOfMonth), utc(2026, 8, 15));
    assert.deepEqual(currentMonthOccurrenceOfDay(31, denverEveningLastOfMonth), utc(2026, 8, 31));
  });
});
