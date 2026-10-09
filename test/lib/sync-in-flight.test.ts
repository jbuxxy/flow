import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { singleFlight, trackSync, whenSyncsIdle } from "@/lib/sync-in-flight";

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

describe("singleFlight", () => {
  test("a second call for the same key while one runs joins it instead of starting another", async () => {
    // Regression (2026-10-08 review): the poller and Sync Now ran the same
    // household's sync concurrently and both advanced its trackers.
    const d = deferred();
    let starts = 0;
    const run = () => {
      starts++;
      return d.promise;
    };
    const a = singleFlight("h1", run);
    const b = singleFlight("h1", run);
    assert.equal(a, b);
    assert.equal(starts, 1);
    d.resolve();
    await a;
  });

  test("different keys run independently, and a finished run frees its key", async () => {
    let starts = 0;
    const run = async () => {
      starts++;
    };
    await Promise.all([singleFlight("h2", run), singleFlight("h3", run)]);
    assert.equal(starts, 2);
    await singleFlight("h2", run);
    assert.equal(starts, 3);
  });

  test("a failed run also frees its key", async () => {
    const failing = () => Promise.reject(new Error("boom"));
    await assert.rejects(singleFlight("h4", failing));
    let ran = false;
    await singleFlight("h4", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});
