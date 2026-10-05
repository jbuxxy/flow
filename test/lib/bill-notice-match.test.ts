import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pickBillNoticeMatch, last4sIn } from "@/lib/bill-notice-match";

describe("pickBillNoticeMatch", () => {
  test("exact name match auto-picks", () => {
    const result = pickBillNoticeMatch("Verizon", 8000, [{ id: "b1", name: "Verizon", amountCents: 8000 }], []);
    assert.deepEqual(result, { outcome: "MATCH", type: "BILL", id: "b1" });
  });

  test("clear top score across bills and debts auto-picks the right type", () => {
    const result = pickBillNoticeMatch(
      "PayPal Credit",
      6500,
      [{ id: "b1", name: "Netflix", amountCents: 1599 }],
      [{ id: "d1", name: "PayPal Credit", amountCents: 3000 }],
    );
    assert.deepEqual(result, { outcome: "MATCH", type: "DEBT", id: "d1" });
  });

  test("two similarly-scored candidates with no amount to separate them are ambiguous", () => {
    const result = pickBillNoticeMatch(
      "City Water",
      5000,
      [
        { id: "b1", name: "Fairview City Water", amountCents: 5000 },
        { id: "b2", name: "Lehi City Water", amountCents: 5000 },
      ],
      [],
    );
    assert.equal(result.outcome, "AMBIGUOUS");
  });

  test("nothing above the floor is unmatched", () => {
    const result = pickBillNoticeMatch("Acme Gas & Electric", 5000, [{ id: "b1", name: "Netflix", amountCents: 1599 }], [{ id: "d1", name: "Chase Sapphire", amountCents: 5000 }]);
    assert.equal(result.outcome, "UNMATCHED");
  });

  test("a bill and a debt named similarly enough still resolve only when one clears the margin", () => {
    const ambiguous = pickBillNoticeMatch(
      "Chase",
      5000,
      [{ id: "b1", name: "Chase Freedom", amountCents: 5000 }],
      [{ id: "d1", name: "Chase Sapphire", amountCents: 5000 }],
    );
    assert.equal(ambiguous.outcome, "AMBIGUOUS");

    const resolved = pickBillNoticeMatch(
      "Chase Sapphire",
      5000,
      [{ id: "b1", name: "Chase Freedom", amountCents: 5000 }],
      [{ id: "d1", name: "Chase Sapphire", amountCents: 5000 }],
    );
    assert.deepEqual(resolved, { outcome: "MATCH", type: "DEBT", id: "d1" });
  });

  describe("regressions", () => {
    // 2026-09-22: a household with four Klarna installment plans all score
    // identically on name alone ("Klarna" is a whole-word substring of each),
    // so the notice's own amount has to break the tie — it should land on
    // whichever plan's tracked amount it actually sits closest to, not go
    // ambiguous just because the names tied.
    test("same-lender plans with tied names are broken by amount", () => {
      const debts = [
        { id: "nike2", name: "Klarna - Nike 2", amountCents: 6793 },
        { id: "puma", name: "Klarna - Puma", amountCents: 2145 },
        { id: "nike", name: "Nike - Klarna", amountCents: 2037 },
        { id: "glasses", name: "GlassesUSA.com - Klarna", amountCents: 1334 },
      ];
      const result = pickBillNoticeMatch("Klarna", 2038, [], debts);
      assert.deepEqual(result, { outcome: "MATCH", type: "DEBT", id: "nike" });
    });

    test("same-lender plans stay ambiguous when two are both plausibly close in amount", () => {
      const debts = [
        { id: "a", name: "Klarna - Store A", amountCents: 5000 },
        { id: "b", name: "Klarna - Store B", amountCents: 5003 },
      ];
      const result = pickBillNoticeMatch("Klarna", 5002, [], debts);
      assert.equal(result.outcome, "AMBIGUOUS");
    });

    test("a name-tied candidate whose amount is nowhere close still stays ambiguous, not a wrong guess", () => {
      const debts = [
        { id: "a", name: "Klarna - Store A", amountCents: 9000 },
        { id: "b", name: "Klarna - Store B", amountCents: 11000 },
      ];
      const result = pickBillNoticeMatch("Klarna", 2000, [], debts);
      assert.equal(result.outcome, "AMBIGUOUS");
    });
  });

  // Regression 2026-10-03: an issuer-named notice for a co-branded card.
  const coBranded = [
    { id: "amazon", name: "Amazon Prime Rewards Visa Signature (4321)", amountCents: 3500, aliases: ["Chase Bank"], last4s: ["4321"] },
    { id: "freedom", name: "Freedom Unlimited (1111)", amountCents: 4000, aliases: ["Chase Bank"], last4s: ["1111"] },
  ];

  test("the notice's account last-4 picks the one debt that ends in it", () => {
    assert.deepEqual(pickBillNoticeMatch("Chase", 3500, [], coBranded, "4321"), { outcome: "MATCH", type: "DEBT", id: "amazon" });
  });

  test("issuer name matches through the account's institution, amount breaks the tie", () => {
    assert.deepEqual(pickBillNoticeMatch("Chase", 3500, [], coBranded, null), { outcome: "MATCH", type: "DEBT", id: "amazon" });
  });

  test("an unknown last-4 falls back to name matching", () => {
    assert.deepEqual(pickBillNoticeMatch("Chase", 3500, [], coBranded, "0000"), { outcome: "MATCH", type: "DEBT", id: "amazon" });
  });

  // Regression 2026-10-05: a Klarna notice quoting its funding card's ending,
  // which collided with an unrelated auto loan's.
  const loanAndPlans = [
    { id: "autoloan", name: "Auto Loan (1234)", amountCents: 45000, aliases: ["Hometown Credit Union"], last4s: ["1234"] },
    { id: "shoes", name: "Klarna - Shoes", amountCents: 1500 },
    { id: "jacket", name: "Klarna - Jacket", amountCents: 4000 },
  ];

  test("a last-4 hit whose name contradicts the biller doesn't win", () => {
    assert.deepEqual(pickBillNoticeMatch("Klarna", 1500, [], loanAndPlans, "1234"), { outcome: "MATCH", type: "DEBT", id: "shoes" });
  });

  test("a last-4 hit still wins when the biller name fits nothing", () => {
    assert.deepEqual(pickBillNoticeMatch("Payment Reminder", 45000, [], loanAndPlans, "1234"), { outcome: "MATCH", type: "DEBT", id: "autoloan" });
  });

  test("last4sIn pulls standalone 4-digit endings", () => {
    assert.deepEqual(last4sIn("Visa Signature (4321)", null, "Card 12345"), ["4321"]);
  });
});
