import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTRACT_BATCH_SIZE,
  EXTRACT_MAX_WAIT_MS,
  SENDER_SKIP_AFTER,
  SKIP_RECHECK_MS,
  SUBJECT_SKIP_AFTER,
  senderKey,
  shouldDeferExtraction,
  shouldSkipEmail,
  subjectKey,
} from "@/lib/email-sender-verdict";

const now = new Date("2026-10-23T12:00:00Z");
const stat = (o: Partial<{ usefulCount: number; uselessCount: number; uselessStreak: number; ageMs: number }>) => ({
  usefulCount: o.usefulCount ?? 0,
  uselessCount: o.uselessCount ?? 0,
  uselessStreak: o.uselessStreak ?? 0,
  lastAiCheckAt: new Date(now.getTime() - (o.ageMs ?? 0)),
});

describe("senderKey", () => {
  test("takes the bracketed address, lowercased", () => {
    assert.equal(senderKey("Amazon.com <Auto-Confirm@Amazon.com>"), "auto-confirm@amazon.com");
  });
  test("a bare address passes through", () => {
    assert.equal(senderKey(" venmo@venmo.com "), "venmo@venmo.com");
  });
});

describe("subjectKey", () => {
  test("order numbers and amounts collapse to one shape", () => {
    assert.equal(subjectKey("Your order #112-4471 of $18.18"), subjectKey("Your order #113-9902 of $7.51"));
  });
  test("quoted product names collapse", () => {
    assert.equal(subjectKey('Delivered: "Anker USB-C Cable"'), subjectKey("Delivered: “Kitchen Towels, 6 Pack”"));
  });
  test("reply/forward prefixes are dropped", () => {
    assert.equal(subjectKey("Fwd: RE: Your bill is ready"), "your bill is ready");
  });
  test("different wording stays different", () => {
    assert.notEqual(subjectKey("Your order has shipped"), subjectKey("50% off this weekend"));
  });
});

describe("shouldSkipEmail", () => {
  test("nothing known → send", () => {
    assert.equal(shouldSkipEmail(null, null, now), false);
  });
  test("a sender that has never sent a receipt is skipped after enough misses", () => {
    assert.equal(shouldSkipEmail(stat({ uselessCount: SENDER_SKIP_AFTER - 1 }), null, now), false);
    assert.equal(shouldSkipEmail(stat({ uselessCount: SENDER_SKIP_AFTER }), null, now), true);
  });
  test("a sender that has sent even one receipt is never skipped wholesale", () => {
    assert.equal(shouldSkipEmail(stat({ usefulCount: 1, uselessCount: 50 }), null, now), false);
  });
  test("a subject shape is skipped after a streak of misses, even from a receipt sender", () => {
    const sender = stat({ usefulCount: 10, uselessCount: 20 });
    assert.equal(shouldSkipEmail(sender, stat({ uselessStreak: SUBJECT_SKIP_AFTER - 1 }), now), false);
    assert.equal(shouldSkipEmail(sender, stat({ uselessStreak: SUBJECT_SKIP_AFTER }), now), true);
  });
  test("a stale verdict is rechecked", () => {
    const old = SKIP_RECHECK_MS + 1;
    assert.equal(shouldSkipEmail(stat({ uselessCount: 99, ageMs: old }), null, now), false);
    assert.equal(shouldSkipEmail(null, stat({ uselessStreak: 99, ageMs: old }), now), false);
  });
});

describe("shouldDeferExtraction", () => {
  const at = (msAgo: number) => ({ receivedAt: new Date(now.getTime() - msAgo) });
  test("a few fresh candidates wait", () => {
    assert.equal(shouldDeferExtraction([at(60_000), at(0)], now), true);
  });
  test("sends once the oldest has waited long enough", () => {
    assert.equal(shouldDeferExtraction([at(EXTRACT_MAX_WAIT_MS), at(0)], now), false);
  });
  test("sends once a full batch is waiting", () => {
    assert.equal(shouldDeferExtraction(Array.from({ length: EXTRACT_BATCH_SIZE }, () => at(0)), now), false);
  });
  test("nothing to send → nothing to defer", () => {
    assert.equal(shouldDeferExtraction([], now), false);
  });
});
