import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  netChargeCents,
  netSpendCents,
  spendEntriesFrom,
  spendMerchantKey,
  dailySpendTrendFromTxns,
  recurringDebtPaymentCentsByDay,
  accountedForCents,
  accountedForDisplayList,
  type DebtPaymentSpendTx,
} from "@/lib/spend";
import { spendTx, dailySpendTx, utc } from "../helpers.ts";

function accountedForPurchase(overrides: Partial<Parameters<typeof spendTx>[0]> & { id?: string; merchant?: string; occurredOn?: Date } = {}) {
  const { id = "purchase-1", merchant = "Sam's Club", occurredOn = utc(2026, 9, 19), ...rest } = overrides;
  return { ...spendTx(rest), id, merchant, occurredOn };
}

describe("netChargeCents", () => {
  test("charge minus linked refunds minus partial offsets", () => {
    const t = spendTx({
      amountCents: 10_000,
      reimbursedBy: [{ amountCents: -2_500 }, { amountCents: -1_000 }], // refunds are negative
      offsetsAsDebit: [{ amountCents: 1_500 }], // offsets are positive
    });
    assert.equal(netChargeCents(t), 10_000 - 3_500 - 1_500);
  });

  test("no refunds or offsets -> the raw amount", () => {
    assert.equal(netChargeCents(spendTx({ amountCents: 4_200 })), 4_200);
  });
});

describe("netSpendCents", () => {
  test("a debit counts net of every refund linked to it", () => {
    const txns = [spendTx({ amountCents: 6_000, reimbursedBy: [{ amountCents: -1_000 }] })];
    assert.equal(netSpendCents(txns), 5_000);
  });

  test("a refund credit pointing at a specific charge contributes nothing", () => {
    const txns = [
      spendTx({ amountCents: 6_000, reimbursedBy: [{ amountCents: -1_000 }] }),
      spendTx({ amountCents: -1_000, reimbursesTransactionId: "the-charge" }),
    ];
    assert.equal(netSpendCents(txns), 5_000); // the -1000 is NOT double-subtracted
  });

  test("a credit with no specific charge still nets on its own date", () => {
    const txns = [
      spendTx({ amountCents: 6_000 }),
      spendTx({ amountCents: -1_500, reimbursesTransactionId: null }),
    ];
    assert.equal(netSpendCents(txns), 4_500);
  });
});

describe("spendEntriesFrom", () => {
  test("keeps category + merchant, applies the same netting rule", () => {
    const label = (id: string | null) => id ?? "uncategorized";
    const entries = spendEntriesFrom(
      [
        { ...spendTx({ amountCents: 5_000, reimbursedBy: [{ amountCents: -500 }] }), categoryId: "groceries", merchant: "Costco" },
        { ...spendTx({ amountCents: -500, reimbursesTransactionId: "x" }), categoryId: "groceries", merchant: "Costco" },
        { ...spendTx({ amountCents: -800, reimbursesTransactionId: null }), categoryId: null, merchant: "Venmo" },
      ],
      label,
    );
    assert.deepEqual(entries, [
      { amountCents: 4_500, categoryLabel: "groceries", merchant: "Costco" },
      { amountCents: -800, categoryLabel: "uncategorized", merchant: "Venmo" },
    ]);
  });
});

