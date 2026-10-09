import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pendingRowRetirable, phantomTwinMergeData, settleOrphanPendingInPlace } from "@/lib/pending-twin-merge";

const row = (o: Record<string, unknown> = {}) => ({ isIncome: false, isTransfer: false, oneOff: false, ...o });

describe("phantomTwinMergeData", () => {
  test("copies the phantom's classification onto an unfiled twin", () => {
    assert.deepEqual(phantomTwinMergeData(row({ bucketId: "b1", label: "x" }), row()), { bucketId: "b1", label: "x" });
  });

  test("without a bill link, the posted twin keeps its own filing but still takes the rest", () => {
    assert.deepEqual(phantomTwinMergeData(row({ bucketId: "b1", label: "x" }), row({ bucketId: "b2" })), { label: "x" });
  });

  // Real report 2026-09-30: iCloud+ pending hold kept the bill; posted twin
  // fell through to the "Apple" → One-offs merchant rule and the phantom was
  // stuck forever.
  test("a bill-linked phantom's bucket/category override the twin's fallback filing", () => {
    const p = row({ billId: "bill", bucketId: "subs", categoryId: "storage" });
    const t = row({ bucketId: "oneoffs", categoryId: "fees" });
    assert.deepEqual(phantomTwinMergeData(p, t), { billId: "bill", bucketId: "subs", categoryId: "storage" });
  });

  test("the bill doesn't override a twin with its own link", () => {
    const p = row({ billId: "bill", bucketId: "subs" });
    assert.deepEqual(phantomTwinMergeData(p, row({ billId: "other", bucketId: "x" })), {});
    assert.deepEqual(phantomTwinMergeData(p, row({ debtId: "d", bucketId: "x" })), {});
  });

  test("a filed twin never mixes in the phantom's different classification", () => {
    // Regression (2026-10-08 review): a twin auto-linked as a card payment
    // also took the hold's bucket and counted as both spend and a payment.
    const debtTwin = row({ debtId: "card", isTransfer: true });
    assert.deepEqual(phantomTwinMergeData(row({ bucketId: "groceries", categoryId: "c" }), debtTwin), {});
    // An income phantom doesn't flag a bucketed twin as income too.
    assert.deepEqual(phantomTwinMergeData(row({ isIncome: true, oneOff: true }), row({ bucketId: "b" })), {});
    // A bill can't override a twin that's a debt payment, even with no debtId.
    assert.deepEqual(phantomTwinMergeData(row({ billId: "bill", bucketId: "subs" }), row({ isTransfer: true })), {});
  });

  test("an unfiled twin takes the phantom's whole classification, flags included", () => {
    assert.deepEqual(phantomTwinMergeData(row({ isIncome: true, incomeId: "pay" }), row()), {
      incomeId: "pay",
      isIncome: true,
    });
  });

  test("the bill only overrides bill-derived fields, not a label", () => {
    assert.deepEqual(phantomTwinMergeData(row({ billId: "bill", label: "a" }), row({ label: "b" })), { billId: "bill" });
  });
});

describe("pendingRowRetirable", () => {
  const t = (hh: number, mm: number) => new Date(Date.UTC(2026, 9, 5, hh, mm));
  const base = { syncStartedAt: t(20, 43), graceCutoff: t(19, 43) };

  test("past the grace period: retirable with or without a twin", () => {
    assert.equal(pendingRowRetirable({ ...base, pendingUpdatedAt: t(19, 0), twinUpdatedAt: null }), true);
  });

  describe("regressions", () => {
    // 2026-10-05: SalonCentric pending hold last seen 20:33, its posted twin
    // arrived in the 20:43 sync — both counted for an hour.
    test("dropped by this sync with its twin arriving in it: retire now", () => {
      assert.equal(pendingRowRetirable({ ...base, pendingUpdatedAt: t(20, 33), twinUpdatedAt: t(20, 43) }), true);
    });
  });

  test("inside the grace period without a twin from this sync: wait", () => {
    assert.equal(pendingRowRetirable({ ...base, pendingUpdatedAt: t(20, 33), twinUpdatedAt: null }), false);
    // Twin is from an earlier sync — no proof this account synced this run.
    assert.equal(pendingRowRetirable({ ...base, pendingUpdatedAt: t(20, 33), twinUpdatedAt: t(20, 20) }), false);
    // Still in the feed this sync.
    assert.equal(pendingRowRetirable({ ...base, pendingUpdatedAt: t(20, 44), twinUpdatedAt: t(20, 44) }), false);
    // Outside a sync.
    assert.equal(pendingRowRetirable({ ...base, syncStartedAt: null, pendingUpdatedAt: t(20, 33), twinUpdatedAt: t(20, 43) }), false);
  });
});

describe("settleOrphanPendingInPlace", () => {
  const cutoff = new Date(Date.UTC(2026, 8, 29));
  const base = { hasTwin: false, accountedForLinks: 1, orphanCutoff: cutoff };

  describe("regressions", () => {
    // 2026-10-06: Sam's Club $141.49 hold last seen Sep 28, a card payment
    // linked as covering it, posted copy never delivered — sat pending.
    test("no twin, covered by a payment, gone past the orphan wait: settle", () => {
      assert.equal(settleOrphanPendingInPlace({ ...base, pendingUpdatedAt: new Date(Date.UTC(2026, 8, 28)) }), true);
    });
  });

  test("still inside the orphan wait: leave it for a slow twin", () => {
    assert.equal(settleOrphanPendingInPlace({ ...base, pendingUpdatedAt: new Date(Date.UTC(2026, 9, 1)) }), false);
  });

  test("a twin exists or nothing vouches for it: not this path", () => {
    const old = new Date(Date.UTC(2026, 8, 20));
    assert.equal(settleOrphanPendingInPlace({ ...base, hasTwin: true, pendingUpdatedAt: old }), false);
    assert.equal(settleOrphanPendingInPlace({ ...base, accountedForLinks: 0, pendingUpdatedAt: old }), false);
  });
});
