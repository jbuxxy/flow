import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { logBillDueDateChange } from "@/lib/bill-due-date-log";

describe("logBillDueDateChange", () => {
  test("no row when the due date didn't move", () => {
    const d = new Date("2026-10-22T00:00:00Z");
    assert.equal(logBillDueDateChange({ id: "b", householdId: "h" }, d, new Date(d), "EDIT_FORM"), null);
  });
});
