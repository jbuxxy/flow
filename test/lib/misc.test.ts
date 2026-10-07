import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { computeProgress, oneTimeFundedOn } from "@/lib/buckets";
import { budgetedDebtPaymentCents } from "@/lib/debt-payment-budget";
import {
  classifyCadence as billClassifyCadence,
  hasRegularCadenceAnchor,
  isCadenceStale,
} from "@/lib/bill-detect";
import { classifyCadence as incomeClassifyCadence } from "@/lib/income-detect";
import { guessBillCategoryLabel } from "@/lib/bill-category";
import { countedIncomeCents } from "@/lib/reimbursements";
import { monthlyContributionToHitTarget, monthsUntilTargetDate } from "@/lib/savings";
import { bucketFloorCents, isEssentialBucket, monthlyToPerPaycheck, perPaycheckToMonthly, resolveSurplusDirection } from "@/lib/budget-plan";
import { bnplAttributionToleranceCents } from "@/lib/bnpl-detect";
import { debtNeedsSetup, debtSetupDismissKey, debtSetupReason, minPaymentDismissKey } from "@/lib/debt-payments";
import { isCardPaymentDescriptor, isGenericCardPaymentDescriptor, debtNameMatchesMerchant, txnTextNamesDebt, scopeToNamedDebts, issuerCoreName } from "@/lib/debt-payment-pattern";
import { accessLevelFor } from "@/lib/member-access";
import { defaultNotificationEnabled } from "@/lib/notification-preferences";
import { pickableDebtWhere } from "@/lib/debt-reassign";
import { isAssetStale } from "@/lib/asset-staleness";
import { bankDescriptionFor, deriveP2PDisplay } from "@/lib/transaction-display";
import {
  extraTowardPrincipalCents,
  occurrenceSettledAfterWeek,
  parkedOccurrenceSettledLate,
  payoffBadgeLabel,
  principalTowardDebtCents,
} from "@/lib/upcoming-bills-shared";
import { isIgnorableVenmoNotification, looksLikeReceipt } from "@/lib/receipt-parse";
import { monthsAgoPeriodKey, periodLabel } from "@/lib/monthly-report";
import { purgeCutoffDate } from "@/lib/hidden-items";
import { utc } from "../helpers.ts";

describe("buckets.budgetedDebtPaymentCents", () => {
  test("payoff plan ON: every dollar counts, no ceiling, nothing excluded", () => {
    assert.deepEqual(
      budgetedDebtPaymentCents({ paidCents: 50_000, minimumCents: 3_000, occurrencesThisPeriod: 1, payoffPlanEnabled: true }),
      { countedCents: 50_000, excludedCents: 0 },
    );
  });

  test("payoff plan OFF: counts up to minimum x occurrences, annotates the rest", () => {
    assert.deepEqual(
      budgetedDebtPaymentCents({ paidCents: 5_000, minimumCents: 3_000, occurrencesThisPeriod: 1, payoffPlanEnabled: false }),
      { countedCents: 3_000, excludedCents: 2_000 },
    );
    assert.deepEqual(
      budgetedDebtPaymentCents({ paidCents: 10_000, minimumCents: 3_000, occurrencesThisPeriod: 2, payoffPlanEnabled: false }),
      { countedCents: 6_000, excludedCents: 4_000 },
    );
  });

  test("payoff plan OFF: zero occurrences still allows one minimum", () => {
    assert.deepEqual(
      budgetedDebtPaymentCents({ paidCents: 3_000, minimumCents: 3_000, occurrencesThisPeriod: 0, payoffPlanEnabled: false }),
      { countedCents: 3_000, excludedCents: 0 },
    );
  });

  test("negative paidCents floors at 0", () => {
    const r = budgetedDebtPaymentCents({ paidCents: -100, minimumCents: 3_000, occurrencesThisPeriod: 1, payoffPlanEnabled: false });
    assert.equal(r.countedCents, 0);
    assert.equal(r.excludedCents, 0);
  });
});

