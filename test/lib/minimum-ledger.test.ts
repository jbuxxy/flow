import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { coveredMinimumDates, ledgerMinimumCents, openMinimumDates, resolveMinimumLedger, minimumOwedCents, tracksMinimum } from "@/lib/minimum-ledger";
import { utc } from "../helpers.ts";

const pay = (id: string, cents: number, d: Date) => ({ id, amountCents: cents, occurredOn: d });
const none = new Set<string>();

describe("resolveMinimumLedger", () => {
  const due = utc(2026, 9, 27);

  test("a bigger payment ahead of the due date leaves the minimum listed as covered (Venture $177 vs $84)", () => {
    const big = pay("p1", 17_700, utc(2026, 9, 18));
    const { entries, extraPayments } = resolveMinimumLedger({
      slots: [{ date: due, payment: big }],
      extraPayments: [],
      minimumCents: 8_400,
      skippedDates: none,
    });
    assert.deepEqual(entries, [
      { kind: "payment", payment: big },
      { kind: "covered", date: due, skipped: false },
    ]);
    assert.deepEqual(extraPayments, []);
  });

  test("a skipped covered minimum is flagged skipped", () => {
    const { entries } = resolveMinimumLedger({
      slots: [{ date: due, payment: pay("p1", 17_700, utc(2026, 9, 18)) }],
      extraPayments: [],
      minimumCents: 8_400,
      skippedDates: new Set(["2026-09-27"]),
    });
    assert.deepEqual(entries[1], { kind: "covered", date: due, skipped: true });
  });

  test("a payment about equal to the minimum, even early, is just the slot's payment", () => {
    const p = pay("p1", 8_400, utc(2026, 9, 18));
    const { entries } = resolveMinimumLedger({ slots: [{ date: due, payment: p }], extraPayments: [], minimumCents: 8_400, skippedDates: none });
    assert.deepEqual(entries, [{ kind: "payment", payment: p }]);
  });

  test("a big payment on or after the due date is the slot's payment, not an early overpayment", () => {
    const p = pay("p1", 17_700, utc(2026, 9, 27));
    const { entries } = resolveMinimumLedger({ slots: [{ date: due, payment: p }], extraPayments: [], minimumCents: 8_400, skippedDates: none });
    assert.deepEqual(entries, [{ kind: "payment", payment: p }]);
  });

  test("the regular minimum arriving on the due date ticks the covered line off", () => {
    const big = pay("p1", 17_700, utc(2026, 9, 18));
    const regular = pay("p2", 8_400, utc(2026, 9, 27));
    const { entries, extraPayments } = resolveMinimumLedger({
      slots: [{ date: due, payment: big }],
      extraPayments: [regular],
      minimumCents: 8_400,
      skippedDates: none,
    });
    assert.deepEqual(entries, [
      { kind: "payment", payment: big },
      { kind: "payment", payment: regular },
    ]);
    assert.deepEqual(extraPayments, []);
  });

  test("an unrelated small or early extra payment doesn't tick it off and stays an extra", () => {
    const big = pay("p1", 17_700, utc(2026, 9, 18));
    const small = pay("p2", 2_000, utc(2026, 9, 26));
    const early = pay("p3", 8_400, utc(2026, 9, 20));
    const { entries, extraPayments } = resolveMinimumLedger({
      slots: [{ date: due, payment: big }],
      extraPayments: [small, early],
      minimumCents: 8_400,
      skippedDates: none,
    });
    assert.equal(entries[1].kind, "covered");
    assert.deepEqual(extraPayments.map((e) => e.id), ["p3", "p2"]); // date-sorted, both untouched
  });

  test("an unpaid slot is an ordinary open line — no covered/skip state", () => {
    const { entries } = resolveMinimumLedger({ slots: [{ date: due, payment: null }], extraPayments: [], minimumCents: 8_400, skippedDates: new Set(["2026-09-27"]) });
    assert.deepEqual(entries, [{ kind: "open", date: due }]);
  });

  test("a no-minimum debt never produces a covered line", () => {
    const { entries } = resolveMinimumLedger({ slots: [{ date: due, payment: pay("p1", 17_700, utc(2026, 9, 18)) }], extraPayments: [], minimumCents: 0, skippedDates: none });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "payment");
  });
});

