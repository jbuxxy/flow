import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assignPaymentsToSlots,
  buildCycleSlots,
  cycleDueDate,
  cyclePaymentStatus,
  extraPaymentsBeyondSlots,
  occurrencesInPeriod,
  slotBounds,
} from "@/lib/cycle-slots";
import { utc } from "../helpers.ts";

const pay = (iso: string, amountCents = 0) => ({ occurredOn: new Date(iso), amountCents });

describe("occurrencesInPeriod", () => {
  test("a bill due the 31st still has a February occurrence", () => {
    // Regression: the chained raw setUTCMonth walk went Jan 31 -> Mar 3, so
    // February had none (2026-10-08 review).
    assert.deepEqual(occurrencesInPeriod(utc(2027, 1, 31), "MONTHLY", utc(2027, 2, 1), utc(2027, 3, 1)), [
      utc(2027, 2, 28),
    ]);
    // Walking several months doesn't stick at the clamped 28th.
    assert.deepEqual(occurrencesInPeriod(utc(2027, 1, 31), "MONTHLY", utc(2027, 3, 1), utc(2027, 4, 1)), [
      utc(2027, 3, 31),
    ]);
    // ...nor walking backward from a later 31st.
    assert.deepEqual(occurrencesInPeriod(utc(2027, 3, 31), "MONTHLY", utc(2027, 1, 1), utc(2027, 2, 1)), [
      utc(2027, 1, 31),
    ]);
  });

  test("MONTHLY yields the one occurrence in the period", () => {
    const dates = occurrencesInPeriod(utc(2026, 3, 15), "MONTHLY", utc(2026, 3, 1), utc(2026, 4, 1));
    assert.deepEqual(dates, [utc(2026, 3, 15)]);
  });

  test("WEEKLY yields several", () => {
    const dates = occurrencesInPeriod(utc(2026, 3, 9), "WEEKLY", utc(2026, 3, 1), utc(2026, 4, 1));
    assert.deepEqual(dates, [utc(2026, 3, 2), utc(2026, 3, 9), utc(2026, 3, 16), utc(2026, 3, 23), utc(2026, 3, 30)]);
  });

  test("recovers 'this period, now paid' when nextDueDate already rolled forward", () => {
    // Bill paid for March, nextDueDate now points at April — the backward walk
    // still finds March's occurrence for the March period.
    const dates = occurrencesInPeriod(utc(2026, 4, 15), "MONTHLY", utc(2026, 3, 1), utc(2026, 4, 1));
    assert.deepEqual(dates, [utc(2026, 3, 15)]);
  });

  test("ANNUAL yields nothing in a month it does not land in", () => {
    const dates = occurrencesInPeriod(utc(2026, 7, 4), "ANNUAL", utc(2026, 3, 1), utc(2026, 4, 1));
    assert.deepEqual(dates, []);
  });
});

describe("assignPaymentsToSlots", () => {
  test("pairs the Nth payment (date order) to the Nth slot", () => {
    const slots = assignPaymentsToSlots(
      [utc(2026, 3, 2), utc(2026, 3, 9)],
      [pay("2026-03-10"), pay("2026-03-03")],
    );
    assert.deepEqual(slots.map((s) => s.payment?.occurredOn), [new Date("2026-03-03"), new Date("2026-03-10")]);
  });

  test("unfilled slots get null; surplus payments are simply not returned here", () => {
    const slots = assignPaymentsToSlots([utc(2026, 3, 2), utc(2026, 3, 9)], [pay("2026-03-03")]);
    assert.equal(slots[0].payment?.occurredOn.toISOString(), new Date("2026-03-03").toISOString());
    assert.equal(slots[1].payment, null);
  });
});

