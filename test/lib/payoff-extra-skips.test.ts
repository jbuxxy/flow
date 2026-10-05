import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { withoutSkippedExtras } from "@/lib/debt-payments";
import { utc } from "../helpers.ts";

describe("withoutSkippedExtras", () => {
  // Amazon Card's Sep 17 $100 was snapshotted, then skipped Sep 19 — the
  // frozen row must not keep showing as open on "Last Week's Bills".
  const rows = [
    { debtId: "amazon", dueDate: utc(2026, 9, 17), amountCents: 10_000 },
    { debtId: "sams", dueDate: utc(2026, 9, 17), amountCents: 17_578 },
  ];

  test("drops a snapshot row whose (debt, payday) was skipped", () => {
    const out = withoutSkippedExtras(rows, new Set(["amazon:2026-09-17"]));
    assert.deepEqual(out.map((r) => r.debtId), ["sams"]);
  });

  test("a skip on a different payday or debt leaves the row alone", () => {
    const out = withoutSkippedExtras(rows, new Set(["amazon:2026-09-03", "other:2026-09-17"]));
    assert.equal(out.length, 2);
  });

  test("no skips (e.g. after Undo) keeps everything", () => {
    assert.equal(withoutSkippedExtras(rows, new Set()).length, 2);
  });
});
