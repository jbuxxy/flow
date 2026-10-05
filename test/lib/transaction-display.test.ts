import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { installmentDisplayTitle, installmentDisplaySuffix, deriveP2PDisplay } from "@/lib/transaction-display";

describe("deriveP2PDisplay", () => {
  test("a P2P receipt resolved to a person shows 'App · Name'", () => {
    const r = deriveP2PDisplay({
      resolvedMerchant: "Casey Nguyen",
      resolvedMerchantIsPerson: true,
      receiptPaidWith: null,
      merchant: "Transfer to Venmo",
    });
    assert.equal(r.p2pApp, "Transfer to Venmo");
    assert.equal(r.displayMerchant, "Transfer to Venmo · Casey Nguyen");
  });

  test("a P2P receipt naming its app shows 'App · Name' for a business payee too", () => {
    const r = deriveP2PDisplay({
      resolvedMerchant: "Jane's Dog Walking",
      resolvedMerchantIsPerson: false,
      receiptPaidWith: "Venmo",
      merchant: "Transfer to Venmo",
    });
    assert.equal(r.p2pApp, "Venmo");
    assert.equal(r.displayMerchant, "Venmo · Jane's Dog Walking");
  });

  test("an unrelated receipt matched to a non-P2P charge never overrides the bank merchant", () => {
    // A same-amount snack receipt matched a gas-station charge and resolved
    // to "Churros" — with no P2P signal, the real merchant wins.
    const r = deriveP2PDisplay({
      resolvedMerchant: "Churros",
      resolvedMerchantIsPerson: false,
      receiptPaidWith: null,
      merchant: "Crestline #42",
    });
    assert.equal(r.p2pApp, null);
    assert.equal(r.displayMerchant, "Crestline #42");
    assert.equal(r.logoMerchant, "Crestline #42");
  });
});

describe("installmentDisplayTitle", () => {
  const base = {
    debtType: "INSTALLMENT" as string | null,
    debtName: "GlassesUSA.com - Klarna" as string | null,
  };

  test("bare plan name for a linked installment", () => {
    assert.equal(installmentDisplayTitle(base), "GlassesUSA.com - Klarna");
  });

  test("null for a transaction not linked to an installment plan", () => {
    assert.equal(installmentDisplayTitle({ ...base, debtType: "REVOLVING" }), null);
    assert.equal(installmentDisplayTitle({ ...base, debtType: null }), null);
    assert.equal(installmentDisplayTitle({ ...base, debtName: null }), null);
  });
});

describe("installmentDisplaySuffix", () => {
  const base = {
    debtType: "INSTALLMENT" as string | null,
    installmentNumber: 3 as number | null,
    installmentsTotal: 6 as number | null,
  };

  test("schedule position for a linked installment", () => {
    assert.equal(installmentDisplaySuffix(base), "3/6");
  });

  test("null for a transaction not linked to an installment plan", () => {
    assert.equal(installmentDisplaySuffix({ ...base, debtType: "REVOLVING" }), null);
    assert.equal(installmentDisplaySuffix({ ...base, debtType: null }), null);
  });

  test("null when the schedule size was never captured (legacy plan)", () => {
    assert.equal(installmentDisplaySuffix({ ...base, installmentsTotal: null }), null);
    assert.equal(installmentDisplaySuffix({ ...base, installmentNumber: null }), null);
  });

  test("clamps an over-linked position to the schedule total", () => {
    assert.equal(installmentDisplaySuffix({ ...base, installmentNumber: 7, installmentsTotal: 6 }), "6/6");
  });
});
