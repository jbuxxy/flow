import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nameSimilarity } from "@/lib/fuzzy-match";

describe("nameSimilarity", () => {
  test("empty input scores 0", () => {
    assert.equal(nameSimilarity("", "Netflix"), 0);
    assert.equal(nameSimilarity("Netflix", ""), 0);
    assert.equal(nameSimilarity("!!!", "Netflix"), 0); // normalizes to empty
  });

  test("exact match after normalization scores 1", () => {
    assert.equal(nameSimilarity("Net-Flix", "net flix"), 1);
    assert.equal(nameSimilarity("NETFLIX", "netflix"), 1);
  });

  test("one string containing the other scores 0.8", () => {
    assert.equal(nameSimilarity("Netflix", "Netflix.com Subscription"), 0.8);
    assert.equal(nameSimilarity("AMAZON PRIME MEMBERSHIP", "amazon prime"), 0.8);
  });

  test("word overlap = shared / max(distinct words > 2 chars)", () => {
    // "fairview water improvement district" vs "fairview city debits web"
    // share only "fairview" -> 1 / 4 = 0.25, safely below the 0.75 match bar.
    assert.equal(nameSimilarity("Fairview Water Improvement District", "Fairview City Debits Web"), 0.25);
  });

  test("no shared words > 2 chars scores 0", () => {
    assert.equal(nameSimilarity("Costco Wholesale", "Trader Joes"), 0);
  });

  test("short words (<= 2 chars) are ignored in the overlap set", () => {
    // "at&t" -> "at t"; both words too short -> 0.
    assert.equal(nameSimilarity("AT T", "AT T Wireless"), 0.8); // substring tier wins first
  });

  describe("regressions", () => {
    // 2026-09-14: a pending-transaction hold's merchant string carried one
    // extra descriptor word ("High") the posted charge dropped, so the plain
    // substring check (contiguous only) missed it and the word-overlap ratio
    // scored 1/4 = 0.75 — just under the 0.8 bar simplefin-sync.ts's
    // reconcileStalePendingRows uses to auto-merge a stale pending row into
    // its settled twin, leaving "Pending Crestline High Flex" stuck
    // alongside the real "Crestline Flex" charge instead of being retired.
    test("one name's whole word set inside the other, out of contiguous order, still scores 0.8", () => {
      assert.equal(nameSimilarity("Crestline High Flex", "Crestline Flex"), 0.8);
      assert.equal(nameSimilarity("Crestline Flex", "Crestline High Flex"), 0.8);
    });
  });
});
