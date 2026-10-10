import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clusterByAmount } from "@/lib/amount-tolerance";
import { formatBasisPoints, parseAmountParamCents, parseOptionalToleranceCents, parsePercentToBasisPoints } from "@/lib/money";
import { isP2PMerchant, p2pMerchantMatch } from "@/lib/p2p-keywords";
import { nameSimilarity, prepareName, preparedNameSimilarity } from "@/lib/fuzzy-match";
import { formatCompact, niceTicks } from "@/lib/chart-axis";
import { monthsAgoPeriodKey, periodLabel } from "@/lib/period";
import { parseDueDay } from "@/lib/date";
import { belongsToHousehold, hasFullAccess } from "@/lib/access-rules";

// Helpers consolidated from duplicated copies in the 2026-10-09 /simplify
// pass — each case pins the behavior the copies shared.

describe("clusterByAmount", () => {
  test("groups charges within tolerance of the running average, apart from a different-size series", () => {
    const clusters = clusterByAmount([{ amountCents: 1295 }, { amountCents: 8000 }, { amountCents: 1295 }, { amountCents: 8400 }]);
    assert.deepEqual(
      clusters.map((c) => c.map((t) => t.amountCents)),
      [[1295, 1295], [8000, 8400]],
    );
  });
});

describe("money parsers and formatters", () => {
  test("percent fields to basis points and back", () => {
    assert.equal(parsePercentToBasisPoints("19.99%"), 1999);
    assert.equal(parsePercentToBasisPoints(" 0 "), 0);
    assert.equal(parsePercentToBasisPoints("101"), null);
    assert.equal(parsePercentToBasisPoints("abc"), null);
    assert.equal(formatBasisPoints(1999), "19.99%");
  });

  test("optional tolerance: blank is the default, junk is rejected", () => {
    assert.deepEqual(parseOptionalToleranceCents(undefined), { ok: true, value: null });
    assert.deepEqual(parseOptionalToleranceCents("2.50"), { ok: true, value: 250 });
    assert.deepEqual(parseOptionalToleranceCents("-1"), { ok: false });
  });

  test("the /transactions amount param parses the same on client and server", () => {
    assert.equal(parseAmountParamCents("12.34"), 1234);
    assert.equal(parseAmountParamCents(""), undefined);
    assert.equal(parseAmountParamCents("x"), undefined);
  });
});

describe("isP2PMerchant / p2pMerchantMatch", () => {
  test("case-insensitive substring match on any P2P app", () => {
    assert.equal(isP2PMerchant("VENMO *Jane"), true);
    assert.equal(isP2PMerchant("Zelle payment to Sam"), true);
    assert.equal(isP2PMerchant("Walmart"), false);
    assert.equal(isP2PMerchant(null), false);
    assert.ok(p2pMerchantMatch().OR.length > 0);
  });
});

describe("preparedNameSimilarity", () => {
  test("matches nameSimilarity exactly", () => {
    const pairs: [string, string][] = [
      ["Netflix", "Netflix.com"],
      ["Crestline High Flex", "Crestline Flex"],
      ["Summit Gas", "Summit Home Loans"],
      ["", "x"],
    ];
    for (const [a, b] of pairs) assert.equal(preparedNameSimilarity(prepareName(a), prepareName(b)), nameSimilarity(a, b));
  });
});

describe("chart axis helpers", () => {
  test("compact tick text, including negatives", () => {
    assert.equal(formatCompact(123_456_78), "$123K");
    assert.equal(formatCompact(250_000_000), "$2.5M");
    assert.equal(formatCompact(-4_000_000), "-$40K");
    assert.equal(formatCompact(5_000), "$50");
  });

  test("nice ticks span the range in 1/2/5 steps", () => {
    assert.deepEqual(niceTicks(0, 1000), [0, 500, 1000]);
  });
});

describe("period helpers", () => {
  test("label and months-ago key", () => {
    assert.equal(periodLabel("2026-10"), "October 2026");
    assert.equal(monthsAgoPeriodKey(1, new Date(2026, 0, 15)), "2025-12");
  });
});

describe("parseDueDay", () => {
  test("1-31 only", () => {
    assert.equal(parseDueDay("15"), 15);
    assert.equal(parseDueDay("0"), null);
    assert.equal(parseDueDay("32"), null);
    assert.equal(parseDueDay("1.5"), null);
  });
});

describe("access-rules", () => {
  test("pure checks shared by client and server", () => {
    assert.equal(hasFullAccess({ role: "PARENT", dashboardScope: "FULL" }), true);
    assert.equal(hasFullAccess({ role: "CHILD", dashboardScope: "BUCKETS_ONLY" }), false);
    assert.equal(belongsToHousehold({ householdId: "h1" }, "h1"), true);
    assert.equal(belongsToHousehold(null, "h1"), false);
  });
});