describe("spendMerchantKey", () => {
  test("a label wins over the bank merchant (P2P: 'Transfer from Venmo' -> the label)", () => {
    assert.equal(spendMerchantKey("Transfer from Venmo", "Boston Haircut"), "Boston Haircut");
    assert.equal(spendMerchantKey("Transfer from Venmo", "  Boston Haircut "), "Boston Haircut");
  });

  test("receipt-resolved party beats the bank merchant, but a label beats both", () => {
    assert.equal(spendMerchantKey("Transfer to Venmo", null, "Casey Nguyen"), "Casey Nguyen");
    assert.equal(spendMerchantKey("Transfer to Venmo", "Lemonade Stand", "Casey Nguyen"), "Lemonade Stand");
    assert.equal(spendMerchantKey("Transfer to Venmo", null, "  "), "Transfer to Venmo");
  });

  test("blank/absent label falls back to the merchant", () => {
    assert.equal(spendMerchantKey("Wingstop", null), "Wingstop");
    assert.equal(spendMerchantKey("Wingstop", undefined), "Wingstop");
    assert.equal(spendMerchantKey("Wingstop", "   "), "Wingstop");
  });

  test("a non-P2P merchant ignores an unrelated receipt's resolved party", () => {
    // A same-amount snack receipt matched a gas-station charge and resolved
    // to "Churros" — the bank merchant isn't a P2P app, so it wins.
    assert.equal(spendMerchantKey("Crestline #42", null, "Churros"), "Crestline #42");
    assert.equal(spendMerchantKey("Sam's Club", null, "Churros"), "Sam's Club");
  });

  test("a non-P2P merchant ignores its own label too — a label is just an annotation, not an identity swap", () => {
    // A $4 label meant as a note on a gas-station charge ("Churro") must not
    // replace "Crestline Flex" in the by-merchant breakdown.
    assert.equal(spendMerchantKey("Crestline Flex", "Churro", null), "Crestline Flex");
    assert.equal(spendMerchantKey("Crestline Flex", "Churros", null), "Crestline Flex");
  });

  test("a pending hold rolls up with its posted charge", () => {
    assert.equal(spendMerchantKey("Pending Holiday", null), "Holiday");
    assert.equal(spendMerchantKey("PENDING - Holiday", null), "Holiday");
    assert.equal(spendMerchantKey("Pendleton Outfitters", null), "Pendleton Outfitters");
  });
});

describe("spendEntriesFrom merchant keys", () => {
  test("uses label and strips Pending by default; merchantOf overrides", () => {
    const label = () => "c";
    const rows = [
      { ...spendTx({ amountCents: 770 }), categoryId: null, merchant: "Pending Holiday", label: null },
      { ...spendTx({ amountCents: 1273 }), categoryId: null, merchant: "Holiday", label: null },
      { ...spendTx({ amountCents: 1100 }), categoryId: null, merchant: "Transfer to Venmo", label: "Draco Slides" },
    ];
    assert.deepEqual(
      spendEntriesFrom(rows, label).map((e) => e.merchant),
      ["Holiday", "Holiday", "Draco Slides"],
    );
    assert.deepEqual(
      spendEntriesFrom(rows, label, () => "x").map((e) => e.merchant),
      ["x", "x", "x"],
    );
  });
});