describe("slotBounds", () => {
  test("REVOLVING: hideUnpaidBefore only set when the tracker was created mid-period", () => {
    const created = utc(2026, 3, 10);
    assert.deepEqual(slotBounds(utc(2026, 3, 1), { debtType: "CARD", trackerCreatedAt: created }).hideUnpaidBefore, created);
    assert.equal(
      slotBounds(utc(2026, 3, 1), { debtType: "CARD", trackerCreatedAt: utc(2026, 2, 1) }).hideUnpaidBefore,
      undefined,
    );
  });

  test("INSTALLMENT: floor at the purchase date, ceiling at the last scheduled installment", () => {
    const b = slotBounds(utc(2026, 3, 1), {
      debtType: "INSTALLMENT",
      purchaseDate: utc(2026, 2, 20),
      cadence: "MONTHLY",
      nextDueDate: utc(2026, 3, 15),
      lastPaidDate: utc(2026, 2, 15),
      installmentsRemaining: 3,
    });
    assert.deepEqual(b.occurrenceStart, utc(2026, 3, 1)); // max(monthStart, purchaseDate)
    // installmentsRemaining: 3 from nextDueDate Mar 15 -> Mar 15, Apr 15, May 15.
    assert.deepEqual(b.occurrenceEnd, utc(2026, 5, 15));
  });

  test("INSTALLMENT: an un-started plan floors at its first installment, not the purchase date", () => {
    const b = slotBounds(utc(2026, 9, 1), {
      debtType: "INSTALLMENT",
      purchaseDate: utc(2026, 9, 3),
      cadence: "MONTHLY",
      nextDueDate: utc(2026, 10, 3),
      lastPaidDate: null,
      installmentsRemaining: 4,
    });
    assert.deepEqual(b.occurrenceStart, utc(2026, 10, 3));
  });

  test("REVOLVING: a restarted cycle has no occurrence before its first due date", () => {
    // Regression 2026-10-07: card paid to $0 Oct 1 ($141.49), new $209.35
    // charge Oct 4, tracker rolled to Nov 4. Walking back from Nov 4 rebuilt
    // an Oct 4 occurrence, and the payoff read as a "covered" $29 minimum.
    const bounds = slotBounds(utc(2026, 10, 1), { debtType: "REVOLVING", cycleRestartDueDate: utc(2026, 11, 4) });
    const payoff = { amountCents: 14149, occurredOn: utc(2026, 10, 1) };
    const { slots, extraPayments } = buildCycleSlots(utc(2026, 11, 4), "MONTHLY", utc(2026, 10, 1), utc(2026, 11, 1), [payoff], bounds);
    assert.equal(slots.length, 0);
    assert.deepEqual(extraPayments, [payoff]);
    // November onward is unaffected.
    const nov = slotBounds(utc(2026, 11, 1), { debtType: "REVOLVING", cycleRestartDueDate: utc(2026, 11, 4) });
    assert.equal(buildCycleSlots(utc(2026, 11, 4), "MONTHLY", utc(2026, 11, 1), utc(2026, 12, 1), [], nov).slots.length, 1);
  });
});

