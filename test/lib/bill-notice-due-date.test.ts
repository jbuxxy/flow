import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  billNoticeDueDateUpdate,
  confirmedDebtDueDate,
  debtDueDateDismissKey,
  dueDayDiffers,
} from "@/lib/bill-notice-due-date";
import { utc } from "../helpers.ts";

describe("dueDayDiffers", () => {
  test("a different day-of-month differs", () => {
    // Real report, 2026-10-19: a card statement due the 22nd, tracked the 4th.
    assert.equal(dueDayDiffers(utc(2026, 10, 22), utc(2026, 12, 4)), true);
  });

  test("the same day in a different month doesn't", () => {
    assert.equal(dueDayDiffers(utc(2026, 10, 22), utc(2026, 11, 22)), false);
  });

  test("month-end clamping is the same day either way", () => {
    assert.equal(dueDayDiffers(utc(2026, 10, 31), utc(2026, 11, 30)), false); // 31st tracked as Nov 30
    assert.equal(dueDayDiffers(utc(2027, 2, 28), utc(2027, 3, 31)), false); // 31st-due statement in Feb
    assert.equal(dueDayDiffers(utc(2026, 12, 30), utc(2027, 1, 31)), true); // a real 30th vs 31st (both months have both)
  });
});

describe("confirmedDebtDueDate", () => {
  const today = utc(2026, 10, 19);

  test("a payment after the statement arrived paid it — next is one month on", () => {
    assert.deepEqual(
      confirmedDebtDueDate({ observedDueDate: utc(2026, 10, 22), statementDate: utc(2026, 9, 30), lastPaidDate: utc(2026, 10, 8), today }),
      utc(2026, 11, 22),
    );
  });

  test("an unpaid statement still upcoming is itself the next due date", () => {
    assert.deepEqual(
      confirmedDebtDueDate({ observedDueDate: utc(2026, 10, 22), statementDate: utc(2026, 9, 30), lastPaidDate: utc(2026, 9, 10), today }),
      utc(2026, 10, 22),
    );
  });

  test("a statement whose due date has passed rolls to the first upcoming occurrence, keeping a 31st anchor", () => {
    assert.deepEqual(
      confirmedDebtDueDate({ observedDueDate: utc(2026, 8, 31), statementDate: utc(2026, 8, 5), lastPaidDate: null, today }),
      utc(2026, 10, 31),
    );
  });
});

describe("billNoticeDueDateUpdate", () => {
  const today = utc(2026, 10, 19);

  test("an upcoming due date a few days off the tracked one replaces it", () => {
    assert.deepEqual(billNoticeDueDateUpdate(utc(2026, 10, 25), utc(2026, 10, 22), today), utc(2026, 10, 25));
  });

  test("no change, no date, or a past notice leaves the bill alone", () => {
    assert.equal(billNoticeDueDateUpdate(utc(2026, 10, 22), utc(2026, 10, 22), today), null);
    assert.equal(billNoticeDueDateUpdate(null, utc(2026, 10, 22), today), null);
    assert.equal(billNoticeDueDateUpdate(utc(2026, 10, 15), utc(2026, 10, 18), today), null);
  });

  test("a notice for a cycle the tracker already rolled past is a different cycle", () => {
    // Paid Oct 22 Verizon bill; tracker now on Nov 22; the Oct notice says Oct 22.
    assert.equal(billNoticeDueDateUpdate(utc(2026, 10, 22), utc(2026, 11, 22), today), null);
  });
});

test("debtDueDateDismissKey is per tracker per day", () => {
  assert.equal(debtDueDateDismissKey("dp1", utc(2026, 10, 22)), "dp1:22");
  assert.equal(debtDueDateDismissKey("dp1", utc(2026, 11, 22)), "dp1:22");
});
