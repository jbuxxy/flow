import { describe, test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  showToast,
  dismissToast,
  setToastsSuppressed,
  resolveActionEdge,
  __resetToastsForTest,
  __getToastsForTest,
} from "@/lib/toast";

beforeEach(() => __resetToastsForTest());

describe("toast.resolveActionEdge", () => {
  test("fires success once on the pending true -> false edge with no error", () => {
    assert.equal(resolveActionEdge(true, false, undefined), "success");
  });
  test("fires error on the edge when an error is present", () => {
    assert.equal(resolveActionEdge(true, false, "Nope"), "error");
  });
  test("null while still pending, or when it was never pending", () => {
    assert.equal(resolveActionEdge(true, true, undefined), null);
    assert.equal(resolveActionEdge(false, false, undefined), null);
    assert.equal(resolveActionEdge(false, true, undefined), null);
  });
});

describe("toast store", () => {
  test("showToast appends a toast", () => {
    showToast("Bucket Saved");
    const list = __getToastsForTest();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "Bucket Saved");
    assert.equal(list[0].tone, "success");
  });

  test("hard FIFO cap of 3 — the oldest drops", () => {
    showToast("One");
    showToast("Two");
    showToast("Three");
    showToast("Four");
    assert.deepEqual(
      __getToastsForTest().map((t) => t.title),
      ["Two", "Three", "Four"],
    );
  });

  test("identical title+tone dedupes to a single toast", () => {
    showToast("Payment Marked Paid");
    showToast("Payment Marked Paid");
    showToast("Payment Marked Paid");
    assert.equal(__getToastsForTest().length, 1);
  });

  test("a different tone with the same title is NOT deduped", () => {
    showToast("Saved", "success");
    showToast("Saved", "error");
    assert.equal(__getToastsForTest().length, 2);
  });

  test("dismissToast removes just that toast", () => {
    showToast("One");
    showToast("Two");
    const [first] = __getToastsForTest();
    dismissToast(first.id);
    assert.deepEqual(
      __getToastsForTest().map((t) => t.title),
      ["Two"],
    );
  });

  test("suppressed -> showToast is a no-op", () => {
    setToastsSuppressed(true);
    showToast("Bucket Saved");
    assert.equal(__getToastsForTest().length, 0);
    setToastsSuppressed(false);
    showToast("Bucket Saved");
    assert.equal(__getToastsForTest().length, 1);
  });

  test("auto-dismisses after 2200ms", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      showToast("Bucket Saved");
      assert.equal(__getToastsForTest().length, 1);
      mock.timers.tick(2199);
      assert.equal(__getToastsForTest().length, 1);
      mock.timers.tick(2);
      assert.equal(__getToastsForTest().length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  test("a deduped repeat restarts the dismiss timer", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      showToast("Order Saved");
      mock.timers.tick(2000);
      showToast("Order Saved"); // dedupe: resets the clock
      mock.timers.tick(2000);
      assert.equal(__getToastsForTest().length, 1);
      mock.timers.tick(300);
      assert.equal(__getToastsForTest().length, 0);
    } finally {
      mock.timers.reset();
    }
  });
});