describe("buckets.computeProgress", () => {
  const bucket = {
    id: "b", name: "Groceries", monthlyCapCents: 100_000, warningThresholdPct: 80,
    paceAlertEnabled: true, paceSensitivity: 1, trackingMode: "SPEND" as const, icon: null, excludedFromAllocation: false,
  };

  test("spentPct and projected month-end from the pace fraction", () => {
    const p = computeProgress(bucket, 30_000, 0.5, "calendar", false);
    assert.equal(p.spentPct, 30);
    assert.equal(p.projectedMonthEndCents, 60_000); // 30000 / 0.5
    assert.equal(p.remainingCents, 70_000);
  });

  test("onPaceToOvershoot compares spend against cap x paceFraction x sensitivity", () => {
    assert.equal(computeProgress(bucket, 60_000, 0.5, "calendar", false).onPaceToOvershoot, true);
    assert.equal(computeProgress(bucket, 40_000, 0.5, "calendar", false).onPaceToOvershoot, false);
    assert.equal(computeProgress({ ...bucket, paceAlertEnabled: false }, 90_000, 0.5, "calendar", false).onPaceToOvershoot, false);
  });

  test("a zero cap yields spentPct 0 rather than dividing by zero", () => {
    assert.equal(computeProgress({ ...bucket, monthlyCapCents: 0 }, 5_000, 0.5, "calendar", false).spentPct, 0);
  });
});

describe("classifyCadence (bills)", () => {
  test("recognises each cadence within tolerance", () => {
    assert.deepEqual(billClassifyCadence([7, 7, 8]), { cadence: "WEEKLY" });
    assert.deepEqual(billClassifyCadence([14, 14, 15]), { cadence: "BIWEEKLY" });
    assert.deepEqual(billClassifyCadence([30, 31, 29]), { cadence: "MONTHLY" });
    assert.deepEqual(billClassifyCadence([365, 366]), { cadence: "ANNUAL" });
  });
  test("rejects an irregular history", () => {
    assert.equal(billClassifyCadence([5, 30, 12]), null);
    assert.equal(billClassifyCadence([30, 30, 45]), null); // maxDev too high
  });
});

describe("hasRegularCadenceAnchor", () => {
  const day = (n: number) => utc(2026, 3, Math.min(n, 28)); // month-agnostic, just need the day-of-month
  const onDays = (days: number[]) => days.map((d, i) => utc(2026, 3 + i, d));

  test("MONTHLY: a consistent day-of-month passes", () => {
    assert.equal(hasRegularCadenceAnchor(onDays([14, 15, 14, 14]), "MONTHLY"), true);
  });

  test("MONTHLY: a '31st' bill landing on 28/30/31 still passes (3-day tolerance)", () => {
    assert.equal(hasRegularCadenceAnchor([utc(2026, 1, 31), utc(2026, 2, 28), utc(2026, 3, 31), utc(2026, 4, 30)], "MONTHLY"), true);
  });

  test("MONTHLY regression (2026-09-09): scattered high-volume-merchant days fail", () => {
    // Real Amazon days-of-month from the $65 false-positive cluster.
    const amazonDays = [16, 18, 21, 24, 26, 4, 9, 11, 2].map((d, i) => utc(2026, 3 + i, d));
    assert.equal(hasRegularCadenceAnchor(amazonDays, "MONTHLY"), false);
  });

  test("WEEKLY/BIWEEKLY are trusted from the gap check alone (not day-anchored here)", () => {
    assert.equal(hasRegularCadenceAnchor([day(3), day(10), day(24)], "WEEKLY"), true);
  });

  test("fewer than 3 dates -> not enough to judge, passes", () => {
    assert.equal(hasRegularCadenceAnchor([day(1), day(2)], "MONTHLY"), true);
  });
});

describe("isCadenceStale", () => {
  const now = utc(2026, 9, 9);
  test("MONTHLY: last seen ~50 days ago is not yet stale (2-cycle window)", () => {
    assert.equal(isCadenceStale(utc(2026, 7, 21), "MONTHLY", now), false);
  });
  test("MONTHLY: last seen ~4 months ago is stale", () => {
    assert.equal(isCadenceStale(utc(2026, 5, 1), "MONTHLY", now), true);
  });
  test("ANNUAL: quiet for months is fine", () => {
    assert.equal(isCadenceStale(utc(2026, 3, 1), "ANNUAL", now), false);
  });
});

