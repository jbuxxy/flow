import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  centsToDollars,
  dollarsToCents,
  formatCents,
  formatDollars,
  parseDollarsToCents,
} from "@/lib/money";

describe("dollarsToCents", () => {
  test("rounds to the nearest cent", () => {
    assert.equal(dollarsToCents(1), 100);
    assert.equal(dollarsToCents(1.005), 100); // 1.005 * 100 === 100.499… in IEEE-754
    assert.equal(dollarsToCents(1.006), 101);
    assert.equal(dollarsToCents(-4.2), -420);
  });
});

describe("centsToDollars", () => {
  test("divides by 100", () => {
    assert.equal(centsToDollars(4217), 42.17);
    assert.equal(centsToDollars(0), 0);
  });
});

describe("formatCents / formatDollars", () => {
  test("formatCents keeps exact cents", () => {
    assert.equal(formatCents(4217), "$42.17");
    assert.equal(formatCents(-500), "-$5.00");
  });

  test("formatDollars rounds to whole dollars", () => {
    assert.equal(formatDollars(4217), "$42");
    assert.equal(formatDollars(4250), "$43"); // banker's? no — Math.round: .5 up
    assert.equal(formatDollars(4249), "$42");
  });
});

describe("parseDollarsToCents", () => {
  test("accepts common user formats", () => {
    assert.equal(parseDollarsToCents("1,234.56"), 123456);
    assert.equal(parseDollarsToCents("$45"), 4500);
    assert.equal(parseDollarsToCents("45.5"), 4550);
    assert.equal(parseDollarsToCents("  $1,000  "), 100000);
  });

  test("rejects invalid / negative / empty input with null", () => {
    assert.equal(parseDollarsToCents(""), null);
    assert.equal(parseDollarsToCents("   "), null);
    assert.equal(parseDollarsToCents("abc"), null);
    assert.equal(parseDollarsToCents("-5"), null);
    assert.equal(parseDollarsToCents("Infinity"), null);
  });
});
