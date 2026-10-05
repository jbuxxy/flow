import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  bnplPlanDateInWindow,
  bnplPlanMatchesReceipt,
  bnplPlanMerchantName,
  bnplPlanOriginalPrincipalCents,
  bnplPlanTotalMatches,
} from "@/lib/bnpl-plan-match";
import type { BnplPlanShape } from "@/lib/bnpl-plan-match";
import { utc } from "../helpers.ts";

const plan = (o: Partial<BnplPlanShape> = {}): BnplPlanShape => ({
  name: "Klarna - Nike",
  balanceCents: 20_000,
  minPaymentCents: 5_000,
  installmentsTotal: 4,
  purchaseDate: utc(2026, 3, 1),
  perInstallmentCents: 5_000,
  ...o,
});

describe("bnplPlanMerchantName", () => {
  test("strips the lender token", () => {
    assert.equal(bnplPlanMerchantName("Klarna - Nike"), "Nike");
    assert.equal(bnplPlanMerchantName("Affirm — Dick's"), "Dick s");
    assert.equal(bnplPlanMerchantName("GlassesUSA.com - Klarna"), "GlassesUSA com");
  });
});

describe("bnplPlanOriginalPrincipalCents", () => {
  test("installments x per-installment when known", () => {
    assert.equal(bnplPlanOriginalPrincipalCents(plan({ installmentsTotal: 4, perInstallmentCents: 5_000 })), 20_000);
  });
  test("falls back to min payment, then to balance, then null", () => {
    assert.equal(bnplPlanOriginalPrincipalCents(plan({ perInstallmentCents: null, minPaymentCents: 2_500, installmentsTotal: 4 })), 10_000);
    assert.equal(bnplPlanOriginalPrincipalCents(plan({ perInstallmentCents: null, minPaymentCents: 0, installmentsTotal: null, balanceCents: 12_000 })), 12_000);
    assert.equal(bnplPlanOriginalPrincipalCents(plan({ perInstallmentCents: null, minPaymentCents: 0, installmentsTotal: null, balanceCents: 0 })), null);
  });
});

describe("bnplPlanTotalMatches", () => {
  test("within 1% or $1, whichever is larger", () => {
    assert.equal(bnplPlanTotalMatches(20_000, 20_050), true); // diff 50 <= 1% of 20050
    assert.equal(bnplPlanTotalMatches(8_004, 7_822), false); // diff 182 > max(80, 100)
  });

  test("$1 floor for small totals", () => {
    assert.equal(bnplPlanTotalMatches(500, 560), true); // diff 60 <= 100
    assert.equal(bnplPlanTotalMatches(500, 620), false); // diff 120 > 100
  });
});

describe("bnplPlanDateInWindow", () => {
  test("[-21, +75] days around the receipt anchor; null purchaseDate always passes", () => {
    assert.equal(bnplPlanDateInWindow(null, utc(2026, 3, 1)), true);
    assert.equal(bnplPlanDateInWindow(utc(2026, 2, 20), utc(2026, 3, 1)), true); // 9 days before
    assert.equal(bnplPlanDateInWindow(utc(2026, 1, 1), utc(2026, 3, 1)), false); // way before
    assert.equal(bnplPlanDateInWindow(utc(2026, 5, 1), utc(2026, 3, 1)), true); // ~61 days after
    assert.equal(bnplPlanDateInWindow(utc(2026, 6, 1), utc(2026, 3, 1)), false); // >75 days after
  });
});

describe("bnplPlanMatchesReceipt", () => {
  test("full gate: name + total + date all line up", () => {
    assert.equal(
      bnplPlanMatchesReceipt(plan(), { party: "Nike", totalCents: 20_000 }, utc(2026, 3, 5)),
      true,
    );
  });
  test("missing party or total -> false", () => {
    assert.equal(bnplPlanMatchesReceipt(plan(), { party: null, totalCents: 20_000 }, utc(2026, 3, 5)), false);
    assert.equal(bnplPlanMatchesReceipt(plan(), { party: "Nike", totalCents: null }, utc(2026, 3, 5)), false);
  });
  test("wrong merchant -> false", () => {
    assert.equal(bnplPlanMatchesReceipt(plan(), { party: "Adidas", totalCents: 20_000 }, utc(2026, 3, 5)), false);
  });
});
