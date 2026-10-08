import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackSync, whenSyncsIdle } from "@/lib/sync-in-flight";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("whenSyncsIdle", () => {
  test("resolves immediately with no sync running", async () => {
    await whenSyncsIdle();
  });

  test("waits for a running sync, and one that starts while waiting", async () => {
    const first = deferred();
    const second = deferred();
    trackSync(first.promise);
    let idle = false;
    const waiting = whenSyncsIdle().then(() => (idle = true));

    first.resolve();
    trackSync(second.promise); // starts before the waiter re-checks
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(idle, false);

    second.resolve();
    await waiting;
    assert.equal(idle, true);
  });

  test("a failed sync still counts as finished", async () => {
    const failing = deferred();
    trackSync(failing.promise).catch(() => {});
    const waiting = whenSyncsIdle();
    failing.reject(new Error("bank down"));
    await waiting;
  });
});
