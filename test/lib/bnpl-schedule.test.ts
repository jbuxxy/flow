import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildBnplSchedule } from "@/lib/bnpl-schedule";

const base = {
  installmentsTotal: 4,
  installmentsRemaining: 2,
  paymentCents: 2500,
  balanceCents: 5000,
  nextDueDate: "2026-10-15",
  cadence: "BIWEEKLY" as const,
  paidPayments: [
    { date: "2026-09-17", amountCents: 2500 },
    { date: "2026-10-01", amountCents: 2500 },
  ],
};

describe("buildBnplSchedule", () => {
  test("mid-plan: paid rows from matches, next + upcoming projected", () => {
    assert.deepEqual(buildBnplSchedule(base), [
      { number: 1, date: "2026-09-17", amountCents: 2500, status: "PAID" },
      { number: 2, date: "2026-10-01", amountCents: 2500, status: "PAID" },
      { number: 3, date: "2026-10-15", amountCents: 2500, status: "NEXT" },
      { number: 4, date: "2026-10-29", amountCents: 2500, status: "UPCOMING" },
    ]);
  });

  test("fully paid: every row PAID, nothing projected", () => {
    const rows = buildBnplSchedule({ ...base, installmentsRemaining: 0, balanceCents: 0, paidPayments: [] });
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.status === "PAID"));
  });

  test("$0 balance counts as paid off even if the counter lags", () => {
    const rows = buildBnplSchedule({ ...base, balanceCents: 0 });
    assert.ok(rows.every((r) => r.status === "PAID"));
  });

  test("paid installments without a matched charge come first, undated", () => {
    const rows = buildBnplSchedule({ ...base, paidPayments: [{ date: "2026-10-01", amountCents: 2600 }] });
    assert.deepEqual(rows.slice(0, 2), [
      { number: 1, date: null, amountCents: 2500, status: "PAID" },
      { number: 2, date: "2026-10-01", amountCents: 2600, status: "PAID" },
    ]);
  });

  test("extra matches beyond the paid count keep only the newest", () => {
    const rows = buildBnplSchedule({
      ...base,
      paidPayments: [{ date: "2026-09-01", amountCents: 999 }, ...base.paidPayments],
    });
    assert.equal(rows[0].date, "2026-09-17");
  });

  test("last installment absorbs the rounding remainder", () => {
    const rows = buildBnplSchedule({
      ...base,
      installmentsTotal: 3,
      installmentsRemaining: 3,
      paymentCents: 3333,
      balanceCents: 10000,
      paidPayments: [],
    });
    assert.deepEqual(rows.map((r) => r.amountCents), [3333, 3333, 3334]);
  });

  test("a wildly off balance doesn't distort the last payment", () => {
    const rows = buildBnplSchedule({ ...base, balanceCents: 50000 });
    assert.equal(rows.at(-1)!.amountCents, 2500);
  });

  test("monthly from the 31st chains like the server's addCadence", () => {
    const rows = buildBnplSchedule({
      ...base,
      cadence: "MONTHLY",
      nextDueDate: "2027-01-31",
      installmentsRemaining: 2,
    });
    assert.deepEqual(rows.slice(2).map((r) => r.date), ["2027-01-31", "2027-03-03"]);
  });

  test("no total or no next due date: nothing projected", () => {
    assert.deepEqual(buildBnplSchedule({ ...base, installmentsTotal: null }), []);
    assert.equal(buildBnplSchedule({ ...base, nextDueDate: null }).length, 2);
  });
});
