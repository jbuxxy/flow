import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { guessAccountType } from "@/lib/account-type";

const acct = (name: string, org?: string) => ({ id: "x", name, currency: "USD", balance: "0", org: org ? { name: org } : undefined });

describe("guessAccountType", () => {
  test("HELOC without the word 'loan' is a LOAN", () => {
    assert.equal(guessAccountType(acct("Fixed Rate Heloc 5 *1234", "Canyon Credit Union")), "LOAN");
  });

  test("bare installment-lender name is a LOAN", () => {
    assert.equal(guessAccountType(acct("Upstart", "Upstart")), "LOAN");
  });

  test("existing classifications are unchanged", () => {
    assert.equal(guessAccountType(acct("Money Market", "Canyon Credit Union")), "SAVINGS");
    assert.equal(guessAccountType(acct("Checking", "Canyon Credit Union")), "CHECKING");
    assert.equal(guessAccountType(acct("Quicksilver", "Capital One")), "CREDIT_CARD");
    assert.equal(guessAccountType(acct("Personal loan (1111)", "Lending Club")), "LOAN");
    assert.equal(guessAccountType(acct("Venmo", "Venmo")), "OTHER");
  });
});
