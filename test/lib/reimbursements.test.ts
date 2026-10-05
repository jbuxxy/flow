import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { creditDoesNotIdentifyPayee } from "@/lib/reimbursements";

describe("creditDoesNotIdentifyPayee", () => {
  test("a genuine merchant refund identifies its own payee", () => {
    assert.equal(creditDoesNotIdentifyPayee("Google One"), false);
    assert.equal(creditDoesNotIdentifyPayee("Amazon.com"), false);
  });

  test("a P2P credit never identifies who's really paying back", () => {
    assert.equal(creditDoesNotIdentifyPayee("Venmo"), true);
    assert.equal(creditDoesNotIdentifyPayee("Zelle Payment"), true);
  });

  describe("regressions", () => {
    // Real household report, 2026-09-27: a "Visa Chargeback Adjustment"
    // credit got zero suggestions. Its merchant text is a card-network
    // dispute-resolution artifact, not the store the original purchase was
    // made at — no purchase is ever literally named that, so the
    // same-merchant tier always comes up empty, and it wasn't eligible for
    // the amount-tolerance fallback either since it isn't a P2P credit.
    test("a generic bank dispute-resolution credit doesn't identify its payee either", () => {
      assert.equal(creditDoesNotIdentifyPayee("Visa Chargeback Adjustment"), true);
      assert.equal(creditDoesNotIdentifyPayee("Dispute Credit"), true);
      assert.equal(creditDoesNotIdentifyPayee("Provisional Credit"), true);
    });
  });
});