describe("classifyCadence (income)", () => {
  test("distinguishes biweekly from semi-monthly by deviation", () => {
    assert.deepEqual(incomeClassifyCadence([14, 14, 14]), { cadence: "BIWEEKLY", periodDays: 14 });
    // Tight ~14/~17 alternation still reads as biweekly (first, permissive check).
    assert.deepEqual(incomeClassifyCadence([14, 17, 14, 17]), { cadence: "BIWEEKLY", periodDays: 14 });
    // A wider swing (maxDev > 3) around a ~15-day mean is semi-monthly.
    assert.deepEqual(incomeClassifyCadence([12, 19, 12, 19]), { cadence: "SEMI_MONTHLY", periodDays: 15 });
    assert.deepEqual(incomeClassifyCadence([30, 31]), { cadence: "MONTHLY", periodDays: 30 });
  });
  test("scattered credits whose mean happens to be ~15 days aren't semi-monthly", () => {
    // Real Venmo pattern: same-day pairs, a few days apart, then a 75-day gap.
    assert.equal(incomeClassifyCadence([2, 8, 1, 0, 3, 3, 75]), null);
    // Same for monthly: a ~30-day mean built from a 5 and a 55.
    assert.equal(incomeClassifyCadence([5, 55]), null);
  });
});

describe("guessBillCategoryLabel", () => {
  test("keyword cascade", () => {
    assert.equal(guessBillCategoryLabel("Rocket Mortgage"), "Mortgage/Rent");
    assert.equal(guessBillCategoryLabel("State Farm Insurance"), "Insurance");
    assert.equal(guessBillCategoryLabel("Valley Power"), "Utilities");
    assert.equal(guessBillCategoryLabel("Best Egg Loan"), "Loan payment");
    assert.equal(guessBillCategoryLabel("Netflix"), "Subscription");
    assert.equal(guessBillCategoryLabel("Some Random Merchant"), "Other");
  });
});

describe("reimbursements.countedIncomeCents", () => {
  test("credit minus its offsets, floored at 0", () => {
    assert.equal(countedIncomeCents(10_000, 3_000), 7_000);
    assert.equal(countedIncomeCents(10_000, 15_000), 0);
  });
});

describe("savings pace math", () => {
  test("monthsUntilTargetDate: null date -> null; past/near date -> at least 1", () => {
    assert.equal(monthsUntilTargetDate(null), null);
    assert.equal(monthsUntilTargetDate(new Date(Date.now() - 86_400_000)), 1);
    assert.equal(monthsUntilTargetDate(new Date(Date.now() + 365 * 86_400_000)), 12); // 365 / 30.44 -> ceil 12
  });

  test("monthlyContributionToHitTarget: ceil(remaining/months); null when nothing to save or no date", () => {
    const target = new Date(Date.now() + 300 * 86_400_000); // ~9.85 months -> 10
    assert.equal(monthlyContributionToHitTarget(100_000, target), Math.ceil(100_000 / 10));
    assert.equal(monthlyContributionToHitTarget(0, target), null);
    assert.equal(monthlyContributionToHitTarget(100_000, null), null);
  });
});

describe("budget-plan pure helpers", () => {
  test("monthlyToPerPaycheck / perPaycheckToMonthly round-trip", () => {
    assert.equal(monthlyToPerPaycheck(400_000, "BIWEEKLY", "BIWEEKLY_CONSERVATIVE"), 200_000);
    assert.equal(perPaycheckToMonthly(200_000, "BIWEEKLY", "BIWEEKLY_CONSERVATIVE"), 400_000);
    assert.equal(monthlyToPerPaycheck(300_000, null, "MONTHLY_AVERAGE"), 300_000); // no cadence -> passthrough
  });

  test("bucketFloorCents = debt floor + projected recurring", () => {
    assert.equal(bucketFloorCents({ debtFloorCents: 5_000, projectedRecurringCents: 12_000 }), 17_000);
    assert.equal(bucketFloorCents({ debtFloorCents: 5_000, projectedRecurringCents: null }), 5_000);
  });

  test("resolveSurplusDirection: the 6-case matrix, never NONE", () => {
    assert.equal(resolveSurplusDirection({ goalPosture: "DEBT_PAYDOWN", attackableDebtCents: 1 }), "DEBT");
    assert.equal(resolveSurplusDirection({ goalPosture: "DEBT_PAYDOWN", attackableDebtCents: 0 }), "SAVINGS");
    assert.equal(resolveSurplusDirection({ goalPosture: "SAVINGS_FOCUSED", attackableDebtCents: 1 }), "SAVINGS");
    assert.equal(resolveSurplusDirection({ goalPosture: "SAVINGS_FOCUSED", attackableDebtCents: 0 }), "SAVINGS");
    assert.equal(resolveSurplusDirection({ goalPosture: "BALANCED", attackableDebtCents: 1 }), "SPLIT");
    assert.equal(resolveSurplusDirection({ goalPosture: "BALANCED", attackableDebtCents: 0 }), "SAVINGS");
  });

  test("isEssentialBucket by name or filed categories", () => {
    assert.equal(isEssentialBucket({ name: "Groceries" }), true);
    assert.equal(isEssentialBucket({ name: "Fun Money" }), false);
    assert.equal(
      isEssentialBucket({
        name: "Household",
        composition: { totalCents: 0, txnCount: 0, topMerchants: [], topLabels: [], topCategories: ["Electric Utility"] },
      }),
      true,
    );
  });
});

