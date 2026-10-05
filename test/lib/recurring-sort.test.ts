import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { dueDayOf, patternDueDay, sortRecurring, type RecurringSortable } from "@/lib/recurring-sort";

const row = (sortName: string, dueDay: number | null, sinks = false): RecurringSortable => ({ sortName, dueDay, sinks });
const names = (rows: RecurringSortable[]) => rows.map((r) => r.sortName);

describe("dueDayOf", () => {
  test("reads the day straight off the ISO string", () => {
    assert.equal(dueDayOf("2026-10-01"), 1);
    assert.equal(dueDayOf("2026-09-28"), 28);
  });
  test("null/empty -> null", () => {
    assert.equal(dueDayOf(null), null);
    assert.equal(dueDayOf(""), null);
  });
});

describe("patternDueDay", () => {
  test("scheduled nextDueDate wins over the match window", () => {
    assert.equal(patternDueDay({ nextDueDate: "2026-10-25", dayOfMonthStart: 23 }), 25);
  });
  test("falls back to the window start, then null", () => {
    assert.equal(patternDueDay({ nextDueDate: null, dayOfMonthStart: 5 }), 5);
    assert.equal(patternDueDay({ nextDueDate: null, dayOfMonthStart: null }), null);
  });
});

describe("sortRecurring", () => {
  // Household report 2026-09-30: a pattern due the 1st rendered below a
  // bill due the 28th because patterns were a separate block appended
  // after bills+debts.
  test("interleaves every kind by day of month", () => {
    const sorted = sortRecurring(
      [row("Swim Lessons", 1), row("Tutoring", 28), row("Preschool", patternDueDay({ nextDueDate: "2026-10-01", dayOfMonthStart: null }))],
      "dueDate",
    );
    assert.deepEqual(names(sorted), ["Preschool", "Swim Lessons", "Tutoring"]);
  });
  test("same day ties break A–Z; undated rows go last", () => {
    assert.deepEqual(names(sortRecurring([row("Zed", 5), row("Undated", null), row("Alpha", 5)], "dueDate")), [
      "Alpha",
      "Zed",
      "Undated",
    ]);
  });
  test("sinking rows stay at the bottom in either order", () => {
    const rows = [row("Canceled", 1, true), row("B", 20), row("A", 30)];
    assert.deepEqual(names(sortRecurring(rows, "dueDate")), ["B", "A", "Canceled"]);
    assert.deepEqual(names(sortRecurring(rows, "alphabetical")), ["A", "B", "Canceled"]);
  });
  test("does not mutate its input", () => {
    const rows = [row("B", 2), row("A", 1)];
    sortRecurring(rows, "dueDate");
    assert.deepEqual(names(rows), ["B", "A"]);
  });
});