describe("buildCycleSlots", () => {
  test("pairs occurrences to payments and returns the surplus as extraPayments", () => {
    const { slots, extraPayments } = buildCycleSlots(
      utc(2026, 3, 15),
      "MONTHLY",
      utc(2026, 3, 1),
      utc(2026, 4, 1),
      [pay("2026-03-03"), pay("2026-03-10"), pay("2026-03-11")],
    );
    const filled = slots.filter((s) => s.payment).length;
    assert.equal(filled, 1); // one MONTHLY occurrence
    assert.equal(extraPayments.length, 2);
    assert.equal(extraPayments[0].occurredOn.toISOString(), new Date("2026-03-10").toISOString());
  });

  describe("regressions", () => {
    // Real household report, 2026-09-25: Cedar Creek Irrigation is due the 30th
    // of each month but its charge reliably posts the 1st-3rd. Plain
    // calendar-month pooling let that one late payment double as "paid" for
    // both the cycle it actually satisfied *and* the following month's own
    // untouched occurrence, since its date fell inside both months' windows.
    test("Cedar Creek Irrigation: a payment a few days into the month belongs to the prior month's due-the-30th cycle, not this month's", () => {
      // nextDueDate already rolled Aug 30 -> Sep 30, meaning Aug 30 is
      // already known-satisfied — by the Sep 1 payment specifically.
      const payments = [pay("2026-06-02"), pay("2026-07-02"), pay("2026-08-03"), pay("2026-09-01")];

      const september = buildCycleSlots(utc(2026, 9, 30), "MONTHLY", utc(2026, 9, 1), utc(2026, 10, 1), payments);
      assert.equal(september.slots.length, 1);
      assert.equal(september.slots[0].payment, null); // Sept's own 30th isn't paid yet
      assert.equal(september.extraPayments.length, 0); // Sep 1 must NOT leak in as September's

      // August's own slot still positionally pairs with Aug 3 (itself already
      // a carry-over from an earlier cycle in this same recurring cascade —
      // not something this fix reaches into past periods to unwind), but the
      // Sep 1 payment that actually satisfied Aug 30 now surfaces as
      // August's own extra rather than vanishing into September's slot.
      const august = buildCycleSlots(utc(2026, 9, 30), "MONTHLY", utc(2026, 8, 1), utc(2026, 9, 1), payments);
      assert.equal(august.slots.length, 1);
      assert.equal(august.slots[0].payment?.occurredOn.toISOString(), new Date("2026-08-03").toISOString());
      assert.equal(august.extraPayments.length, 1);
      assert.equal(august.extraPayments[0].occurredOn.toISOString(), new Date("2026-09-01").toISOString());
    });

    test("a bill due mid-month is unaffected by the boundary-reattachment logic", () => {
      const { slots, extraPayments } = buildCycleSlots(
        utc(2026, 9, 15),
        "MONTHLY",
        utc(2026, 9, 1),
        utc(2026, 10, 1),
        [pay("2026-08-15"), pay("2026-09-16")],
      );
      assert.equal(slots[0].payment?.occurredOn.toISOString(), new Date("2026-09-16").toISOString());
      assert.equal(extraPayments.length, 0);
    });
  });

  test("hideUnpaidBefore drops an unpaid pre-cutoff slot but keeps a paid one", () => {
    const bounds = slotBounds(utc(2026, 3, 1), { debtType: "CARD", trackerCreatedAt: utc(2026, 3, 20) });
    const { slots } = buildCycleSlots(
      utc(2026, 3, 25),
      "WEEKLY",
      utc(2026, 3, 1),
      utc(2026, 4, 1),
      [pay("2026-03-04")], // pays the Mar 4 occurrence, which is before the cutoff
      bounds,
    );
    const dates = slots.map((s) => s.date.toISOString());
    assert.ok(dates.includes(utc(2026, 3, 4).toISOString())); // kept — it is paid
    assert.ok(!dates.includes(utc(2026, 3, 11).toISOString())); // dropped — unpaid, pre-cutoff
  });
});

describe("cyclePaymentStatus", () => {
  test("real report 2026-09-12: a payment from LAST month doesn't count as this month's paid", () => {
    // Family Verizon Reimbursement: paid Aug 25, nextDueDate rolled to Sep 25.
    // Checking "has Sep 25 passed yet" alone (the old bug) says no, so it's
    // still "paid" — wrong the moment September starts. Calendar-month
    // bounding sidesteps that question entirely: Aug 25 is outside
    // September, full stop.
    const { cyclePaid, currentCyclePayments } = cyclePaymentStatus(
      utc(2026, 9, 25),
      "MONTHLY",
      [pay("2026-08-25", 5_000)],
      utc(2026, 9, 1),
      utc(2026, 10, 1),
    );
    assert.equal(cyclePaid, false);
    assert.equal(currentCyclePayments.length, 0);
  });

  test("a real payment landing this month counts, regardless of whether nextDueDate rolled yet", () => {
    const { cyclePaid, currentCyclePayments } = cyclePaymentStatus(
      utc(2026, 9, 12), // due date still upcoming, hasn't rolled to October
      "MONTHLY",
      [pay("2026-09-08", 14_080)],
      utc(2026, 9, 1),
      utc(2026, 10, 1),
    );
    assert.equal(cyclePaid, true);
    assert.equal(currentCyclePayments.length, 1);
    assert.equal(currentCyclePayments[0].amountCents, 14_080);
  });

  test("unpaid, nothing this month yet -> not paid, no payments", () => {
    const { cyclePaid, currentCyclePayments } = cyclePaymentStatus(
      utc(2026, 9, 25),
      "MONTHLY",
      [],
      utc(2026, 9, 1),
      utc(2026, 10, 1),
    );
    assert.equal(cyclePaid, false);
    assert.equal(currentCyclePayments.length, 0);
  });

  test("a genuine second payment this same month surfaces as an extra, still counted", () => {
    const { cyclePaid, currentCyclePayments } = cyclePaymentStatus(
      utc(2026, 9, 25),
      "MONTHLY",
      [pay("2026-09-03", 1_000), pay("2026-09-10", 2_000)],
      utc(2026, 9, 1),
      utc(2026, 10, 1),
    );
    assert.equal(cyclePaid, true);
    assert.equal(currentCyclePayments.length, 2);
  });
});