describe("dailySpendTrendFromTxns", () => {
  const start = utc(2026, 9, 1);

  test("a one-time-bucket (excludedFromAllocation) charge counts toward neither series", () => {
    const txns = [
      dailySpendTx({ amountCents: 599_994, occurredOn: utc(2026, 9, 16), isOneTimeBucket: true }),
      dailySpendTx({ amountCents: 2_000, occurredOn: utc(2026, 9, 16) }),
    ];
    const trend = dailySpendTrendFromTxns(txns, start, 30);
    assert.equal(trend.oneTimeTotalCents, 2_000);
    assert.equal(trend.recurringTotalCents, 0);
  });

  test("a RECURRING/MIXED-bucket debit accrues to the recurring series, not one-time", () => {
    const txns = [dailySpendTx({ amountCents: 5_000, occurredOn: utc(2026, 9, 3), isRecurringBucket: true })];
    const trend = dailySpendTrendFromTxns(txns, start, 5);
    assert.equal(trend.recurringTotalCents, 5_000);
    assert.equal(trend.oneTimeTotalCents, 0);
    assert.deepEqual(trend.recurringCumulativeCentsByDay, [0, 0, 5_000, 5_000, 5_000]);
    assert.deepEqual(trend.oneTimeCumulativeCentsByDay, [0, 0, 0, 0, 0]);
  });

  test("a SPEND-bucket (or unbucketed) debit accrues to the one-time series", () => {
    const txns = [dailySpendTx({ amountCents: 2_000, occurredOn: utc(2026, 9, 1), isRecurringBucket: false })];
    const trend = dailySpendTrendFromTxns(txns, start, 3);
    assert.equal(trend.recurringTotalCents, 0);
    assert.equal(trend.oneTimeTotalCents, 2_000);
  });

  test("the recurring and one-time series sum to the combined total every day", () => {
    const txns = [
      dailySpendTx({ amountCents: 5_000, occurredOn: utc(2026, 9, 2), isRecurringBucket: true }),
      dailySpendTx({ amountCents: 1_200, occurredOn: utc(2026, 9, 2), isRecurringBucket: false }),
      dailySpendTx({ amountCents: 800, occurredOn: utc(2026, 9, 4), isRecurringBucket: false }),
    ];
    const trend = dailySpendTrendFromTxns(txns, start, 5);
    const combinedByDay = trend.recurringCumulativeCentsByDay.map((v, i) => v + trend.oneTimeCumulativeCentsByDay[i]);
    assert.deepEqual(combinedByDay, [0, 6_200, 6_200, 7_000, 7_000]);
    assert.equal(trend.recurringTotalCents + trend.oneTimeTotalCents, 7_000);
  });

  test("a refund still nets against its own series (recurring refund shrinks recurring, not one-time)", () => {
    const txns = [
      dailySpendTx({
        amountCents: 10_000,
        occurredOn: utc(2026, 9, 1),
        isRecurringBucket: true,
        reimbursedBy: [{ amountCents: -1_000 }],
      }),
      dailySpendTx({ amountCents: 3_000, occurredOn: utc(2026, 9, 1), isRecurringBucket: false }),
    ];
    const trend = dailySpendTrendFromTxns(txns, start, 2);
    assert.equal(trend.recurringTotalCents, 9_000);
    assert.equal(trend.oneTimeTotalCents, 3_000);
  });

  test("days outside the month window are dropped", () => {
    const txns = [
      dailySpendTx({ amountCents: 500, occurredOn: utc(2026, 8, 31), isRecurringBucket: false }),
      dailySpendTx({ amountCents: 500, occurredOn: utc(2026, 9, 6), isRecurringBucket: false }),
    ];
    const trend = dailySpendTrendFromTxns(txns, start, 5);
    assert.equal(trend.recurringTotalCents + trend.oneTimeTotalCents, 0);
  });

  test("extraRecurringPerDay (bucket-assigned debt/BNPL payments) folds into the recurring series", () => {
    const txns = [dailySpendTx({ amountCents: 1_000, occurredOn: utc(2026, 9, 1), isRecurringBucket: false })];
    const trend = dailySpendTrendFromTxns(txns, start, 3, [0, 5_000, 0]);
    assert.deepEqual(trend.recurringCumulativeCentsByDay, [0, 5_000, 5_000]);
    assert.deepEqual(trend.oneTimeCumulativeCentsByDay, [1_000, 1_000, 1_000]);
    assert.equal(trend.recurringTotalCents + trend.oneTimeTotalCents, 6_000);
  });
});

function debtTx(overrides: Partial<DebtPaymentSpendTx> = {}): DebtPaymentSpendTx {
  return {
    occurredOn: utc(2026, 9, 1),
    netCents: 1_000,
    debtPaymentId: "dp1",
    minimumCents: 1_000,
    occurrencesThisPeriod: 1,
    ...overrides,
  };
}

