import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runOnce } from "@/lib/run-once";

// Silences the expected error logs for the failure-path cases.
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

describe("runOnce", () => {
  test("claimed: runs the work and keeps the claim", async () => {
    let worked = 0;
    let released = 0;
    const r = await runOnce("t", async () => ({ count: 1 }), async () => released++, async () => {
      worked++;
    });
    assert.equal(r, "done");
    assert.equal(worked, 1);
    assert.equal(released, 0);
  });

  test("already claimed: skips the work", async () => {
    let worked = 0;
    const r = await runOnce("t", async () => ({ count: 0 }), async () => {}, async () => {
      worked++;
    });
    assert.equal(r, "already-done");
    assert.equal(worked, 0);
  });

  test("work throws: releases the claim so the next run retries, never throws", async () => {
    // Regression (2026-10-08 review): a failed push or report generation
    // after the claim used up that period's notification for good.
    let released = 0;
    const r = await quiet(() =>
      runOnce("t", async () => ({ count: 1 }), async () => released++, async () => {
        throw new Error("push failed");
      }),
    );
    assert.equal(r, "failed");
    assert.equal(released, 1);
  });

  test("claim throws: reported as failed, not as already done, and the work is skipped", async () => {
    let worked = 0;
    const r = await quiet(() =>
      runOnce("t", async () => { throw new Error("db down"); }, async () => {}, async () => {
        worked++;
      }),
    );
    assert.equal(r, "failed");
    assert.equal(worked, 0);
  });
});
