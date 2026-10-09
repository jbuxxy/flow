import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addBillCadence,
  allocateExtraPool,
  computeAlreadyFreedMinimums,
  computeAttackOrder,
  confirmProjectedExtras,
  debtsWithInsufficientMinimum,
  billCadenceToMonthlyCents,
  monthlyRateOf,
  mostRecentPaydayOnOrBefore,
  nextPaidOffDate,
  pickPayoffPaymentTime,
  PAYOFF_ATTRIBUTION_WINDOW_MS,
  projectCyclePlan,
  projectPaycheckDates,
  simulatePayoff,
  supersededPayoffExtraCents,
  supersededPayoffTargetAmounts,
  capAtPayoffCents,
  payoffAmountCents,
} from "@/lib/debt-payoff";
import { debt, income, utc } from "../helpers.ts";

describe("monthlyRateOf", () => {
  test("APR basis points -> monthly decimal rate", () => {
    assert.equal(monthlyRateOf(2400), 0.02); // 24% / 12
    assert.equal(monthlyRateOf(0), 0);
  });
});

describe("addBillCadence", () => {
  test("MONTHLY clamps a day-29-31 anchor to the target month's real last day, not overflows into the next one", () => {
    // Real report, 2026-09-12: a raw setUTCMonth(+1) on Jan 31 overflowed
    // into March (Feb has no 31st), silently skipping February's occurrence
    // wherever this gets walked one month at a time (occurrencesInMonth).
    assert.deepEqual(addBillCadence(utc(2026, 1, 31), "MONTHLY"), utc(2026, 2, 28)); // 2026 not a leap year
    assert.deepEqual(addBillCadence(utc(2024, 1, 31), "MONTHLY"), utc(2024, 2, 29)); // leap year
    assert.deepEqual(addBillCadence(utc(2026, 4, 30), "MONTHLY"), utc(2026, 5, 30)); // 30 -> 31-day May, unclamped
    assert.deepEqual(addBillCadence(utc(2026, 12, 15), "MONTHLY"), utc(2027, 1, 15)); // year rollover, no clamp needed
  });

  test("MONTHLY on an ordinary day (no clamp needed) is unaffected", () => {
    assert.deepEqual(addBillCadence(utc(2026, 3, 15), "MONTHLY"), utc(2026, 4, 15));
  });

  test("WEEKLY/BIWEEKLY/ANNUAL are unaffected by the MONTHLY clamp logic", () => {
    assert.deepEqual(addBillCadence(utc(2026, 1, 31), "WEEKLY"), utc(2026, 2, 7));
    assert.deepEqual(addBillCadence(utc(2026, 1, 31), "BIWEEKLY"), utc(2026, 2, 14));
    assert.deepEqual(addBillCadence(utc(2026, 1, 31), "ANNUAL"), utc(2027, 1, 31));
  });
});

describe("billCadenceToMonthlyCents", () => {
  test("scales a per-occurrence amount to a true monthly figure", () => {
    assert.equal(billCadenceToMonthlyCents(5_000, "MONTHLY"), 5_000);
    assert.equal(billCadenceToMonthlyCents(5_000, undefined), 5_000);
    assert.equal(billCadenceToMonthlyCents(5_000, "BIWEEKLY"), Math.round((5_000 * 26) / 12));
    assert.equal(billCadenceToMonthlyCents(5_000, "WEEKLY"), Math.round((5_000 * 52) / 12));
    assert.equal(billCadenceToMonthlyCents(60_000, "ANNUAL"), 5_000);
  });
});

describe("computeAttackOrder", () => {
  const a = debt({ id: "a", aprBasisPoints: 1000, balanceCents: 900 });
  const b = debt({ id: "b", aprBasisPoints: 3000, balanceCents: 500 });
  const c = debt({ id: "c", aprBasisPoints: 2000, balanceCents: 100 });

  test("AVALANCHE sorts by APR descending", () => {
    assert.deepEqual(computeAttackOrder([a, b, c], "AVALANCHE"), ["b", "c", "a"]);
  });
  test("SNOWBALL sorts by balance ascending", () => {
    assert.deepEqual(computeAttackOrder([a, b, c], "SNOWBALL"), ["c", "b", "a"]);
  });
  test("CUSTOM trusts the input order", () => {
    assert.deepEqual(computeAttackOrder([a, b, c], "CUSTOM"), ["a", "b", "c"]);
  });
  test("empty input", () => {
    assert.deepEqual(computeAttackOrder([], "AVALANCHE"), []);
  });
});

describe("debtsWithInsufficientMinimum", () => {
  test("flags a debt whose minimum does not cover its first month's interest", () => {
    // balance 100000 @ 24% -> monthly interest 2000; min 1500 <= 2000 -> flagged.
    const flagged = debtsWithInsufficientMinimum([debt({ id: "x", balanceCents: 100_000, aprBasisPoints: 2400, minPaymentCents: 1_500 })]);
    assert.deepEqual(flagged.map((d) => d.id), ["x"]);
    assert.equal(flagged[0].monthlyInterestCents, 2_000);
  });

  test("boundary: minimum exactly equal to interest is still flagged (<=)", () => {
    const flagged = debtsWithInsufficientMinimum([debt({ balanceCents: 100_000, aprBasisPoints: 2400, minPaymentCents: 2_000 })]);
    assert.equal(flagged.length, 1);
  });

  test("skips INSTALLMENT, zero-balance and ignoreMinimumPayment debts", () => {
    const flagged = debtsWithInsufficientMinimum([
      debt({ id: "inst", debtType: "INSTALLMENT", balanceCents: 100_000, aprBasisPoints: 9900, minPaymentCents: 1 }),
      debt({ id: "zero", balanceCents: 0, aprBasisPoints: 9900, minPaymentCents: 0 }),
      debt({ id: "ignore", balanceCents: 100_000, aprBasisPoints: 9900, minPaymentCents: 0, ignoreMinimumPayment: true }),
    ]);
    assert.deepEqual(flagged, []);
  });
});

