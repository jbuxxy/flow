import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketStatus,
  STATUS_BAR_CLASS,
  baseRingColorAt,
  overageCoverageFraction,
  overageRedFraction,
  overageBlendColor,
  OVERAGE_ORANGE,
  OVERAGE_RED,
} from "@/lib/bucket-status";

describe("bucketStatus", () => {
  test("exceeded at/over 100%", () => {
    assert.equal(bucketStatus(100, 80), "exceeded");
    assert.equal(bucketStatus(140, 80), "exceeded");
  });

  test("warning at/over the threshold but under 100%", () => {
    assert.equal(bucketStatus(80, 80), "warning");
    assert.equal(bucketStatus(99.9, 80), "warning");
  });

  test("ok below the threshold", () => {
    assert.equal(bucketStatus(79, 80), "ok");
    assert.equal(bucketStatus(0, 80), "ok");
  });

  test("every status has a bar class", () => {
    for (const s of ["ok", "warning", "exceeded"] as const) {
      assert.ok(STATUS_BAR_CLASS[s]);
    }
  });
});

describe("baseRingColorAt", () => {
  test("flat green from 0% through 75%", () => {
    assert.equal(baseRingColorAt(0), "rgb(16, 185, 129)");
    assert.equal(baseRingColorAt(40), "rgb(16, 185, 129)");
    assert.equal(baseRingColorAt(75), "rgb(16, 185, 129)");
  });

  test("pure blue at 100%", () => {
    assert.equal(baseRingColorAt(100), "rgb(59, 130, 246)");
  });

  test("interpolates green -> blue over the last quarter", () => {
    const mid = baseRingColorAt(87.5);
    assert.notEqual(mid, baseRingColorAt(75));
    assert.notEqual(mid, baseRingColorAt(100));
  });

  test("clamps to the endpoints outside 0-100", () => {
    assert.equal(baseRingColorAt(-10), baseRingColorAt(0));
    assert.equal(baseRingColorAt(150), baseRingColorAt(100));
  });
});

describe("overageCoverageFraction", () => {
  test("zero at and below 100%", () => {
    assert.equal(overageCoverageFraction(100), 0);
    assert.equal(overageCoverageFraction(80), 0);
  });

  test("full ring (1) at 200%", () => {
    assert.equal(overageCoverageFraction(200), 1);
  });

  test("clamped, not extrapolated, above 200%", () => {
    assert.equal(overageCoverageFraction(400), 1);
  });

  test("grows linearly/proportionally, not eased", () => {
    // 72 of the 100 points it takes to reach 200% covers 72% of the ring.
    assert.equal(overageCoverageFraction(172), 0.72);
    assert.equal(overageCoverageFraction(150), 0.5);
  });
});

describe("overageRedFraction", () => {
  test("holds at 50/50 for the entire 100-200% range", () => {
    assert.equal(overageRedFraction(101), 0.5);
    assert.equal(overageRedFraction(150), 0.5);
    assert.equal(overageRedFraction(200), 0.5);
  });

  test("all red (1) at 300%", () => {
    assert.equal(overageRedFraction(300), 1);
  });

  test("clamped, not extrapolated, above 300%", () => {
    assert.equal(overageRedFraction(500), 1);
  });

  test("accelerates rather than growing linearly between 200% and 300%", () => {
    // Halfway from 200% to 300% (250%) is only a quarter of the way from
    // half-red to all-red, not the full halfway point.
    assert.equal(overageRedFraction(250), 0.625);
  });
});

describe("overageBlendColor", () => {
  test("pure orange at 0", () => {
    assert.equal(overageBlendColor(0), OVERAGE_ORANGE);
  });

  test("pure red at 1", () => {
    assert.equal(overageBlendColor(1), OVERAGE_RED);
  });

  test("clamps outside 0-1", () => {
    assert.equal(overageBlendColor(-1), OVERAGE_ORANGE);
    assert.equal(overageBlendColor(2), OVERAGE_RED);
  });

  test("interpolates in between", () => {
    const mid = overageBlendColor(0.5);
    assert.notEqual(mid, OVERAGE_ORANGE);
    assert.notEqual(mid, OVERAGE_RED);
  });
});
