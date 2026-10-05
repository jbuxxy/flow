import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatResultCount } from "@/lib/result-count-format";

describe("formatResultCount", () => {
  test("bare count, default noun, plural", () => {
    assert.equal(formatResultCount(12), "12 Results");
  });
  test("bare count of 1 is singular", () => {
    assert.equal(formatResultCount(1), "1 Result");
    assert.equal(formatResultCount(1, { noun: "Bill" }), "1 Bill");
  });
  test("custom noun, plural", () => {
    assert.equal(formatResultCount(3, { noun: "Bill" }), "3 Bills");
    assert.equal(formatResultCount(0, { noun: "Entry" }), "0 Entries");
    assert.equal(formatResultCount(2, { noun: "Match" }), "2 Matches");
  });
  test("with a total that differs -> 'N of M'", () => {
    assert.equal(formatResultCount(12, { noun: "Transaction", total: 340 }), "12 of 340 Transactions");
  });
  test("total equal to count collapses to the plain form", () => {
    assert.equal(formatResultCount(340, { noun: "Transaction", total: 340 }), "340 Transactions");
    assert.equal(formatResultCount(1, { noun: "Transaction", total: 1 }), "1 Transaction");
  });
});
