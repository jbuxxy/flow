import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { catchupCycleWindow, fastForwardCycleDate, MATCH_WINDOW_DAYS } from "@/lib/bill-match-window";

const DAY_MS = 86_400_000;
const d = (iso: string) => new Date(iso);

describe("catchupCycleWindow", () => {
  test("a cycle not yet due gets a tight window centered on its own due date", () => {
    const cycleDue = d("2026-09-20T00:00:00.000Z");
    const nextCycleDue = d("2026-10-20T00:00:00.000Z");
    const now = d("2026-09-10T00:00:00.000Z"); // well before due
    const window = catchupCycleWindow(cycleDue, nextCycleDue, now);
    assert.ok(window);
    assert.equal(window!.windowStart.getTime(), cycleDue.getTime() - MATCH_WINDOW_DAYS * DAY_MS);
    assert.equal(window!.windowEnd.getTime(), cycleDue.getTime() + MATCH_WINDOW_DAYS * DAY_MS);
  });

  test("an overdue cycle widens its end up to now", () => {
    const cycleDue = d("2026-09-01T00:00:00.000Z");
    const nextCycleDue = d("2026-10-01T00:00:00.000Z");
    const now = d("2026-09-15T00:00:00.000Z"); // 2 weeks past due — well past MATCH_WINDOW_DAYS
    const window = catchupCycleWindow(cycleDue, nextCycleDue, now);
    assert.ok(window);
    assert.equal(window!.windowEnd.getTime(), now.getTime());
  });

  test("widening never bleeds into the next cycle's own window", () => {
    // Next cycle is only 5 days after this one (a short cadence), and "now"
    // is far in the future — the widened end must stay capped short of the
    // next cycle's own tight window, not reach all the way to `now`.
    const cycleDue = d("2026-09-01T00:00:00.000Z");
    const nextCycleDue = d("2026-09-06T00:00:00.000Z");
    const now = d("2026-12-01T00:00:00.000Z");
    const window = catchupCycleWindow(cycleDue, nextCycleDue, now);
    assert.ok(window);
    const cappedEnd = nextCycleDue.getTime() - MATCH_WINDOW_DAYS * DAY_MS - 1;
    assert.equal(window!.windowEnd.getTime(), cappedEnd);
    assert.ok(window!.windowEnd.getTime() < nextCycleDue.getTime() - MATCH_WINDOW_DAYS * DAY_MS + 1);
  });

  test("returns null for a degenerate cadence step (next cycle before this one)", () => {
    // A real cadence (WEEKLY, the shortest this app has, at 7 days) is
    // always more than 2*MATCH_WINDOW_DAYS apart, so the cap can never
    // actually fall before windowStart in practice — this is purely the
    // defensive guard against a broken/reversed cadence step, verified
    // directly since nothing in the normal loop is expected to hit it.
    const cycleDue = d("2026-09-20T00:00:00.000Z");
    const nextCycleDue = d("2026-09-15T00:00:00.000Z"); // before cycleDue
    const now = d("2026-09-20T00:00:00.000Z");
    const window = catchupCycleWindow(cycleDue, nextCycleDue, now);
    assert.equal(window, null);
  });

  test("a custom matchWindowDays is honored", () => {
    const cycleDue = d("2026-09-20T00:00:00.000Z");
    const nextCycleDue = d("2026-11-20T00:00:00.000Z");
    const now = d("2026-09-01T00:00:00.000Z");
    const window = catchupCycleWindow(cycleDue, nextCycleDue, now, 10);
    assert.ok(window);
    assert.equal(window!.windowStart.getTime(), cycleDue.getTime() - 10 * DAY_MS);
    assert.equal(window!.windowEnd.getTime(), cycleDue.getTime() + 10 * DAY_MS);
  });
});

describe("fastForwardCycleDate", () => {
  // Extracted from matchBillPayments/matchPatternPayments/matchIncomePayments'
  // own hand-copied self-heal loops (2026-09-22 code review) — one regression
  // test for the shared shape instead of three untested copies.
  const weekly = (date: Date) => new Date(date.getTime() + 7 * DAY_MS);

  test("advances one cadence step at a time until past paidThroughMs", () => {
    const start = d("2026-09-01T00:00:00.000Z");
    const paidThroughMs = d("2026-09-10T00:00:00.000Z").getTime(); // between +1 and +2 weeks
    const result = fastForwardCycleDate(start, paidThroughMs, 24, weekly);
    // 2026-09-01 -> 09-08 (still <= paidThrough) -> 09-15 (> paidThrough, stop)
    assert.equal(result.getTime(), d("2026-09-15T00:00:00.000Z").getTime());
  });

  test("a no-op when the cycle date is already past paidThroughMs", () => {
    const start = d("2026-09-20T00:00:00.000Z");
    const paidThroughMs = d("2026-09-10T00:00:00.000Z").getTime();
    const result = fastForwardCycleDate(start, paidThroughMs, 24, weekly);
    assert.equal(result.getTime(), start.getTime());
  });

  test("never exceeds maxCycles even when paidThroughMs is far in the future", () => {
    const start = d("2026-01-01T00:00:00.000Z");
    const paidThroughMs = d("2030-01-01T00:00:00.000Z").getTime(); // hundreds of weeks away
    const maxCycles = 5;
    const result = fastForwardCycleDate(start, paidThroughMs, maxCycles, weekly);
    assert.equal(result.getTime(), start.getTime() + maxCycles * 7 * DAY_MS);
  });

  test("is cadence-agnostic — works with a variable-length monthly-style step", () => {
    // A stand-in for nextBillDueDate's own MONTHLY calendar-day-anchored step
    // (variable interval, not a fixed number of ms) — fastForwardCycleDate
    // must not assume a constant step size.
    const monthly = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
    const start = d("2026-01-15T00:00:00.000Z");
    const paidThroughMs = d("2026-03-01T00:00:00.000Z").getTime();
    const result = fastForwardCycleDate(start, paidThroughMs, 24, monthly);
    // Jan 15 -> Feb 15 (<= paidThrough) -> Mar 15 (> paidThrough, stop)
    assert.equal(result.getTime(), d("2026-03-15T00:00:00.000Z").getTime());
  });
});