describe("allocateExtraPool", () => {
  const working = () =>
    new Map([
      ["a", { ...debt({ id: "a" }), remaining: 1_000, minPayment: 0 }],
      ["b", { ...debt({ id: "b" }), remaining: 5_000, minPayment: 0 }],
    ]);

  test("cascades in order, capped at each debt's remaining balance", () => {
    const w = working();
    const applied = allocateExtraPool(["a", "b"], w, 3_000);
    assert.deepEqual([...applied], [["a", 1_000], ["b", 2_000]]);
    assert.equal(w.get("a")!.remaining, 0);
    assert.equal(w.get("b")!.remaining, 3_000);
  });

  test("dryRun computes the same split without mutating balances", () => {
    const w = working();
    const applied = allocateExtraPool(["a", "b"], w, 3_000, { dryRun: true });
    assert.deepEqual([...applied], [["a", 1_000], ["b", 2_000]]);
    assert.equal(w.get("a")!.remaining, 1_000);
  });

  test("pool <= 0 is a no-op", () => {
    assert.equal(allocateExtraPool(["a", "b"], working(), 0).size, 0);
  });
});

describe("computeAlreadyFreedMinimums", () => {
  test("keeps paid-off, in-plan debts with a positive minimum; sorts by payoff date; sets freedMonthKey", () => {
    const freed = computeAlreadyFreedMinimums([
      { id: "old", name: "Old", balanceCents: 0, minPaymentCents: 2_500, includeInPayoffPlan: true, paidOffDate: utc(2026, 6, 10) },
      { id: "recent", name: "Recent", balanceCents: 0, minPaymentCents: 4_000, includeInPayoffPlan: true, paidOffDate: utc(2026, 9, 2) },
      { id: "excluded", name: "Excluded", balanceCents: 0, minPaymentCents: 9_000, includeInPayoffPlan: false, paidOffDate: utc(2026, 1, 1) },
      { id: "still-owing", name: "Owing", balanceCents: 100, minPaymentCents: 5_000, includeInPayoffPlan: true },
    ]);
    assert.deepEqual(freed.map((f) => f.id), ["old", "recent"]); // excluded + still-owing dropped, earliest payoff first
    assert.equal(freed[0].amountCents, 2_500);
    assert.equal(freed[0].freedMonthKey, 2026 * 12 + 5); // June
    assert.equal(freed[1].freedMonthKey, 2026 * 12 + 8); // September
  });

  test("unknown payoff date -> freedMonthKey undefined", () => {
    const freed = computeAlreadyFreedMinimums([
      { id: "x", name: "X", balanceCents: -5, minPaymentCents: 1_000, includeInPayoffPlan: true, paidOffDate: null },
    ]);
    assert.equal(freed[0].freedMonthKey, undefined);
  });
});

describe("projectPaycheckDates", () => {
  test("walks forward by cadence, defaulting to income.nextPayDate", () => {
    const dates = projectPaycheckDates(income({ nextPayDate: utc(2026, 1, 2), cadence: "BIWEEKLY" }), 3);
    assert.deepEqual(dates, [utc(2026, 1, 2), utc(2026, 1, 16), utc(2026, 1, 30)]);
  });

  test("count 0 -> empty", () => {
    assert.deepEqual(projectPaycheckDates(income(), 0), []);
  });
});

describe("mostRecentPaydayOnOrBefore", () => {
  const sched = income({ nextPayDate: utc(2026, 3, 6), cadence: "BIWEEKLY" });

  test("exact match returns that day", () => {
    assert.deepEqual(mostRecentPaydayOnOrBefore(sched, utc(2026, 3, 6)), utc(2026, 3, 6));
  });

  test("returns the most recent past payday, always within one cadence period", () => {
    const r = mostRecentPaydayOnOrBefore(sched, utc(2026, 3, 15));
    assert.deepEqual(r, utc(2026, 3, 6));
    const r2 = mostRecentPaydayOnOrBefore(sched, utc(2026, 3, 25));
    assert.deepEqual(r2, utc(2026, 3, 20));
  });

  test("MONTHLY schedule with a month-end nextPayDate does not overshoot backward", () => {
    const monthly = income({ nextPayDate: utc(2026, 3, 31), cadence: "MONTHLY" });
    const r = mostRecentPaydayOnOrBefore(monthly, utc(2026, 3, 15));
    assert.ok(r.getTime() <= utc(2026, 3, 15).getTime());
    assert.ok(r.getTime() > utc(2026, 1, 1).getTime());
  });
});

describe("nextPaidOffDate", () => {
  test("stamps a date the moment balance crosses positive -> zero", () => {
    const r = nextPaidOffDate(5_000, 0, null);
    assert.ok(r instanceof Date);
  });
  test("clears when balance goes positive again", () => {
    assert.equal(nextPaidOffDate(0, 1_200, utc(2026, 1, 1)), null);
  });
  test("leaves an existing date alone while balance just sits at zero", () => {
    const existing = utc(2026, 1, 1);
    assert.equal(nextPaidOffDate(0, 0, existing), existing);
  });
});

describe("pickPayoffPaymentTime", () => {
  const paidOff = utc(2026, 3, 20);

  test("returns the latest payment time when it is near paidOffDate and balance is 0", () => {
    const t = pickPayoffPaymentTime(
      [{ occurredOn: utc(2026, 3, 10) }, { occurredOn: utc(2026, 3, 19) }],
      0,
      paidOff,
    );
    assert.equal(t, utc(2026, 3, 19).getTime());
  });

  test("null when balance is not 0, or no paidOffDate, or no payments", () => {
    assert.equal(pickPayoffPaymentTime([{ occurredOn: paidOff }], 100, paidOff), null);
    assert.equal(pickPayoffPaymentTime([{ occurredOn: paidOff }], 0, null), null);
    assert.equal(pickPayoffPaymentTime([], 0, paidOff), null);
  });

  test("null when the latest payment is too far from paidOffDate (outside the attribution window)", () => {
    const far = new Date(paidOff.getTime() - PAYOFF_ATTRIBUTION_WINDOW_MS - 86_400_000);
    assert.equal(pickPayoffPaymentTime([{ occurredOn: far }], 0, paidOff), null);
  });
});