describe("recurringDebtPaymentCentsByDay", () => {
  const start = utc(2026, 9, 1);

  test("payoff plan ON: every dollar counts in full, no ceiling", () => {
    const txns = [debtTx({ occurredOn: utc(2026, 9, 5), netCents: 179_035, minimumCents: 179_035 })];
    const perDay = recurringDebtPaymentCentsByDay(txns, start, 10, true);
    assert.deepEqual(perDay, [0, 0, 0, 0, 179_035, 0, 0, 0, 0, 0]);
  });

  test("payoff plan OFF: caps at minimum x occurrences, extra excluded", () => {
    const txns = [
      debtTx({ occurredOn: utc(2026, 9, 2), netCents: 3_000, minimumCents: 3_000, occurrencesThisPeriod: 1 }),
      // A second, larger lump-sum payment past the cycle's minimum — none of
      // it should count (matches budgetedDebtPaymentCents's own ceiling).
      debtTx({ occurredOn: utc(2026, 9, 10), netCents: 5_000, minimumCents: 3_000, occurrencesThisPeriod: 1 }),
    ];
    const perDay = recurringDebtPaymentCentsByDay(txns, start, 15, false);
    assert.equal(perDay[1], 3_000); // day 2 (index 1): the minimum, counted
    assert.equal(perDay[9], 0); // day 10 (index 9): past the ceiling, excluded
    assert.equal(perDay.reduce((a, b) => a + b, 0), 3_000);
  });

  test("payoff plan OFF: a payment straddling the ceiling counts only its slice under it", () => {
    const txns = [
      debtTx({ occurredOn: utc(2026, 9, 3), netCents: 2_000, minimumCents: 3_000, occurrencesThisPeriod: 1 }),
      debtTx({ occurredOn: utc(2026, 9, 4), netCents: 2_000, minimumCents: 3_000, occurrencesThisPeriod: 1 }),
    ];
    const perDay = recurringDebtPaymentCentsByDay(txns, start, 10, false);
    assert.equal(perDay[2], 2_000); // day 3: fully under the $3,000 ceiling
    assert.equal(perDay[3], 1_000); // day 4: only $1,000 of this $2,000 fits
    assert.equal(perDay.reduce((a, b) => a + b, 0), 3_000);
  });

  test("two different debt payments each get their own ceiling", () => {
    const txns = [
      debtTx({ debtPaymentId: "mortgage", occurredOn: utc(2026, 9, 1), netCents: 179_035, minimumCents: 179_035 }),
      debtTx({ debtPaymentId: "auto-loan", occurredOn: utc(2026, 9, 5), netCents: 68_851, minimumCents: 68_851 }),
    ];
    const perDay = recurringDebtPaymentCentsByDay(txns, start, 10, true);
    assert.equal(perDay[0], 179_035);
    assert.equal(perDay[4], 68_851);
  });

  test("days outside the month window are dropped", () => {
    const txns = [debtTx({ occurredOn: utc(2026, 8, 15) })];
    const perDay = recurringDebtPaymentCentsByDay(txns, start, 10, true);
    assert.equal(perDay.reduce((a, b) => a + b, 0), 0);
  });
});

describe("accountedForCents", () => {
  test("no links -> 0", () => {
    assert.equal(accountedForCents({ accountedForLinks: [] }), 0);
  });

  test("sums the net amount of every linked purchase, not their gross charges", () => {
    // Real household case (2026-09-24): a Sam's Club card payment covering
    // two same-day purchases, one of them partially refunded — the payment
    // should be excluded net of the refund, not the purchase's full $185.28.
    const groceries = accountedForPurchase({
      id: "groceries",
      amountCents: 18_528,
      reimbursedBy: [{ amountCents: -872 }],
    });
    const fuel = accountedForPurchase({ id: "fuel", amountCents: 7_225 });
    const t = { accountedForLinks: [{ purchaseTransaction: groceries }, { purchaseTransaction: fuel }] };
    assert.equal(accountedForCents(t), 18_528 - 872 + 7_225);
  });
});

describe("accountedForDisplayList", () => {
  test("maps each link to its net amount and ISO date, one entry per link", () => {
    const groceries = accountedForPurchase({
      id: "groceries",
      merchant: "Sam's Club",
      amountCents: 18_528,
      reimbursedBy: [{ amountCents: -872 }],
      occurredOn: utc(2026, 9, 19),
    });
    const list = accountedForDisplayList({ accountedForLinks: [{ purchaseTransaction: groceries }] });
    assert.deepEqual(list, [{ id: "groceries", merchant: "Sam's Club", amountCents: 17_656, occurredOn: "2026-09-19" }]);
  });

  test("empty links -> empty list", () => {
    assert.deepEqual(accountedForDisplayList({ accountedForLinks: [] }), []);
  });
});
