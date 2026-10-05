import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dueDateAwareFraction } from "@/lib/buckets";
import { utc } from "../helpers.ts";

describe("dueDateAwareFraction", () => {
  test("null when nothing is scheduled this period", () => {
    assert.equal(dueDateAwareFraction([], utc(2026, 9, 1), utc(2026, 10, 1), utc(2026, 9, 26)), null);
  });

  test("counts only occurrences on or before today when nothing has rolled forward", () => {
    const fraction = dueDateAwareFraction(
      [
        { amountCents: 1_000, cadence: "MONTHLY", nextDueDate: utc(2026, 9, 10) }, // due, not yet paid
        { amountCents: 1_000, cadence: "MONTHLY", nextDueDate: utc(2026, 9, 27) }, // not due yet
      ],
      utc(2026, 9, 1),
      utc(2026, 10, 1),
      utc(2026, 9, 26),
    );
    assert.equal(fraction, 0.5);
  });

  describe("regressions", () => {
    // Real household report, 2026-09-26: the Subscriptions bucket read "75%
    // of this month's bills due so far" even though every one of its six
    // tracked bills had already posted this month. One bill's charge
    // landed Sep 25, a couple of days *before* its own recorded due date —
    // nextDueDate had already rolled forward to Oct 27 (proof the payment
    // was matched), but its derived September occurrence (one cadence back
    // from nextDueDate) was Sep 27, one day past "today" (Sep 26). Comparing
    // that occurrence's raw date to today alone said "not due yet" despite
    // the money already being spent.
    test("an occurrence before the tracker's own nextDueDate counts as due, even if its date is still ahead of today", () => {
      const fraction = dueDateAwareFraction(
        [
          { amountCents: 150, cadence: "MONTHLY", nextDueDate: utc(2026, 10, 8) },
          { amountCents: 964, cadence: "MONTHLY", nextDueDate: utc(2026, 10, 17) },
          { amountCents: 2_145, cadence: "MONTHLY", nextDueDate: utc(2026, 10, 22) },
          { amountCents: 999, cadence: "MONTHLY", nextDueDate: utc(2026, 10, 23) },
          { amountCents: 1_608, cadence: "MONTHLY", nextDueDate: utc(2026, 10, 23) },
          // Derived September occurrence is Sep 27 — a day *after* "today"
          // (Sep 26) — but nextDueDate already rolled past it to Oct 27.
          { amountCents: 2_000, cadence: "MONTHLY", nextDueDate: utc(2026, 10, 27) },
        ],
        utc(2026, 9, 1),
        utc(2026, 10, 1),
        utc(2026, 9, 26),
      );
      assert.equal(fraction, 1);
    });

    test("a genuinely not-yet-due occurrence (nextDueDate itself) still isn't counted", () => {
      const fraction = dueDateAwareFraction(
        [{ amountCents: 1_000, cadence: "MONTHLY", nextDueDate: utc(2026, 9, 27) }],
        utc(2026, 9, 1),
        utc(2026, 10, 1),
        utc(2026, 9, 26),
      );
      assert.equal(fraction, 0);
    });
  });
});
