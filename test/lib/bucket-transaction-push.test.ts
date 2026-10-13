import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bucketTransactionPush } from "@/lib/buckets";

const amazon = (amountCents: number) => ({ merchant: "Amazon", amountCents });

describe("bucketTransactionPush", () => {
  test("a single charge keeps the one-line title", () => {
    const { title, body } = bucketTransactionPush({
      bucketName: "Amazon",
      batch: [amazon(859)],
      todayCount: 1,
      todayCents: 859,
      progressLine: "$100.00 of $300.00 spent this month.",
    });
    assert.equal(title, "$8.59 at Amazon");
    assert.equal(body, "Amazon: $100.00 of $300.00 spent this month. Today: 1 transaction totaling $8.59.");
  });

  // Four pending Amazon charges in one sync used to be four separate pushes.
  test("a batch becomes one push listing each charge", () => {
    const { title, body } = bucketTransactionPush({
      bucketName: "Amazon",
      batch: [amazon(3437), amazon(3328), amazon(850), amazon(1073)],
      todayCount: 4,
      todayCents: 8688,
      progressLine: "$200.00 of $300.00 spent this month.",
    });
    assert.equal(title, "4 New Transactions in Amazon");
    assert.equal(
      body,
      [
        "$34.37 at Amazon",
        "$33.28 at Amazon",
        "$8.50 at Amazon",
        "$10.73 at Amazon",
        "Today: 4 transactions totaling $86.88.",
        "Amazon: $200.00 of $300.00 spent this month.",
      ].join("\n"),
    );
  });

  // A later batch's "today" covers the earlier one too (9 charges), not just its own.
  test("today totals cover the whole day, not just this batch", () => {
    const { body } = bucketTransactionPush({
      bucketName: "Amazon",
      batch: [amazon(859), amazon(1599), amazon(1499)],
      todayCount: 7,
      todayCents: 12645,
      progressLine: "x",
    });
    assert.match(body, /Today: 7 transactions totaling \$126\.45\./);
  });

  test("a long batch folds the overflow into +N more", () => {
    const { body } = bucketTransactionPush({
      bucketName: "Amazon",
      batch: Array.from({ length: 8 }, () => amazon(100)),
      todayCount: 8,
      todayCents: 800,
      progressLine: "x",
    });
    const lines = body.split("\n");
    assert.equal(lines.filter((l) => l === "$1.00 at Amazon").length, 5);
    assert.ok(lines.includes("+3 more"));
  });
});