describe("bnpl-detect.bnplAttributionToleranceCents", () => {
  test("wider of 5% or $1", () => {
    assert.equal(bnplAttributionToleranceCents(100_00), 500);
    assert.equal(bnplAttributionToleranceCents(10_00), 100);
  });
});

describe("debt-payments setup helpers", () => {
  const revolving = { debtType: "REVOLVING" as const, termsConfirmed: true, balanceCents: 50_000, minPaymentCents: 2_500, ignoreMinimumPayment: false };

  test("debtSetupReason priority chain", () => {
    assert.equal(debtSetupReason({ ...revolving, debtType: "INSTALLMENT" }, true, false), null);
    assert.equal(debtSetupReason({ ...revolving, termsConfirmed: false }, true, false), "Add APR/minimum payment");
    assert.equal(debtSetupReason({ ...revolving, minPaymentCents: 0 }, true, false), "Confirm minimum payment");
    assert.equal(debtSetupReason({ ...revolving, minPaymentCents: 0, ignoreMinimumPayment: true }, true, false), null);
    assert.equal(debtSetupReason(revolving, false, false), "Add a due date");
    assert.equal(debtSetupReason(revolving, true, true), "Confirm minimum payment change");
    assert.equal(debtSetupReason(revolving, true, false), null);
  });

  test("debtNeedsSetup is just 'reason !== null'", () => {
    assert.equal(debtNeedsSetup(revolving, true, false), false);
    assert.equal(debtNeedsSetup({ ...revolving, termsConfirmed: false }, true, false), true);
  });

  test("dismiss keys", () => {
    assert.equal(debtSetupDismissKey("d1", "Add a due date"), "d1:Add a due date");
    assert.equal(minPaymentDismissKey({ id: "d1", minPaymentCents: 2_500, aprBasisPoints: 1999 }), "d1:2500:1999");
  });
});

