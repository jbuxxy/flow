import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  decideReceiptReclass,
  isReceiptReclassCandidate,
  RECLASS_MIN_CONFIDENCE,
  type ReclassBucket,
  type ReclassCandidateTx,
} from "@/lib/receipt-reclassify";

const buckets = new Map<string, ReclassBucket>([
  ["groceries", { id: "groceries", trackingMode: "SPEND", excludedFromAllocation: false }],
  ["bills", { id: "bills", trackingMode: "RECURRING", excludedFromAllocation: false }],
  ["tesla", { id: "tesla", trackingMode: "SPEND", excludedFromAllocation: true }],
]);

// The Sam's Club fuel charge: filed under Groceries, receipt says unleaded.
const samsFuel: ReclassCandidateTx = {
  merchant: "Sam's Club",
  resolvedMerchant: "Sam's Club",
  amountCents: 7_225,
  bucketId: "groceries",
  isTransfer: false,
  isIncome: false,
  debtId: null,
  debtPaymentId: null,
  patternId: null,
  incomeId: null,
  billId: null,
  reimbursesTransactionId: null,
  receiptReclassAt: null,
  receiptItems: [{ description: "Fuel - unlead", qty: 16.059, unitPriceCents: null, totalCents: 7_225 }],
  account: { budgetTracked: true },
};

describe("isReceiptReclassCandidate", () => {
  test("a plain receipt-matched charge in an ordinary bucket is a candidate", () => {
    assert.equal(isReceiptReclassCandidate(samsFuel, buckets), true);
  });

  test("already decided (or manually reassigned) is never revisited", () => {
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, receiptReclassAt: new Date() }, buckets), false);
  });

  test("no receipt items, refunds, transfers, income and non-budget accounts are skipped", () => {
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, receiptItems: null }, buckets), false);
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, receiptItems: [] }, buckets), false);
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, amountCents: -3_098 }, buckets), false);
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, isTransfer: true }, buckets), false);
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, isIncome: true }, buckets), false);
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, account: { budgetTracked: false } }, buckets), false);
  });

  test("bill, debt-payment, pattern and reimbursement links are never touched", () => {
    for (const patch of [
      { billId: "b" },
      { debtId: "d" },
      { debtPaymentId: "dp" },
      { patternId: "p" },
      { incomeId: "i" },
      { reimbursesTransactionId: "t" },
    ]) {
      assert.equal(isReceiptReclassCandidate({ ...samsFuel, ...patch }, buckets), false);
    }
  });

  test("a receipt for a different merchant is ignored (a Google Cloud receipt matched a $10 car wash)", () => {
    const carWash = { ...samsFuel, merchant: "Sparkle Tunnel Wash", resolvedMerchant: "Google" };
    assert.equal(isReceiptReclassCandidate(carWash, buckets), false);
  });

  test("a receipt whose party is missing can't be verified and is skipped", () => {
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, resolvedMerchant: null }, buckets), false);
  });

  test("the same merchant written differently still passes", () => {
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, merchant: "Amazon", resolvedMerchant: "Amazon.com" }, buckets), true);
  });

  test("uncategorized, RECURRING-bucket and one-time-bucket sources are skipped", () => {
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, bucketId: null }, buckets), false);
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, bucketId: "bills" }, buckets), false);
    assert.equal(isReceiptReclassCandidate({ ...samsFuel, bucketId: "tesla" }, buckets), false);
  });
});

describe("decideReceiptReclass", () => {
  const base = { currentBucketId: "groceries", suggestedBucketId: "fuel", confidence: 0.95, targetIsOrdinary: true };

  test("a confident, different, ordinary bucket wins (Groceries -> Fuel)", () => {
    assert.equal(decideReceiptReclass(base), "fuel");
  });

  test("the same bucket, or no suggestion, leaves it alone", () => {
    assert.equal(decideReceiptReclass({ ...base, suggestedBucketId: "groceries" }), null);
    assert.equal(decideReceiptReclass({ ...base, suggestedBucketId: null }), null);
  });

  test("below the confidence bar never moves it; the bar itself does", () => {
    assert.equal(decideReceiptReclass({ ...base, confidence: RECLASS_MIN_CONFIDENCE - 0.01 }), null);
    assert.equal(decideReceiptReclass({ ...base, confidence: RECLASS_MIN_CONFIDENCE }), "fuel");
  });

  test("a non-ordinary target is refused", () => {
    assert.equal(decideReceiptReclass({ ...base, targetIsOrdinary: false }), null);
  });
});
