import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RecurringPattern } from "@prisma/client";
import { matchRecurringPattern, patternMatchData, patternCounterpartyMatches } from "@/lib/pattern-match";
import { utc } from "../helpers.ts";

function pattern(overrides: Partial<RecurringPattern> = {}): RecurringPattern {
  return {
    id: "p1",
    householdId: "h",
    active: true,
    direction: "DEBIT",
    channelKeyword: "venmo",
    amountMinCents: 1_000,
    amountMaxCents: 5_000,
    dayOfMonthStart: null,
    dayOfMonthEnd: null,
    weekdays: [],
    bucketId: null,
    debtId: null,
    categoryId: null,
    countsAsIncome: false,
    label: null,
    billId: null,
    // Unscheduled, no known counterparty — the shape every pattern before
    // 2026-09-11 has, and still the default for a household with no email
    // connected (see RecurringPattern's own schema comment).
    counterpartyName: null,
    noteKeywords: [],
    cadence: null,
    nextDueDate: null,
    lastPaidDate: null,
    toleranceCents: null,
    dueDateLocked: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as RecurringPattern;
}

describe("matchRecurringPattern", () => {
  test("direction is derived from the transaction's sign", () => {
    const debitPat = pattern({ direction: "DEBIT" });
    const creditPat = pattern({ direction: "CREDIT" });
    assert.equal(matchRecurringPattern([debitPat, creditPat], { merchant: "Venmo", amountCents: 2_000, occurredOn: utc(2026, 3, 1) }), debitPat);
    assert.equal(matchRecurringPattern([debitPat, creditPat], { merchant: "Venmo", amountCents: -2_000, occurredOn: utc(2026, 3, 1) }), creditPat);
  });

  test("filters by active, channel keyword and amount range (inclusive bounds)", () => {
    const p = pattern({ amountMinCents: 1_000, amountMaxCents: 5_000 });
    assert.equal(matchRecurringPattern([p], { merchant: "VENMO PAYMENT", amountCents: 1_000, occurredOn: utc(2026, 3, 1) }), p);
    assert.equal(matchRecurringPattern([p], { merchant: "VENMO PAYMENT", amountCents: 5_000, occurredOn: utc(2026, 3, 1) }), p);
    assert.equal(matchRecurringPattern([p], { merchant: "VENMO PAYMENT", amountCents: 5_001, occurredOn: utc(2026, 3, 1) }), null);
    assert.equal(matchRecurringPattern([pattern({ active: false })], { merchant: "Venmo", amountCents: 2_000, occurredOn: utc(2026, 3, 1) }), null);
    assert.equal(matchRecurringPattern([p], { merchant: "Zelle", amountCents: 2_000, occurredOn: utc(2026, 3, 1) }), null);
  });

  test("multiple candidates: resolved by day-of-month / weekday only if one clearly wins", () => {
    const early = pattern({ id: "early", dayOfMonthStart: 1, dayOfMonthEnd: 5 });
    const late = pattern({ id: "late", dayOfMonthStart: 20, dayOfMonthEnd: 28 });
    assert.equal(matchRecurringPattern([early, late], { merchant: "Venmo", amountCents: 2_000, occurredOn: utc(2026, 3, 3) }), early);
    // No hints anywhere -> genuine tie -> unmatched, not guessed.
    const a = pattern({ id: "a" });
    const b = pattern({ id: "b" });
    assert.equal(matchRecurringPattern([a, b], { merchant: "Venmo", amountCents: 2_000, occurredOn: utc(2026, 3, 3) }), null);
  });
});

describe("patternCounterpartyMatches", () => {
  test("no counterpartyName or noteKeywords -> always matches (legacy/no-email shape)", () => {
    assert.equal(patternCounterpartyMatches(pattern(), { resolvedMerchant: null, receiptNote: null }), true);
    assert.equal(patternCounterpartyMatches(pattern(), { resolvedMerchant: "Robin Miller", receiptNote: "hi" }), true);
  });

  test("counterpartyName set requires a close resolvedMerchant match", () => {
    const p = pattern({ counterpartyName: "Robin Miller" });
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: "Robin Miller", receiptNote: null }), true);
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: "Robin G Miller", receiptNote: null }), true);
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: "John Smith", receiptNote: null }), false);
    // No receipt resolved for this transaction at all -> can't confirm identity.
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: null, receiptNote: null }), false);
  });

  test("noteKeywords matches if ANY listed alias is a substring of receiptNote, case-insensitively", () => {
    const p = pattern({ noteKeywords: ["Sammy", "Sam"] });
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: null, receiptNote: "basketball - sam" }), true);
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: null, receiptNote: "Basketball - SAMMY W" }), true);
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: null, receiptNote: "basketball - benny" }), false);
    assert.equal(patternCounterpartyMatches(p, { resolvedMerchant: null, receiptNote: null }), false);
  });

  test("both counterpartyName and noteKeywords set requires both to pass", () => {
    const p = pattern({ counterpartyName: "Hoops Academy", noteKeywords: ["Sammy", "Sam"] });
    assert.equal(
      patternCounterpartyMatches(p, { resolvedMerchant: "Hoops Academy", receiptNote: "basketball - sam" }),
      true,
    );
    // Right counterparty, wrong kid's note.
    assert.equal(
      patternCounterpartyMatches(p, { resolvedMerchant: "Hoops Academy", receiptNote: "basketball - benny" }),
      false,
    );
  });
});

describe("patternMatchData", () => {
  test("DEBIT: category only rides along with a bucket; no bucket -> pure transfer", () => {
    assert.deepEqual(
      patternMatchData(pattern({ direction: "DEBIT", bucketId: "b1", categoryId: "c1" })),
      { patternId: "p1", bucketId: "b1", debtId: null, categoryId: "c1", isTransfer: false, isIncome: false, aiSuggestedBucketId: null, aiSuggestedCategoryId: null },
    );
    const noBucket = patternMatchData(pattern({ direction: "DEBIT", bucketId: null, debtId: "d1", categoryId: "c1" }));
    assert.equal(noBucket.categoryId, null);
    assert.equal(noBucket.isTransfer, true);
  });

  test("CREDIT: isIncome mirrors countsAsIncome", () => {
    assert.equal(patternMatchData(pattern({ direction: "CREDIT", countsAsIncome: true })).isIncome, true);
    assert.equal(patternMatchData(pattern({ direction: "CREDIT", countsAsIncome: false })).isTransfer, true);
  });
});