describe("debt-payment-pattern", () => {
  test("isCardPaymentDescriptor needs a payment token AND a card/loan context token", () => {
    assert.equal(isCardPaymentDescriptor("AUTOMATIC WITHDRAWAL, SAMSCLUB MSTRCRD SYF PAYMNT WEB"), true);
    assert.equal(isCardPaymentDescriptor("AUTOMATIC WITHDRAWAL FAIRVIEW WATER PYMT"), false); // no card context
    assert.equal(isCardPaymentDescriptor("SAMSCLUB #6304 POS PURCHASE"), false);
    assert.equal(isCardPaymentDescriptor(null), false);
  });

  test("isGenericCardPaymentDescriptor catches issuer-generated payment lines", () => {
    assert.equal(isGenericCardPaymentDescriptor("Capital One Credit Card Payment"), true);
    assert.equal(isGenericCardPaymentDescriptor("CARDMEMBER SERV WEB PYMT"), true);
    assert.equal(isGenericCardPaymentDescriptor("Chase Card ePay"), true);
    assert.equal(isGenericCardPaymentDescriptor("Sam's Club"), false);
  });

  test("debtNameMatchesMerchant: normalized substring with a 4-char floor", () => {
    assert.equal(debtNameMatchesMerchant("Sam's Club", "Sam's Club Mastercard"), true);
    assert.equal(debtNameMatchesMerchant("BP", "BP Visa"), false); // too short
  });

  test("txnTextNamesDebt checks merchant vs name and raw line vs account org", () => {
    assert.equal(
      txnTextNamesDebt({ merchant: "Sam's Club", rawDescription: "ACH SAMSCLUB MSTRCRD" }, { name: "Sam's Club Mastercard", accountOrgName: "Synchrony" }),
      true,
    );
    assert.equal(
      txnTextNamesDebt({ merchant: "Shell", rawDescription: "POS SHELL OIL" }, { name: "Amazon Store Card", accountOrgName: "Synchrony" }),
      false,
    );
  });

  test("txnTextNamesDebt matches the issuer brand when the org name carries a corporate suffix", () => {
    // Regression 2026-10-05: "CHASE CREDIT CRD EPAY" never contained "chasebank".
    assert.equal(
      txnTextNamesDebt(
        { merchant: "Chase Credit Card", rawDescription: "AUTOMATIC WITHDRAWAL, CHASE CREDIT CRD EPAY WEB (S)" },
        { name: "Store Rewards Visa (1234)", accountOrgName: "Chase Bank" },
      ),
      true,
    );
    assert.equal(issuerCoreName("Wells Fargo Bank, N.A."), "Wells Fargo");
    assert.equal(issuerCoreName("Bank of America"), "Bank of America");
    assert.equal(issuerCoreName("Capital One"), "Capital One");
  });

  test("scopeToNamedDebts keeps a named issuer's payment off another issuer's same-minimum debt", () => {
    const store = { name: "Store Rewards Mastercard", accountOrgName: "Synchrony", min: 2900 };
    const travel = { name: "Travel Card", accountOrgName: "Capital One", min: 8400 };
    const cashback = { name: "Cashback Card", accountOrgName: "Capital One", min: 2500 };
    const all = [store, travel, cashback];
    const id = (d: typeof store) => d;
    // Regression 2026-09-29: $29 Capital One payment matched the Synchrony card's $29 minimum.
    const capOne = { merchant: "Capital One Credit Card Payment", rawDescription: "AUTOMATIC WITHDRAWAL, CAPITAL ONE CRCARDPMT TEL" };
    assert.deepEqual(scopeToNamedDebts(capOne, all, all, id), [travel, cashback]);
    // Named issuer but none of its debts are candidates -> nothing to guess from.
    assert.deepEqual(scopeToNamedDebts(capOne, all, [store], id), []);
    // Text names no issuer -> candidates untouched.
    const generic = { merchant: "Online Payment", rawDescription: "ONLINE PMT THANK YOU" };
    assert.deepEqual(scopeToNamedDebts(generic, all, all, id), all);
  });
});

describe("access-level helpers", () => {
  test("accessLevelFor collapses the Role x DashboardScope matrix", () => {
    assert.equal(accessLevelFor("OWNER", "BUCKETS_ONLY"), "OWNER");
    assert.equal(accessLevelFor("PARENT", "FULL"), "PARTNER");
    assert.equal(accessLevelFor("CHILD", "BUCKETS_ONLY"), "BASIC");
    assert.equal(accessLevelFor("PARENT", "BUCKETS_ONLY"), "BASIC");
  });

  test("defaultNotificationEnabled is role-aware", () => {
    const owner = { role: "OWNER", dashboardScope: "FULL" };
    const kid = { role: "CHILD", dashboardScope: "BUCKETS_ONLY" };
    assert.equal(defaultNotificationEnabled(owner, "DEBT_AMOUNT_REVIEW"), true);
    assert.equal(defaultNotificationEnabled(kid, "DEBT_AMOUNT_REVIEW"), false); // owner-only type
    assert.equal(defaultNotificationEnabled(kid, "NEW_CYCLE"), true); // in scope for everyone
  });
});

describe("debt-reassign.pickableDebtWhere", () => {
  test("excludes hidden debts and paid-off loans/BNPL, keeps paid-off cards", () => {
    assert.deepEqual(pickableDebtWhere(), { hiddenAt: null, OR: [{ kind: "CARD" }, { balanceCents: { gt: 0 } }] });
  });
});

describe("asset-staleness.isAssetStale", () => {
  test("stale after 3 months untouched", () => {
    const now = utc(2026, 6, 1);
    assert.equal(isAssetStale(utc(2026, 2, 1), now), true);
    assert.equal(isAssetStale(utc(2026, 4, 1), now), false);
  });
});

