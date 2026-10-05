import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  aliasKey,
  isP2PReceipt,
  plausibleReceiptCharge,
  receiptAmountWhere,
  receiptChargeScopeWhere,
  receiptMatchWindow,
  receiptSignMatches,
  RECEIPT_MATCH_AFTER_DAYS,
  RECEIPT_MATCH_BEFORE_DAYS,
} from "@/lib/receipt-match";
import type { ReceiptMatchShape } from "@/lib/receipt-match";
import { utc } from "../helpers.ts";

const receipt = (o: Partial<ReceiptMatchShape> = {}): ReceiptMatchShape => ({
  kind: "ORDER",
  party: "Costco",
  partyIsPerson: false,
  p2pApp: null,
  ...o,
});

describe("isP2PReceipt", () => {
  test("true when the party is a person or a P2P app was named", () => {
    assert.equal(isP2PReceipt(receipt({ partyIsPerson: true })), true);
    assert.equal(isP2PReceipt(receipt({ p2pApp: "Venmo" })), true);
    assert.equal(isP2PReceipt(receipt()), false);
  });
});

describe("receiptAmountWhere / receiptSignMatches", () => {
  test("ordinary purchase receipt: debit side only", () => {
    assert.deepEqual(receiptAmountWhere(receipt(), 4_200), { amountCents: 4_200 });
    assert.equal(receiptSignMatches(receipt(), 4_200), true);
    assert.equal(receiptSignMatches(receipt(), -4_200), false);
  });

  test("PAYMENT_RECEIVED from a real person: credit side only", () => {
    const r = receipt({ kind: "PAYMENT_RECEIVED", partyIsPerson: true });
    assert.deepEqual(receiptAmountWhere(r, 4_200), { amountCents: -4_200 });
    assert.equal(receiptSignMatches(r, -4_200), true);
    assert.equal(receiptSignMatches(r, 4_200), false);
  });

  test("PAYMENT_RECEIVED for a business: either sign", () => {
    const r = receipt({ kind: "PAYMENT_RECEIVED" });
    assert.deepEqual(receiptAmountWhere(r, 4_200), { OR: [{ amountCents: 4_200 }, { amountCents: -4_200 }] });
    assert.equal(receiptSignMatches(r, 4_200), true);
    assert.equal(receiptSignMatches(r, -4_200), true);
  });

  test("PAYMENT_SENT (a card/loan issuer's own payment confirmation): either sign", () => {
    // Real incident, 2026-09-11: a Chase card-payment receipt whose matching
    // bank transaction posted on the debt's own liability account as a
    // negative credit (amountCents -3500), not a plain checking-side debit —
    // never entered the candidate pool under the old debit-only rule.
    const r = receipt({ kind: "PAYMENT_SENT", party: "Chase", partyIsPerson: false });
    assert.deepEqual(receiptAmountWhere(r, 3_500), { OR: [{ amountCents: 3_500 }, { amountCents: -3_500 }] });
    assert.equal(receiptSignMatches(r, 3_500), true);
    assert.equal(receiptSignMatches(r, -3_500), true);
  });
});

describe("receiptMatchWindow", () => {
  test("asymmetric: small slack before, full reach after", () => {
    const { from, to } = receiptMatchWindow(utc(2026, 3, 10));
    assert.deepEqual(from, utc(2026, 3, 10 - RECEIPT_MATCH_BEFORE_DAYS));
    assert.deepEqual(to, utc(2026, 3, 10 + RECEIPT_MATCH_AFTER_DAYS));
  });
});

describe("receiptChargeScopeWhere", () => {
  test("P2P receipt scopes to P2P-looking merchants", () => {
    const where = receiptChargeScopeWhere(receipt({ p2pApp: "Venmo", partyIsPerson: true }));
    assert.deepEqual(where, {
      OR: ["venmo", "zelle", "cash app", "cashapp", "apple cash", "paypal"].map((k) => ({
        merchant: { contains: k, mode: "insensitive" },
      })),
    });
  });

  test("an ordinary non-P2P receipt excludes every P2P-looking merchant", () => {
    const where = receiptChargeScopeWhere(receipt({ party: "Costco" }));
    assert.deepEqual(where, {
      NOT: {
        OR: ["venmo", "zelle", "cash app", "cashapp", "apple cash", "paypal"].map((k) => ({
          merchant: { contains: k, mode: "insensitive" },
        })),
      },
    });
  });

  test("a non-P2P receipt naming a dual-use channel (PayPal Credit) still allows that channel's own merchant", () => {
    // Real incident, 2026-09-25: a PayPal Credit installment-payment receipt
    // never matched its own posted "PayPal" transaction because the blanket
    // exclusion scoped every "PayPal"-merchant charge away from a receipt
    // that wasn't flagged partyIsPerson/p2pApp.
    const where = receiptChargeScopeWhere(receipt({ party: "PayPal Credit" }));
    assert.deepEqual(where, {
      NOT: {
        OR: ["venmo", "zelle", "cash app", "cashapp", "apple cash"].map((k) => ({
          merchant: { contains: k, mode: "insensitive" },
        })),
      },
    });
  });
});

describe("plausibleReceiptCharge", () => {
  test("P2P or no-party receipts pass on amount+date alone", () => {
    assert.equal(plausibleReceiptCharge(receipt({ partyIsPerson: true }), { merchant: "anything", rawDescription: null }), true);
    assert.equal(plausibleReceiptCharge(receipt({ party: null }), { merchant: "anything", rawDescription: null }), true);
  });

  test("a non-P2P receipt has to resemble its party", () => {
    assert.equal(plausibleReceiptCharge(receipt({ party: "Costco Wholesale" }), { merchant: "COSTCO WHSE #123", rawDescription: null }), true);
    assert.equal(plausibleReceiptCharge(receipt({ party: "Costco Wholesale" }), { merchant: "Shell Oil", rawDescription: null }), false);
  });

  test("a learned merchant alias is trusted", () => {
    const aliases = new Set([aliasKey("SQ *THE COFFEE BAR")]);
    assert.equal(
      plausibleReceiptCharge(receipt({ party: "Blue Bottle" }), { merchant: "SQ *The Coffee Bar", rawDescription: null }, aliases),
      true,
    );
  });
});
