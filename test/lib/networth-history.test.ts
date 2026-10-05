import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { netWorthWindow } from "@/lib/networth-history";

describe("networth-history.netWorthWindow", () => {
  const daily = [
    { dateKey: "2026-08-25", netWorthCents: 100_000 },
    { dateKey: "2026-09-22", netWorthCents: 90_000 },
    { dateKey: "2026-09-25", netWorthCents: 95_000 },
    { dateKey: "2026-09-29", netWorthCents: 70_000 }, // today's stale snapshot
  ];

  describe("regressions", () => {
    // 2026-09-29: chart and caption described different spans.
    test("ends on the live value and measures the delta over the same span it draws", () => {
      const w = netWorthWindow(daily, "2026-09-22", "2026-09-29", 88_000)!;
      assert.deepEqual(
        w.points.map((p) => p.dateKey),
        ["2026-09-22", "2026-09-25", "2026-09-29"],
      );
      assert.equal(w.points.at(-1)!.netWorthCents, 88_000);
      assert.equal(w.deltaCents, -2_000);
      assert.equal(w.startKey, "2026-09-22");
    });

    test("startKey is the first real snapshot when the requested start has a gap", () => {
      assert.equal(netWorthWindow(daily, "2026-09-23", "2026-09-29", 88_000)!.startKey, "2026-09-25");
    });

    test("null with no snapshot before today in the window", () => {
      assert.equal(netWorthWindow(daily, "2026-09-26", "2026-09-29", 88_000), null);
    });
  });
});