describe("transaction-display", () => {
  test("deriveP2PDisplay renders 'App · Counterparty' when both are known", () => {
    const d = deriveP2PDisplay({
      resolvedMerchant: "Jane Doe",
      resolvedMerchantIsPerson: true,
      receiptPaidWith: "Venmo",
      merchant: "VENMO",
    });
    assert.equal(d.p2pTitle, "Venmo · Jane Doe");
    assert.equal(d.displayMerchant, "Venmo · Jane Doe");
    assert.equal(d.logoMerchant, "Venmo");
  });

  test("bankDescriptionFor only surfaces a raw line that adds information", () => {
    assert.equal(bankDescriptionFor({ rawDescription: "SQ *BLUE BOTTLE", merchant: "Blue Bottle" }), "SQ *BLUE BOTTLE");
    assert.equal(bankDescriptionFor({ rawDescription: "blue bottle", merchant: "Blue Bottle" }), null);
    assert.equal(bankDescriptionFor({ rawDescription: null, merchant: "Blue Bottle" }), null);
  });
});

describe("upcoming-bills-shared.principalTowardDebtCents", () => {
  test("surplus, plus planned extra only once it has actually landed", () => {
    assert.equal(principalTowardDebtCents({ extraCents: 5_000, plannedExtraCents: 20_000, paid: false }), 5_000);
    assert.equal(principalTowardDebtCents({ extraCents: 5_000, plannedExtraCents: 20_000, paid: true }), 25_000);
  });
});

describe("upcoming-bills-shared.extraTowardPrincipalCents", () => {
  const base = {
    tracksMinimum: false,
    minimumMet: true,
    receivedThisCycleCents: 0,
    rawReceivedCents: 0,
    cycleMinimumCents: 0,
    plannedExtraCents: 0,
    extraFloorCents: 500,
    planDriven: true,
  };

  test("regression 2026-09-21: a no-minimum debt's own weekly payment exactly matching its plan target is $0 extra, even with an unrelated earlier week's payment sitting in the same cycle total (Sam's Club: $316.58 -> $0)", () => {
    assert.equal(
      extraTowardPrincipalCents({
        ...base,
        receivedThisCycleCents: 31_658, // this cycle's Sep 8 ($140.80) + Sep 16 ($175.78)
        rawReceivedCents: 17_578, // only Sep 16's own payment landed this week
        plannedExtraCents: 17_578, // the week's own plan target
      }),
      0,
    );
  });

  test("a no-minimum debt's weekly payment genuinely beyond its own target reads as real extra", () => {
    assert.equal(
      extraTowardPrincipalCents({ ...base, receivedThisCycleCents: 20_000, rawReceivedCents: 20_000, plannedExtraCents: 17_578 }),
      2_422,
    );
  });

  test("a real minimum paid in an earlier week doesn't get re-subtracted from a later payoff week's extra (2026-08-28, Trailer Loan)", () => {
    assert.equal(
      extraTowardPrincipalCents({
        ...base,
        tracksMinimum: true,
        receivedThisCycleCents: 400_000, // the $92 minimum (paid earlier) + this week's $3,999 payoff
        rawReceivedCents: 399_900, // only the payoff itself landed this week
        cycleMinimumCents: 9_200,
        plannedExtraCents: 0,
      }),
      390_800,
    );
  });

  test("not minimumMet, below the confidence floor, or not plan-driven all read $0", () => {
    assert.equal(extraTowardPrincipalCents({ ...base, minimumMet: false, rawReceivedCents: 50_000, receivedThisCycleCents: 50_000 }), 0);
    assert.equal(extraTowardPrincipalCents({ ...base, rawReceivedCents: 400, receivedThisCycleCents: 400 }), 0);
    assert.equal(extraTowardPrincipalCents({ ...base, planDriven: false, rawReceivedCents: 50_000, receivedThisCycleCents: 50_000 }), 0);
  });
});