describe("extraPaymentsBeyondSlots", () => {
  const base = { amountCents: 5_000, occurredOn: new Date("2026-03-15") };

  test("passthrough when the debt did not pay off this period", () => {
    const slotExtras = [base];
    assert.equal(
      extraPaymentsBeyondSlots(slotExtras, [base], utc(2026, 3, 1), utc(2026, 4, 1), {
        paidOffDate: null,
        tracksMinimum: true,
      }),
      slotExtras,
    );
  });

  test("paid-off-this-period + tracksMinimum -> every in-period payment is extra", () => {
    const all = [
      { amountCents: 3_000, occurredOn: new Date("2026-03-05") },
      { amountCents: 9_000, occurredOn: new Date("2026-03-20") },
      { amountCents: 1_000, occurredOn: new Date("2026-04-05") }, // out of period
    ];
    const result = extraPaymentsBeyondSlots([], all, utc(2026, 3, 1), utc(2026, 4, 1), {
      paidOffDate: utc(2026, 3, 21),
      tracksMinimum: true,
    });
    assert.equal(result.length, 2);
  });

  test("no-minimum debt -> every in-period payment is extra, even without a payoff this period", () => {
    const all = [
      { amountCents: 3_000, occurredOn: new Date("2026-03-05") },
      { amountCents: 9_000, occurredOn: new Date("2026-03-20") },
      { amountCents: 1_000, occurredOn: new Date("2026-04-05") }, // out of period
    ];
    const result = extraPaymentsBeyondSlots([all[0]], all, utc(2026, 3, 1), utc(2026, 4, 1), {
      paidOffDate: null,
      tracksMinimum: false,
    });
    assert.equal(result.length, 2);
  });

  describe("regressions", () => {
    // 2026-09-14: Sam's Club Card fully paid off (balance $0), then a new
    // purchase restored it mid-cycle. nextPaidOffDate nulls Debt.paidOffDate
    // the instant the balance goes positive again, so paidOffThisPeriod could
    // never be true here — buildCycleSlots (blind to tracksMinimum) still
    // consumed the period's first payment as its one "slot," leaving only the
    // second payment as slotExtras, and the plan's amount-due math netted
    // that stale $21.48 shortfall against the live post-restoration balance.
    test("no-minimum debt paid off then restored mid-period: closing payment still counts as extra", () => {
      const slotExtras = [{ amountCents: 10_100, occurredOn: new Date("2026-09-01") }]; // buildCycleSlots' leftover
      const all = [
        { amountCents: 10_100, occurredOn: new Date("2026-09-01") },
        { amountCents: 14_080, occurredOn: new Date("2026-09-08") }, // the actual payoff
      ];
      const result = extraPaymentsBeyondSlots(slotExtras, all, utc(2026, 9, 1), utc(2026, 10, 1), {
        paidOffDate: null, // already nulled by the balance restore
        tracksMinimum: false,
      });
      assert.equal(result.length, 2);
      assert.equal(
        result.reduce((s, p) => s + p.amountCents, 0),
        24_180,
      );
    });
  });
});

describe("cycleDueDate", () => {
  test("the first unpaid slot, not the last (biweekly BNPL billing twice a month)", () => {
    // Regression (2026-10-09 review): /debts used the last slot (Sep 17)
    // while the dashboard used the first unpaid (Sep 3).
    const slots = [
      { date: utc(2026, 9, 3), payment: null },
      { date: utc(2026, 9, 17), payment: null },
    ];
    assert.deepEqual(cycleDueDate(slots, utc(2026, 9, 3)), utc(2026, 9, 3));
  });

  test("all paid -> last slot; nothing this period -> nextDueDate", () => {
    const paid = { occurredOn: utc(2026, 9, 1) };
    assert.deepEqual(
      cycleDueDate([{ date: utc(2026, 9, 3), payment: paid }, { date: utc(2026, 9, 17), payment: paid }], utc(2026, 10, 1)),
      utc(2026, 9, 17),
    );
    assert.deepEqual(cycleDueDate([], utc(2027, 3, 1)), utc(2027, 3, 1));
  });
});
