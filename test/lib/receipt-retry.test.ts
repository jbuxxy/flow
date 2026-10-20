import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_OMITTED_ATTEMPTS, OmissionTracker } from "@/lib/receipt-retry";

// An email the AI keeps leaving out of its response used to be re-sent (and
// re-billed) every sync forever; it's now given up on after a fixed count.
describe("OmissionTracker", () => {
  test("gives up on the MAX_OMITTED_ATTEMPTS-th omission, not before", () => {
    const t = new OmissionTracker();
    for (let i = 1; i < MAX_OMITTED_ATTEMPTS; i++) assert.equal(t.omitted("a"), false);
    assert.equal(t.omitted("a"), true);
  });

  test("counts each email separately", () => {
    const t = new OmissionTracker(2);
    assert.equal(t.omitted("a"), false);
    assert.equal(t.omitted("b"), false);
    assert.equal(t.omitted("a"), true);
  });

  test("a resolved email starts over", () => {
    const t = new OmissionTracker(2);
    assert.equal(t.omitted("a"), false);
    t.resolved("a");
    assert.equal(t.omitted("a"), false);
  });

  test("a given-up email starts over if it ever comes back", () => {
    const t = new OmissionTracker(2);
    t.omitted("a");
    assert.equal(t.omitted("a"), true);
    assert.equal(t.omitted("a"), false);
  });
});