describe("open slot covered by a payoff-plan extra", () => {
  // Amazon Card, 2026-10-11: a $108.33 plan extra on Oct 2 (kept out of the
  // slot by splitPlanExtraPayments) against a $35 minimum due Oct 10.
  const due = utc(2026, 10, 10);
  const extra = pay("x1", 10_833, utc(2026, 10, 2));
  const opts = { slots: [{ date: due, payment: null }], extraPayments: [extra], minimumCents: 3_500, skippedDates: none };

  test("reads as covered (skippable), and the extra stays its own line", () => {
    const { entries, extraPayments } = resolveMinimumLedger(opts);
    assert.deepEqual(entries, [{ kind: "covered", date: due, skipped: false }]);
    assert.deepEqual(extraPayments, [extra]);
    assert.deepEqual(openMinimumDates(opts), []);
    assert.deepEqual(coveredMinimumDates(opts), [due]);
  });

  test("skipped: neither open nor a calendar cell", () => {
    const skipped = { ...opts, skippedDates: new Set(["2026-10-10"]) };
    assert.deepEqual(openMinimumDates(skipped), []);
    assert.deepEqual(coveredMinimumDates(skipped), []);
  });

  test("stays open when the extra is small, on/after the due date, or the cycle is in arrears", () => {
    const open = [{ kind: "open", date: due }];
    assert.deepEqual(resolveMinimumLedger({ ...opts, extraPayments: [pay("x", 3_600, utc(2026, 10, 2))] }).entries, open);
    assert.deepEqual(resolveMinimumLedger({ ...opts, extraPayments: [pay("x", 10_833, due)] }).entries, open);
    assert.deepEqual(resolveMinimumLedger({ ...opts, minimumCents: 0 }).entries, open);
  });

  test("one extra covers one slot, and only one landing since the previous slot", () => {
    const first = utc(2026, 10, 3);
    const second = utc(2026, 10, 17);
    const twoSlots = { ...opts, slots: [{ date: first, payment: null }, { date: second, payment: null }], extraPayments: [pay("x", 10_833, utc(2026, 10, 1))] };
    assert.deepEqual(resolveMinimumLedger(twoSlots).entries, [
      { kind: "covered", date: first, skipped: false },
      { kind: "open", date: second },
    ]);
  });
});

describe("coveredMinimumDates (calendars)", () => {
  const due = utc(2026, 9, 27);
  const covering = { id: "p1", amountCents: 17_700, occurredOn: utc(2026, 9, 18) };
  const base = { slots: [{ date: due, payment: covering }], extraPayments: [], minimumCents: 8_400 };

  test("a covered minimum stays on the calendar (Venture Sep 27)", () => {
    assert.deepEqual(coveredMinimumDates({ ...base, skippedDates: new Set() }), [due]);
  });

  test("a skipped covered minimum is omitted", () => {
    assert.deepEqual(coveredMinimumDates({ ...base, skippedDates: new Set(["2026-09-27"]) }), []);
  });

  test("once the regular minimum posts, the calendar cell is the payment, not a second due cell", () => {
    const regular = { id: "p2", amountCents: 8_400, occurredOn: utc(2026, 9, 27) };
    assert.deepEqual(coveredMinimumDates({ ...base, extraPayments: [regular], skippedDates: new Set() }), []);
  });

  test("an ordinary paid-on-time slot never produces a calendar cell", () => {
    const onTime = { id: "p1", amountCents: 8_400, occurredOn: utc(2026, 9, 25) };
    assert.deepEqual(
      coveredMinimumDates({ slots: [{ date: due, payment: onTime }], extraPayments: [], minimumCents: 8_400, skippedDates: new Set() }),
      [],
    );
  });
});

describe("ledgerMinimumCents", () => {
  const ok = { paidOff: false, nextDueThisMonth: true, amountDueCents: 0, minimumCents: 8_400 };

  test("satisfied cycle keeps the minimum", () => {
    assert.equal(ledgerMinimumCents(ok), 8_400);
  });

  test("arrears on this month's due date disable covered (never skippable)", () => {
    assert.equal(ledgerMinimumCents({ ...ok, amountDueCents: 8_400 }), 0);
  });

  test("next month's fresh amountDue after rollover doesn't disable it", () => {
    assert.equal(ledgerMinimumCents({ ...ok, nextDueThisMonth: false, amountDueCents: 8_400 }), 8_400);
  });

  test("paid off disables it", () => {
    assert.equal(ledgerMinimumCents({ ...ok, paidOff: true }), 0);
  });
});

describe("minimumOwedCents", () => {
  const card = (balanceCents: number) => ({ balanceCents, aprBasisPoints: 0, debtType: "REVOLVING" });

  test("the regular minimum, or arrears when larger — never the caught-up $0", () => {
    assert.equal(minimumOwedCents({ amountDueCents: 0, amountCents: 6500 }, card(50000)), 6500);
    assert.equal(minimumOwedCents({ amountDueCents: 9000, amountCents: 6500 }, card(50000)), 9000);
  });

  test("capped at the payoff amount", () => {
    // 2026-10-09: PayPal Credit, $65 minimum, $59.27 left.
    assert.equal(minimumOwedCents({ amountDueCents: 0, amountCents: 6500 }, card(5927)), 5927);
    assert.equal(minimumOwedCents({ amountDueCents: 9000, amountCents: 6500 }, card(5927)), 5927);
  });
});


describe("tracksMinimum", () => {
  test("needs both: not flagged no-minimum, and an amount above $0", () => {
    assert.equal(tracksMinimum({ ignoreMinimumPayment: false }, { amountCents: 2500 }), true);
    assert.equal(tracksMinimum({ ignoreMinimumPayment: true }, { amountCents: 2500 }), false);
    // Regression (2026-10-09): a returned balance clears the flag before a
    // minimum is entered — /debts said "tracks", the calendars said not.
    assert.equal(tracksMinimum({ ignoreMinimumPayment: false }, { amountCents: 0 }), false);
  });
});