describe("upcoming-bills-shared.occurrenceSettledAfterWeek", () => {
  describe("regressions", () => {
    // 2026-09-29: loan due Sep 25 (week 9/20–9/26), paid Sep 28 inside the
    // rollover grace window — Last Week's Bills still listed it unpaid.
    test("a payment posting after the week, on/after the due date, settles it", () => {
      const opts = { nextDueDate: utc(2026, 9, 25), weekEnd: utc(2026, 9, 27), owedCents: 34_172 };
      assert.equal(occurrenceSettledAfterWeek({ ...opts, payments: [{ amountCents: 34_172, occurredOn: utc(2026, 9, 28) }] }), true);
      // The prior cycle's payment (Aug 26) doesn't count.
      assert.equal(occurrenceSettledAfterWeek({ ...opts, payments: [{ amountCents: 34_172, occurredOn: utc(2026, 8, 26) }] }), false);
      // A partial late payment doesn't settle it.
      assert.equal(occurrenceSettledAfterWeek({ ...opts, payments: [{ amountCents: 10_000, occurredOn: utc(2026, 9, 28) }] }), false);
      // Lender-feed credit legs are negative.
      assert.equal(occurrenceSettledAfterWeek({ ...opts, payments: [{ amountCents: -34_172, occurredOn: utc(2026, 9, 29) }] }), true);
      assert.equal(occurrenceSettledAfterWeek({ ...opts, owedCents: 0, payments: [] }), false);
    });
  });
});

describe("upcoming-bills-shared.parkedOccurrenceSettledLate", () => {
  describe("regressions", () => {
    // 2026-10-05: Voyager Loan due Sat Oct 3, paid Mon Oct 5 (week 10/4–10/10)
    // — the Sep 5 payment for the Sep 3 occurrence got counted in the same
    // cycle window and $688.51 read as Extra To Principal.
    test("a payment after a pre-week due date settles the parked occurrence", () => {
      const opts = { nextDueDate: utc(2026, 10, 3), weekStart: utc(2026, 10, 4), owedCents: 68_851 };
      const late = { amountCents: -68_851, occurredOn: utc(2026, 10, 5) };
      const prior = { amountCents: -68_851, occurredOn: utc(2026, 9, 5) };
      assert.equal(parkedOccurrenceSettledLate({ ...opts, payments: [late, prior] }), true);
      // Only the prior occurrence's payment — not settled.
      assert.equal(parkedOccurrenceSettledLate({ ...opts, payments: [prior] }), false);
      // Partial late payment — not settled.
      assert.equal(parkedOccurrenceSettledLate({ ...opts, payments: [{ ...late, amountCents: -10_000 }] }), false);
      // Due date inside this week isn't "parked" — the in-week path handles it.
      assert.equal(parkedOccurrenceSettledLate({ ...opts, nextDueDate: utc(2026, 10, 5), payments: [late] }), false);
      assert.equal(parkedOccurrenceSettledLate({ ...opts, owedCents: 0, payments: [late] }), false);
    });
  });
});

describe("upcoming-bills-shared.payoffBadgeLabel", () => {
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  const row = (o: Partial<Parameters<typeof payoffBadgeLabel>[0]> = {}) => ({
    extraCents: 0,
    plannedExtraCents: 0,
    minimumDueCents: 0,
    paid: false,
    plannedPayoff: true,
    ...o,
  });

  test("not a projected payoff -> no badge", () => {
    assert.equal(payoffBadgeLabel(row({ plannedPayoff: false }), fmt), null);
  });

  test("regression (2026-09-09): a payoff whose extra IS the whole payment reads 'Paid Off!'", () => {
    // Capital One Quicksilver: $25 min paid earlier in the cycle, $37.72 on
    // the payoff payday counted 100% as extra, minimumDueCents 0 this week.
    assert.equal(payoffBadgeLabel(row({ extraCents: 3_772, paid: true, minimumDueCents: 0 }), fmt), "Paid Off!");
  });

  test("no-minimum card reads 'Paid Off!' (unchanged)", () => {
    // Sam's Club Card: ignoreMinimumPayment, whole $140.80 is just a payment.
    assert.equal(payoffBadgeLabel(row({ paid: true, minimumDueCents: 0, plannedExtraCents: 0 }), fmt), "Paid Off!");
  });

  test("'+$X For Payoff!' only when the extra is additional to a minimum on the row", () => {
    assert.equal(
      payoffBadgeLabel(row({ minimumDueCents: 2_500, plannedExtraCents: 3_500, paid: false }), fmt),
      "+$35.00 For Payoff!",
    );
  });
});

