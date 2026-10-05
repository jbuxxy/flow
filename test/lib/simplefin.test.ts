import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decimalStringToCents } from "@/lib/simplefin";

describe("decimalStringToCents", () => {
  test("parses decimal strings into integer cents without float drift", () => {
    assert.equal(decimalStringToCents("-42.17"), -4217);
    assert.equal(decimalStringToCents("42.17"), 4217);
    assert.equal(decimalStringToCents("1000"), 100_000);
    assert.equal(decimalStringToCents("0"), 0);
    assert.equal(decimalStringToCents("0.00"), 0);
  });

  test("pads a single fractional digit", () => {
    assert.equal(decimalStringToCents("5.5"), 550);
  });

  test("truncates beyond two fractional digits (does not round)", () => {
    assert.equal(decimalStringToCents("5.009"), 500);
    assert.equal(decimalStringToCents("5.999"), 599);
  });

  test("tolerates a leading + and surrounding whitespace", () => {
    assert.equal(decimalStringToCents("  +3.20 "), 320);
  });

  test("classic float-drift case stays exact", () => {
    assert.equal(decimalStringToCents("-0.29"), -29);
    assert.equal(decimalStringToCents("14.30"), 1430);
  });
});
