import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent } from "@/lib/concurrency";

describe("mapConcurrent", () => {
  test("runs fn over every item exactly once, in any order", async () => {
    const seen: number[] = [];
    await mapConcurrent([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  test("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapConcurrent(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });
    assert.ok(maxInFlight <= 3, `expected at most 3 in flight, saw ${maxInFlight}`);
  });

  test("passes each item's own index", async () => {
    const pairs: [number, number][] = [];
    await mapConcurrent(["a", "b", "c"], 5, async (item, index) => {
      pairs.push([index, item.length]);
    });
    assert.equal(pairs.length, 3);
    for (const [index] of pairs) assert.ok(index >= 0 && index < 3);
  });

  test("limit larger than the item count doesn't over-spawn workers", async () => {
    let calls = 0;
    await mapConcurrent([1, 2], 50, async () => {
      calls++;
    });
    assert.equal(calls, 2);
  });

  test("empty items list resolves immediately, no calls", async () => {
    let calls = 0;
    await mapConcurrent([], 5, async () => {
      calls++;
    });
    assert.equal(calls, 0);
  });

  test("a limit of 0 or negative still makes progress (floored to 1 worker)", async () => {
    const seen: number[] = [];
    await mapConcurrent([1, 2, 3], 0, async (item) => {
      seen.push(item);
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3]);
  });

  test("propagates a thrown error from fn", async () => {
    await assert.rejects(
      mapConcurrent([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
      }),
      /boom/,
    );
  });
});