describe("monthly-report period helpers", () => {
  test("periodLabel is a human month + year", () => {
    assert.equal(periodLabel("2026-02"), "February 2026");
    assert.equal(periodLabel("2026-12"), "December 2026");
  });

  test("monthsAgoPeriodKey walks back N calendar months, zero-padded", () => {
    const from = new Date(2026, 2, 15); // March 2026, local
    assert.equal(monthsAgoPeriodKey(0, from), "2026-03");
    assert.equal(monthsAgoPeriodKey(1, from), "2026-02");
    assert.equal(monthsAgoPeriodKey(3, from), "2025-12"); // crosses the year
  });
});

describe("hidden-items.purgeCutoffDate", () => {
  test("is one year before now", () => {
    const cutoff = purgeCutoffDate();
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(Date.now() - cutoff.getTime() - yearMs) < 2_000);
  });
});

describe("receipt-parse", () => {
  test("looksLikeReceipt: known sender + money, or unknown sender + money + phrase", () => {
    assert.equal(looksLikeReceipt({ subject: "Your order", from: "orders@amazon.com", text: "Total $42.00" }), true);
    assert.equal(looksLikeReceipt({ subject: "hi", from: "friend@example.com", text: "lunch was fun" }), false);
    assert.equal(looksLikeReceipt({ subject: "Your receipt", from: "friend@example.com", text: "Order total: $12.99" }), true);
  });

  test("isIgnorableVenmoNotification drops teen-card / cash-out / request noise", () => {
    assert.equal(
      isIgnorableVenmoNotification({ subject: "Kid made a $5 purchase with their debit card", from: "venmo@venmo.com", text: "" }),
      true,
    );
    assert.equal(
      isIgnorableVenmoNotification({ subject: "Transfer initiated", from: "venmo@venmo.com", text: "to your bank" }),
      true,
    );
    assert.equal(
      isIgnorableVenmoNotification({ subject: "You paid Jane $20", from: "venmo@venmo.com", text: "from your Checking account" }),
      false,
    );
    assert.equal(isIgnorableVenmoNotification({ subject: "Your order", from: "amazon.com", text: "" }), false);
  });
});

describe("oneTimeFundedOn", () => {
  const d = (day: number) => new Date(Date.UTC(2026, 8, day));
  test("the day the running total first reaches the target", () => {
    assert.deepEqual(oneTimeFundedOn([{ amountCents: 200_000, occurredOn: d(3) }, { amountCents: 400_000, occurredOn: d(17) }], 600_000), d(17));
  });
  test("not funded while short of the target", () => {
    assert.equal(oneTimeFundedOn([{ amountCents: 599_000, occurredOn: d(17) }], 600_000), null);
  });
  test("a refund that drops it back under un-funds it", () => {
    assert.equal(
      oneTimeFundedOn([{ amountCents: 600_000, occurredOn: d(17) }, { amountCents: -50_000, occurredOn: d(20) }], 600_000),
      null,
    );
  });
});

describe("refund receipts", () => {
  test("refundItemsMatch ties a returned item to the purchase that had it, ignoring tax", async () => {
    const { refundItemsMatch } = await import("@/lib/receipt-match");
    // Regression 2026-10-04: a $16.13 serveware return off a grocery order.
    const order = [{ description: "UTZ PRETZELS" }, { description: "SERVEWARE" }, { description: "Tax" }];
    assert.equal(refundItemsMatch([{ description: "Serveware" }, { description: "Tax" }], order), true);
    assert.equal(refundItemsMatch([{ description: "Patio Chair" }, { description: "Tax" }], order), false);
    assert.equal(refundItemsMatch([{ description: "Tax" }], [{ description: "Tax" }]), false);
  });

  test("a refund receipt only matches credits", async () => {
    const { receiptAmountWhere, receiptSignMatches } = await import("@/lib/receipt-match");
    const r = { kind: "PAYMENT_RECEIVED", party: "Store", partyIsPerson: false, p2pApp: null, isRefund: true };
    assert.deepEqual(receiptAmountWhere(r, 1613), { amountCents: -1613 });
    assert.equal(receiptSignMatches(r, 1613), false);
    assert.equal(receiptSignMatches(r, -1613), true);
  });
});