describe("simulatePayoff", () => {
  test("minimum-only single debt at 0% APR pays off in ceil(balance/min) months", () => {
    const r = simulatePayoff([debt({ id: "a", balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 10_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 0,
      startDate: utc(2026, 1, 1),
    });
    assert.equal(r.months, 10);
    assert.equal(r.perDebt[0].payoffMonth, 10);
    assert.deepEqual(r.debtFreeDate, utc(2026, 10, 1)); // month - 1 offset: tick 10 == October
  });

  test("a debt cleared by this cycle's own extra is dated THIS month, not next", () => {
    const r = simulatePayoff([debt({ id: "a", balanceCents: 5_000, aprBasisPoints: 0, minPaymentCents: 1_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 100_000, // clears it immediately
      startDate: utc(2026, 4, 15),
    });
    assert.equal(r.months, 1);
    assert.deepEqual(r.debtFreeDate, utc(2026, 4, 1));
  });

  test("regression 2026-09-21: an ignoreMinimumPayment, out-of-plan debt (Sam's Club) doesn't block debtFreeDate for the rest of the household", () => {
    const r = simulatePayoff(
      [
        debt({ id: "tracked", balanceCents: 5_000, aprBasisPoints: 0, minPaymentCents: 1_000 }),
        // No minimum, not extra-eligible — nothing in the sim ever touches
        // it (mirrors applyInterestAndMinimums' own exemption). Its balance
        // never real-world-never-clears in this model.
        debt({ id: "adhoc", name: "Sam's Club Card", balanceCents: 24_881, aprBasisPoints: 2015, minPaymentCents: 0, ignoreMinimumPayment: true }),
      ],
      {
        order: "AVALANCHE",
        rollFreedMinimums: false,
        extraPerPaycheckCents: 0,
        startDate: utc(2026, 1, 1),
        extraEligibleIds: new Set(["tracked"]), // "adhoc" excluded from the plan
      },
    );
    // Before the fix this read null (`allPaidOff` required Sam's Club to
    // hit $0 too, which nothing in the model can ever do) — the household's
    // real debt-free date showed as "Not projected to pay off within 50
    // years" despite the only properly-modeled debt clearing on schedule.
    assert.deepEqual(r.debtFreeDate, utc(2026, 5, 1));
    assert.equal(r.months, 5);
    assert.deepEqual(r.perDebt.find((d) => d.id === "tracked")?.payoffDate, utc(2026, 5, 1));
    // Sam's Club itself is honestly reported as never clearing in this model.
    assert.equal(r.perDebt.find((d) => d.id === "adhoc")?.payoffDate, null);
    assert.equal(r.timeline.at(-1)?.perDebtRemainingCents.adhoc, 24_881);
  });

  test("names a debt in neverPaysOff under minimums alone when the minimum < interest", () => {
    const r = simulatePayoff([debt({ id: "a", name: "Sinker", balanceCents: 100_000, aprBasisPoints: 3600, minPaymentCents: 2_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 0,
      startDate: utc(2026, 1, 1),
      horizonMonths: 12,
    });
    assert.deepEqual(r.neverPaysOff, ["Sinker"]);
  });

  test("addMonths snaps to the 1st — starting late in a long month does not overflow", () => {
    const r = simulatePayoff([debt({ id: "a", balanceCents: 30_000, aprBasisPoints: 0, minPaymentCents: 10_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 0,
      startDate: utc(2026, 8, 31),
    });
    assert.equal(r.months, 3);
    assert.deepEqual(r.debtFreeDate, utc(2026, 10, 1)); // Aug tick1, Sep tick2, Oct tick3 — not "Aug 31 + 2mo"
  });

  test("rollFreedMinimums feeds a cleared debt's minimum into the pool for the rest of the run", () => {
    const debts = [
      debt({ id: "small", balanceCents: 2_000, aprBasisPoints: 0, minPaymentCents: 2_000 }),
      debt({ id: "big", balanceCents: 40_000, aprBasisPoints: 0, minPaymentCents: 2_000 }),
    ];
    const withRoll = simulatePayoff(debts, { order: "SNOWBALL", rollFreedMinimums: true, extraPerPaycheckCents: 0, startDate: utc(2026, 1, 1) });
    const without = simulatePayoff(debts, { order: "SNOWBALL", rollFreedMinimums: false, extraPerPaycheckCents: 0, startDate: utc(2026, 1, 1) });
    assert.ok(withRoll.months < without.months);
  });

  test("extraEligibleIds keeps extra money (and rolled minimums) off an excluded debt", () => {
    const debts = [
      debt({ id: "in", balanceCents: 50_000, aprBasisPoints: 0, minPaymentCents: 1_000 }),
      debt({ id: "out", balanceCents: 50_000, aprBasisPoints: 0, minPaymentCents: 1_000 }),
    ];
    const r = simulatePayoff(debts, {
      order: "CUSTOM",
      rollFreedMinimums: true,
      extraPerPaycheckCents: 500_00,
      startDate: utc(2026, 1, 1),
      extraEligibleIds: new Set(["in"]),
    });
    const inDebt = r.perDebt.find((d) => d.id === "in")!;
    const outDebt = r.perDebt.find((d) => d.id === "out")!;
    assert.equal(inDebt.payoffMonth, 1); // extra clears it at once
    assert.ok((outDebt.payoffMonth ?? 999) > 1); // only its own $10/mo minimum
  });

  test("a REVOLVING debt's BIWEEKLY minimum bills twice in a month, not once (2026-09-11 fix)", () => {
    // $1,000 balance, 24% APR, $25 BIWEEKLY minimum, due Mar 5 and Mar 19.
    // Before the fix, monthlyMinimumDue special-cased every non-INSTALLMENT
    // debt as "one minimum per month" and returned the raw per-occurrence
    // $25 unconverted — 100,000 + 2,000 interest − 2,500 = 99,500. Fixed: it
    // counts both real occurrences this month, same as INSTALLMENT already
    // did — 100,000 + 2,000 − 5,000 = 97,000.
    const r = simulatePayoff(
      [debt({ id: "a", debtType: "REVOLVING", balanceCents: 100_000, aprBasisPoints: 2400, minPaymentCents: 2_500, paymentCadence: "BIWEEKLY", nextDueDate: utc(2026, 3, 5) })],
      {
        order: "AVALANCHE",
        rollFreedMinimums: false,
        extraPerPaycheckCents: 0,
        startDate: utc(2026, 3, 1),
        horizonMonths: 1,
      },
    );
    assert.equal(r.timeline[0].perDebtRemainingCents["a"], 97_000);
  });

  test("MAX_MONTHS runaway guard", () => {
    const r = simulatePayoff([debt({ id: "a", balanceCents: 1_000_000, aprBasisPoints: 9900, minPaymentCents: 1 })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 0,
      startDate: utc(2026, 1, 1),
    });
    assert.equal(r.months, 600);
    assert.equal(r.debtFreeDate, null);
  });

  test("minimumSatisfiedThisCycleIds keeps month 1 from re-deducting an already-posted minimum (2026-09-14 fix)", () => {
    // $100 balance, $40 minimum, 0% APR. Before the fix, month 1 always
    // re-applied a fresh minimum on top of the live balance even when that
    // cycle's real payment had already posted (already reflected in the
    // balance the simulation starts from) — the real incident: Amazon
    // Card's already-paid $35 minimum got double-counted, pulling its
    // projected payoff a full month earlier than it should've been.
    const d = () => debt({ id: "a", balanceCents: 10_000, aprBasisPoints: 0, minPaymentCents: 4_000 });
    const opts = { order: "AVALANCHE" as const, rollFreedMinimums: false, extraPerPaycheckCents: 0, startDate: utc(2026, 3, 1) };
    const withoutFix = simulatePayoff([d()], opts);
    const withFix = simulatePayoff([d()], { ...opts, minimumSatisfiedThisCycleIds: new Set(["a"]) });
    // Without the fix: 100 -> 60 (m1) -> 20 (m2) -> 0 (m3).
    assert.equal(withoutFix.perDebt[0].payoffMonth, 3);
    // With the fix: month 1's minimum is skipped (100 -> 100) -> 60 (m2) ->
    // 20 (m3) -> 0 (m4) — the exact same cadence, just starting a cycle
    // later since this cycle's minimum was already spent for real.
    assert.equal(withFix.perDebt[0].payoffMonth, 4);
  });

  test("skippedExtraPairs excludes one specific payday's extra from month 1, not redistributed (2026-09-14 fix)", () => {
    // One payday (Feb 20) falls in month 1; a $300 extra pool against a
    // $1,000 balance. Before the fix, simulatePayoff had no way to know a
    // household-skipped payday shouldn't count — it always assumed every
    // paycheck within the month landed in full, even one recorded as
    // skipped (PayoffExtraSkip), unlike projectCyclePlan (the Payoff
    // Calendar), which has always respected skips.
    const d = () => debt({ id: "a", balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 0 });
    const opts = {
      order: "AVALANCHE" as const,
      rollFreedMinimums: false,
      extraPerPaycheckCents: 30_000,
      startDate: utc(2026, 2, 20),
      income: { nextPayDate: utc(2026, 2, 20), cadence: "BIWEEKLY" as const },
    };
    const withoutSkip = simulatePayoff([d()], opts);
    const withSkip = simulatePayoff([d()], { ...opts, skippedExtraPairs: new Set(["a:2026-02-20"]) });
    // Without the skip, Feb's one payday applies its $300 normally.
    assert.equal(withoutSkip.timeline[0].totalRemainingCents, 100_000 - 30_000);
    // With the skip, that same payday's $300 is forfeited entirely — Feb
    // ends with the balance completely untouched, not handed to a later
    // payday (there is none this month) or to another debt either.
    assert.equal(withSkip.timeline[0].totalRemainingCents, 100_000);
  });

  test("a freedMonthKey equal to the simulation's own starting month defers that source to month 2 (2026-09-14 fix)", () => {
    // Before the fix, simulatePayoff ignored FreedMinimumSource.freedMonthKey
    // entirely and always folded every already-freed minimum in from month
    // 1 — correct for a debt that closed a while ago, wrong for one that
    // closed *this same* calendar month (its freed minimum isn't real spare
    // cash yet; that month's own minimum is still considered spent by the
    // payment that just cleared it — the real incident: Quicksilver closing
    // the same month as Amazon Card's own projection, its freed $25/mo
    // shouldn't have counted toward September's pool at all).
    const startDate = utc(2026, 3, 1);
    const startMonthKey = 2026 * 12 + 2; // March, 0-indexed
    const opts = { order: "AVALANCHE" as const, rollFreedMinimums: true, extraPerPaycheckCents: 0, startDate };
    const noKey = simulatePayoff([debt({ id: "a", balanceCents: 5_000, aprBasisPoints: 0, minPaymentCents: 0 })], {
      ...opts,
      alreadyFreedMinimums: [{ id: "freed", name: "Freed", amountCents: 1_000 }], // no freedMonthKey — rolls from month 1, unchanged
    });
    const thisMonthKey = simulatePayoff([debt({ id: "a", balanceCents: 5_000, aprBasisPoints: 0, minPaymentCents: 0 })], {
      ...opts,
      alreadyFreedMinimums: [{ id: "freed", name: "Freed", amountCents: 1_000, freedMonthKey: startMonthKey }],
    });
    assert.equal(noKey.timeline[0].totalRemainingCents, 5_000 - 1_000);
    // Deferred — month 1 doesn't get it yet.
    assert.equal(thisMonthKey.timeline[0].totalRemainingCents, 5_000);
    // ...but month 2 does, same $1,000 the undeferred case already applied
    // in month 1 — just one cycle later, not lost and not doubled.
    assert.equal(thisMonthKey.timeline[1].totalRemainingCents, 5_000 - 1_000);
  });
});

describe("projectCyclePlan", () => {
  const sched = income({ nextPayDate: utc(2026, 3, 6), cadence: "BIWEEKLY" });

  test("emits one minimum line per due occurrence in the month", () => {
    const months = projectCyclePlan([debt({ id: "a", balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 5_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 0,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 1),
      dueDateByDebtId: new Map([["a", { date: utc(2026, 3, 15), cadence: "MONTHLY" }]]),
      minimumSatisfiedThisCycleIds: new Set(["a"]), // make this cycle's own line visible as a future line
    });
    const lines = months[0].debts[0].lines;
    assert.ok(lines.some((l) => l.kind === "minimum" && l.amountCents === 5_000));
  });

  test("a $0 minimum produces no line", () => {
    const months = projectCyclePlan([debt({ id: "a", balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 0, ignoreMinimumPayment: true })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 0,
      income: sched,
      monthsCount: 2,
      startDate: utc(2026, 3, 1),
      dueDateByDebtId: new Map([["a", { date: utc(2026, 3, 15), cadence: "MONTHLY" }]]),
    });
    const allLines = months.flatMap((m) => m.debts.flatMap((d) => d.lines));
    assert.equal(allLines.filter((l) => l.kind === "minimum").length, 0);
  });

  test("rollFreedMinimumsSplit: false moves the whole month's freed total on the priority debt's own due date, not on any payday", () => {
    const months = projectCyclePlan([debt({ id: "a", balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 5_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: true,
      rollFreedMinimumsSplit: false,
      extraPerPaycheckCents: 0,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 1),
      dueDateByDebtId: new Map([["a", { date: utc(2026, 3, 15), cadence: "MONTHLY" }]]),
      minimumSatisfiedThisCycleIds: new Set(["a"]),
      alreadyFreedMinimums: [{ id: "freed", name: "Freed", amountCents: 2_000 }],
    });
    const lines = months[0].debts[0].lines;
    const extraLines = lines.filter((l) => l.kind === "extra");
    assert.equal(extraLines.length, 1, "the whole month's freed total lands in a single line");
    assert.deepEqual(extraLines[0].date, utc(2026, 3, 15));
    assert.equal(extraLines[0].amountCents, 2_000);
    // sched's paydays (Mar 6, Mar 20) get nothing — extraPerPaycheckCents is
    // 0 and LUMP mode diverts the freed total away from the payday pool.
    assert.ok(!extraLines.some((l) => l.date.getTime() === utc(2026, 3, 6).getTime()));
    assert.ok(!extraLines.some((l) => l.date.getTime() === utc(2026, 3, 20).getTime()));
  });

  test("SPLIT (default) and LUMP move the same total freed money by month's end, just on different dates", () => {
    const debts = () => [debt({ id: "a", balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 5_000 })];
    const baseOpts = {
      order: "AVALANCHE" as const,
      rollFreedMinimums: true,
      extraPerPaycheckCents: 0,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 1),
      dueDateByDebtId: new Map([["a", { date: utc(2026, 3, 15), cadence: "MONTHLY" as const }]]),
      minimumSatisfiedThisCycleIds: new Set(["a"]),
      alreadyFreedMinimums: [{ id: "freed", name: "Freed", amountCents: 2_000 }],
    };
    const split = projectCyclePlan(debts(), baseOpts);
    const lump = projectCyclePlan(debts(), { ...baseOpts, rollFreedMinimumsSplit: false });
    assert.equal(split[0].debts[0].endBalanceCents, lump[0].debts[0].endBalanceCents);
    // But the shape differs: SPLIT spreads it across both paydays, LUMP puts
    // it all on the one due-date line.
    assert.equal(split[0].debts[0].lines.filter((l) => l.kind === "extra").length, 2);
    assert.equal(lump[0].debts[0].lines.filter((l) => l.kind === "extra").length, 1);
  });

  test("a past payday keeps its share of the rolled freed minimum (SPLIT)", () => {
    // Regression 2026-10-02: once a payday passed, its line dropped the
    // rolled-in share and the month's later paydays only split what was left.
    const months = projectCyclePlan([debt({ id: "a", balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 5_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: true,
      extraPerPaycheckCents: 10_000,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 10), // payday Mar 6 is in the past -> pending branch
      dueDateByDebtId: new Map([["a", { date: utc(2026, 3, 15), cadence: "MONTHLY" }]]),
      minimumSatisfiedThisCycleIds: new Set(["a"]),
      alreadyFreedMinimums: [{ id: "freed", name: "Freed", amountCents: 2_000 }],
    });
    const extras = months[0].debts[0].lines.filter((l) => l.kind === "extra");
    const byDate = new Map(extras.map((l) => [l.date.toISOString().slice(0, 10), l]));
    const past = byDate.get("2026-03-06")!;
    assert.equal(past.pending, true);
    assert.equal(past.amountCents, 11_000);
    assert.deepEqual(past.poolBreakdown?.parts, [
      { kind: "base", name: undefined, amountCents: 10_000 },
      { kind: "rolled", name: "Freed", amountCents: 1_000 },
    ]);
    assert.equal(byDate.get("2026-03-20")!.amountCents, 11_000);
  });

  test("a skipped pending extra is emitted but never applied to the balance", () => {
    const debtId = "a";
    const payday = utc(2026, 3, 6);
    const key = `${debtId}:${payday.toISOString().slice(0, 10)}`;
    const months = projectCyclePlan([debt({ id: debtId, balanceCents: 100_000, aprBasisPoints: 0, minPaymentCents: 5_000 })], {
      order: "AVALANCHE",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 20_000,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 10), // payday Mar 6 is in the past -> pending branch
      dueDateByDebtId: new Map([[debtId, { date: utc(2026, 4, 15), cadence: "MONTHLY" }]]),
      minimumSatisfiedThisCycleIds: new Set([debtId]),
      skippedExtraPairs: new Set([key]),
    });
    const entry = months[0].debts[0];
    const skippedLine = entry.lines.find((l) => l.skipped);
    assert.ok(skippedLine, "a skipped line is still emitted");
    assert.equal(skippedLine!.isPayoff, false);
    // Mar 6 (skipped) contributes nothing; only the later Mar 20 payday's
    // $200 extra reduces the balance. If the skip leaked, it would be 60000.
    assert.equal(entry.startBalanceCents, 100_000);
    assert.equal(entry.endBalanceCents, 80_000);
  });

  test("a real extra payment on an excluded, now-closed debt doesn't swallow the pool for an in-plan debt (2026-09-17 fix)", () => {
    // Sam's Club Card: excluded from the plan (not in `debts` — its balance
    // is already 0, so it's not passed in at all — and excluded from
    // extraEligibleIds), but still shows up in extraPaidThisCycleByDebtId
    // with its real $175.78 purchase-driven payoff amount. Before the fix,
    // the past-payday branch didn't check extraEligibleIds when tallying
    // "money already spent by debts that closed out this cycle," so this
    // wholly unrelated payment ate the entire $100 pool meant for Amazon,
    // the only actually in-plan debt, on the very next payday.
    const months = projectCyclePlan([debt({ id: "amazon", balanceCents: 21_846, aprBasisPoints: 0, minPaymentCents: 3_500 })], {
      order: "CUSTOM",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 10_000,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 6), // same day as the payday -> past-payday branch
      dueDateByDebtId: new Map([["amazon", { date: utc(2026, 4, 12), cadence: "MONTHLY" }]]),
      minimumSatisfiedThisCycleIds: new Set(["amazon"]),
      extraEligibleIds: new Set(["amazon"]), // Sam's Club excluded
      extraPaidThisCycleByDebtId: new Map([["sams-club", 17_578]]), // real, unrelated payoff
    });
    const extraLine = months[0].debts[0].lines.find((l) => l.kind === "extra");
    assert.ok(extraLine, "Amazon still gets a pending extra line for this payday");
    assert.equal(extraLine!.amountCents, 10_000);
  });

  test("postedExtraNettedOut reports the real extra the past-payday line consumed (2026-10-05 fix)", () => {
    const netted = new Map<string, number>();
    projectCyclePlan([debt({ id: "amazon", balanceCents: 42_228, aprBasisPoints: 0, minPaymentCents: 3_500 })], {
      order: "CUSTOM",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 10_000,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 8), // payday Mar 6 is in the past -> netting branch
      dueDateByDebtId: new Map([["amazon", { date: utc(2026, 3, 12), cadence: "MONTHLY" }]]),
      extraEligibleIds: new Set(["amazon"]),
      extraPaidThisCycleByDebtId: new Map([["amazon", 10_000]]),
      postedExtraNettedOut: netted,
    });
    assert.equal(netted.get("amazon"), 10_000);
  });

  test("a posted extra a cent short of the past-payday line leaves no $0.01 pending line", () => {
    const months = projectCyclePlan([debt({ id: "amazon", balanceCents: 42_228, aprBasisPoints: 0, minPaymentCents: 3_500 })], {
      order: "CUSTOM",
      rollFreedMinimums: false,
      extraPerPaycheckCents: 10_834,
      income: sched,
      monthsCount: 1,
      startDate: utc(2026, 3, 8),
      dueDateByDebtId: new Map([["amazon", { date: utc(2026, 3, 12), cadence: "MONTHLY" }]]),
      extraEligibleIds: new Set(["amazon"]),
      extraPaidThisCycleByDebtId: new Map([["amazon", 10_833]]),
    });
    assert.equal(months[0].debts[0].lines.filter((l) => l.pending).length, 0);
  });

  test("cross-check: with no skips/pending, end balances track simulatePayoff", () => {
    const debts = [
      debt({ id: "a", balanceCents: 30_000, aprBasisPoints: 0, minPaymentCents: 5_000 }),
      debt({ id: "b", balanceCents: 80_000, aprBasisPoints: 0, minPaymentCents: 5_000 }),
    ];
    const opts = { order: "AVALANCHE" as const, rollFreedMinimums: false, extraPerPaycheckCents: 10_000, startDate: utc(2026, 3, 1) };
    const cycle = projectCyclePlan(debts, {
      ...opts,
      income: sched,
      monthsCount: 1,
      dueDateByDebtId: new Map([
        ["a", { date: utc(2026, 3, 15), cadence: "MONTHLY" }],
        ["b", { date: utc(2026, 3, 15), cadence: "MONTHLY" }],
      ]),
      minimumSatisfiedThisCycleIds: new Set(["a", "b"]),
    });
    const sim = simulatePayoff(debts, { ...opts, rollFreedMinimums: false, income: sched, horizonMonths: 1 });
    const cycleTotalEnd = cycle[0].debts.reduce((s, d) => s + d.endBalanceCents, 0);
    const simTotalEnd = sim.timeline[0].totalRemainingCents;
    // Same continuous simulation — totals should be in the same ballpark
    // (cycle plan bills each due date exactly; sim bills once per month).
    assert.ok(Math.abs(cycleTotalEnd - simTotalEnd) <= 10_000);
  });

  test("interest accrues once per calendar month, not once per BIWEEKLY due event (2026-09-11 fix)", () => {
    // $1,000 / 24% APR / $25 BIWEEKLY minimum, due dates Mar 5 and Mar 19 —
    // two "due" events in one calendar month. Before the fix, a full
    // monthlyRateOf tick was charged at *each* due event: 2000 + 1990 = 3990
    // interest, ending at 98,990. Fixed: interest charged once (2000), for
    // an end balance of 97,000.
    const months = projectCyclePlan(
      [debt({ id: "a", debtType: "REVOLVING", balanceCents: 100_000, aprBasisPoints: 2400, minPaymentCents: 2_500, paymentCadence: "BIWEEKLY" })],
      {
        order: "AVALANCHE",
        rollFreedMinimums: false,
        extraPerPaycheckCents: 0,
        income: sched,
        monthsCount: 1,
        startDate: utc(2026, 3, 1),
        dueDateByDebtId: new Map([["a", { date: utc(2026, 3, 5), cadence: "BIWEEKLY" }]]),
      },
    );
    assert.equal(months[0].debts[0].endBalanceCents, 97_000);
  });
});

describe("supersededPayoffExtraCents", () => {
  test("ignores non-payoff snapshot rows", () => {
    const rows = [
      { weekStart: "2026-08-30", dueDate: "2026-09-03", amountCents: 5_000, isPayoff: false },
      { weekStart: "2026-09-06", dueDate: "2026-09-10", amountCents: 5_000, isPayoff: false },
    ];
    assert.equal(supersededPayoffExtraCents(rows, "2026-09-13"), 0);
  });

  test("ignores the current week's own row — that's the live target, not history", () => {
    const rows = [{ weekStart: "2026-09-13", dueDate: "2026-09-17", amountCents: 17_578, isPayoff: true }];
    assert.equal(supersededPayoffExtraCents(rows, "2026-09-13"), 0);
  });

  test("sums every earlier-week payoff row", () => {
    const rows = [
      { weekStart: "2026-09-01", dueDate: "2026-09-02", amountCents: 1_000, isPayoff: true },
      { weekStart: "2026-09-06", dueDate: "2026-09-10", amountCents: 2_500, isPayoff: true },
      { weekStart: "2026-09-13", dueDate: "2026-09-17", amountCents: 9_999, isPayoff: true },
    ];
    assert.equal(supersededPayoffExtraCents(rows, "2026-09-13"), 3_500);
  });
});

describe("supersededPayoffTargetAmounts", () => {
  test("ignores non-payoff and current-week rows, same filter as supersededPayoffExtraCents", () => {
    const rows = [
      { weekStart: "2026-08-30", dueDate: "2026-09-03", amountCents: 5_000, isPayoff: false },
      { weekStart: "2026-09-13", dueDate: "2026-09-17", amountCents: 17_578, isPayoff: true },
    ];
    assert.deepEqual(supersededPayoffTargetAmounts(rows, "2026-09-13"), []);
  });

  test("keeps each dropped target's own amount separate, not summed", () => {
    const rows = [
      { weekStart: "2026-09-01", dueDate: "2026-09-02", amountCents: 1_000, isPayoff: true },
      { weekStart: "2026-09-06", dueDate: "2026-09-10", amountCents: 2_500, isPayoff: true },
    ];
    assert.deepEqual(supersededPayoffTargetAmounts(rows, "2026-09-13"), [1_000, 2_500]);
  });

  describe("regressions", () => {
    // Real report, 2026-09-17: Sam's Club Card — a no-minimum REVOLVING card
    // excluded from the plan — paid $101.00 (Sep 1), $140.80 (Sep 8, matching
    // a dropped $140.80 Sep 3 target), then $175.78 (Sep 16, its own live
    // target, not superseded). The Payment Calendar's isExtraPaid badge used
    // to spend one shared $140.80 pool oldest-payment-first, so the *unrelated*
    // $101.00 payment claimed the badge and the $140.80 payment that actually
    // matched got nothing. Matching each payment's own amount against the
    // list this function returns (see debt-payments.ts's caller) fixes that:
    // only a payment near $140.80 can ever match.
    test("an unrelated smaller payment posting before the real match doesn't get to claim the target", () => {
      const targets = supersededPayoffTargetAmounts(
        [{ weekStart: "2026-08-30", dueDate: "2026-09-03", amountCents: 14_080, isPayoff: true }],
        "2026-09-13",
      );
      assert.deepEqual(targets, [14_080]);
      // The caller's own matching is tolerance-based (not exact-equality),
      // but tight — a plain "is there some budget left" check (the bug) would
      // have let $101.00 through; a same-amount match must not.
      const TOLERANCE = 200;
      assert.ok(Math.abs(targets[0] - 10_100) > TOLERANCE, "$101.00 is not a match for the $140.80 target");
      assert.ok(Math.abs(targets[0] - 14_080) <= TOLERANCE, "$140.80 itself still matches its own target");
    });
  });
});

describe("confirmProjectedExtras", () => {
  test("a single lump checks off consecutive projected lines oldest-first", () => {
    const out = confirmProjectedExtras(
      [{ amountCents: 5_000 }, { amountCents: 10_000 }, { amountCents: 2_500 }],
      15_000,
    );
    assert.deepEqual(
      out.map((l) => l.confirmed),
      [true, true, false],
    );
  });

  test("preserves every other field on the line", () => {
    const out = confirmProjectedExtras([{ amountCents: 100, date: "2026-09-17", isPayoff: true }], 100);
    assert.equal(out[0].date, "2026-09-17");
    assert.equal(out[0].isPayoff, true);
    assert.equal(out[0].confirmed, true);
  });

  test("superseded cents are spent before anything can be confirmed", () => {
    // $150 real, but $100 of it already retired a dropped target → only $50
    // is available, which isn't enough for the live $75 line.
    const out = confirmProjectedExtras([{ amountCents: 7_500 }], 15_000, 10_000);
    assert.equal(out[0].confirmed, false);
  });

  test("a superseded total larger than the month's real money clamps at zero", () => {
    // Never negative — a clamp failure here would let a later, smaller line
    // wrap back around into a false "confirmed".
    const out = confirmProjectedExtras([{ amountCents: 0 }, { amountCents: 1 }], 1_000, 9_999);
    assert.deepEqual(
      out.map((l) => l.confirmed),
      [true, false],
    );
  });

  describe("regressions", () => {
    // 2026-09-14: Sam's Club Card (REVOLVING, ignoreMinimumPayment) fully paid
    // off mid-month via two real payments — Sep 1 $101.00 and Sep 8 $140.80 —
    // and a new purchase then restored its balance to $175.78, which the plan
    // correctly re-projected as a fresh payoff extra for Sep 17.
    //
    // projectCyclePlan had already netted the $140.80 against the now-closed
    // prior target and dropped that line entirely (net <= 0), but all three
    // reconciliation readers independently summed *every* real extra payment
    // in the calendar month — $241.80 — and compared it against the single
    // live $175.78 line, wrongly rendering it confirmed/cleared when no money
    // had actually gone toward the post-restoration balance yet.
    //
    // The superseded PayoffExtraSnapshot row (weekStart 2026-08-30, dueDate
    // 2026-09-03, $140.80, isPayoff) is what makes that money visible as
    // already-spent; the current week's row (weekStart 2026-09-13, $175.78)
    // is the live target and must not be subtracted from itself.
    test("no-minimum revolving debt closed and reopened in one month: the fresh payoff line is not falsely confirmed", () => {
      const snapshots = [
        { weekStart: "2026-08-30", dueDate: "2026-09-03", amountCents: 14_080, isPayoff: true },
        { weekStart: "2026-09-13", dueDate: "2026-09-17", amountCents: 17_578, isPayoff: true },
      ];
      const superseded = supersededPayoffExtraCents(snapshots, "2026-09-13");
      assert.equal(superseded, 14_080);

      const realExtraCents = 10_100 + 14_080; // Sep 1 $101.00 + Sep 8 $140.80
      assert.equal(realExtraCents, 24_180);

      const lines = [{ date: "2026-09-17", amountCents: 17_578, isPayoff: true }];
      const out = confirmProjectedExtras(lines, realExtraCents, superseded);
      // $241.80 - $140.80 = $101.00 available, short of the live $175.78.
      assert.equal(out[0].confirmed, false);
    });

    test("without the superseded adjustment the same inputs confirm — the bug this protects against", () => {
      const lines = [{ date: "2026-09-17", amountCents: 17_578, isPayoff: true }];
      assert.equal(confirmProjectedExtras(lines, 24_180, 0)[0].confirmed, true);
    });

    // 2026-10-05: Amazon's Oct 1 plan extra ($108.33, paid Oct 2) was netted
    // away by projectCyclePlan's past-payday branch, then the same $108.33
    // confirmed the projected Oct 29 line too — skipping past the $108.34
    // Oct 15 line it was a cent short of.
    test("money the plan already netted against a past payday confirms nothing further", () => {
      const lines = [
        { date: "2026-10-15", amountCents: 10_834 },
        { date: "2026-10-29", amountCents: 10_833 },
      ];
      assert.deepEqual(
        confirmProjectedExtras(lines, 10_833, 0, 10_833).map((l) => l.confirmed),
        [false, false],
      );
    });

    test("a later line is never confirmed while an earlier one is still open", () => {
      const lines = [{ amountCents: 20_000 }, { amountCents: 5_000 }];
      assert.deepEqual(
        confirmProjectedExtras(lines, 15_000).map((l) => l.confirmed),
        [false, false],
      );
    });

    test("a payment a few cents short of a line still covers it (split rounding)", () => {
      const lines = [{ amountCents: 10_834 }, { amountCents: 10_833 }];
      assert.deepEqual(
        confirmProjectedExtras(lines, 10_833).map((l) => l.confirmed),
        [true, false],
      );
      // Two same-amount payments cover both; the shortfall never goes negative.
      assert.deepEqual(
        confirmProjectedExtras(lines, 21_666).map((l) => l.confirmed),
        [true, true],
      );
    });

    test("more than the tolerance short stays open", () => {
      assert.equal(confirmProjectedExtras([{ amountCents: 10_834 }], 10_700)[0].confirmed, false);
    });
  });
});

describe("splitPlanExtraPayments", () => {
  test("a payment the day after payday for the planned extra is the extra, not the minimum", async () => {
    const { splitPlanExtraPayments } = await import("@/lib/cycle-slots");
    // Regression 2026-10-03: Oct 1 payday extra $108.33, paid Oct 2.
    const pay = { amountCents: 10_833, occurredOn: utc(2026, 10, 2) };
    const r = splitPlanExtraPayments([pay], [{ date: utc(2026, 10, 1), amountCents: 10_833 }]);
    assert.deepEqual(r.planExtraPayments, [pay]);
    assert.deepEqual(r.rest, []);
  });

  test("a stale planned figure still matches within tolerance; a far-off amount or date doesn't", async () => {
    const { splitPlanExtraPayments } = await import("@/lib/cycle-slots");
    const planned = [{ date: utc(2026, 10, 1), amountCents: 10_000 }];
    assert.equal(splitPlanExtraPayments([{ amountCents: 10_833, occurredOn: utc(2026, 10, 2) }], planned).planExtraPayments.length, 1);
    assert.equal(splitPlanExtraPayments([{ amountCents: 3_500, occurredOn: utc(2026, 10, 2) }], planned).planExtraPayments.length, 0);
    assert.equal(splitPlanExtraPayments([{ amountCents: 10_000, occurredOn: utc(2026, 10, 12) }], planned).planExtraPayments.length, 0);
  });
});

describe("capAtPayoffCents", () => {
  const card = (balanceCents: number, aprBasisPoints = 0) => ({ balanceCents, aprBasisPoints, debtType: "REVOLVING" });

  test("a minimum above what's left to pay off is owed as the payoff amount", () => {
    // Household report, 2026-10-09: PayPal Credit, $65 minimum, $59.27 left at 0% APR.
    assert.equal(capAtPayoffCents(6500, card(5927)), 5927);
  });

  test("a card with interest owes the balance plus one month's interest", () => {
    // $50.00 at 24% APR: 2%/month = $1.00 of interest before the payment.
    assert.equal(payoffAmountCents(card(5000, 2400)), 5100);
    assert.equal(capAtPayoffCents(6500, card(5000, 2400)), 5100);
  });

  test("an installment plan accrues no interest per payment", () => {
    assert.equal(payoffAmountCents({ balanceCents: 1500, aprBasisPoints: 999, debtType: "INSTALLMENT" }), 1500);
  });

  test("a minimum below the payoff amount is untouched", () => {
    assert.equal(capAtPayoffCents(6500, card(20000, 2015)), 6500);
  });

  test("a paid-off debt is left to its callers' own handling", () => {
    assert.equal(payoffAmountCents(card(0)), null);
    assert.equal(capAtPayoffCents(6500, card(0)), 6500);
  });

  test("paid-so-far counts toward the headline, so a paid minimum isn't re-read as a smaller one", () => {
    // $65 paid against a $100 balance leaves $35: the cycle's minimum is
    // still $65, not $35 of minimum plus $30 extra.
    assert.equal(capAtPayoffCents(6500, card(3500), 6500), 6500);
    // $30 paid toward a $59.27 payoff leaves $29.27: the headline is $59.27.
    assert.equal(capAtPayoffCents(6500, card(2927), 3000), 5927);
  });
});

