import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  amazonOrderNumber,
  amazonSummaryItems,
  isAmazonSender,
  mergeAmazonProductNames,
  parseAmazonSubject,
} from "@/lib/amazon-email";

describe("parseAmazonSubject", () => {
  test("count + categories", () => {
    assert.deepEqual(parseAmazonSubject("Ordered 2 items: Automotive"), {
      type: "summary",
      count: 2,
      categories: ["Automotive"],
      more: false,
    });
    assert.deepEqual(parseAmazonSubject("Shipped 3 items: Electronics, Home Audio Accessories, and more"), {
      type: "summary",
      count: 3,
      categories: ["Electronics", "Home Audio Accessories"],
      more: true,
    });
    assert.deepEqual(parseAmazonSubject("Out for delivery 1 item: Automotive"), {
      type: "summary",
      count: 1,
      categories: ["Automotive"],
      more: false,
    });
  });

  test("the 'Ordered: 1 Lawn & Garden item' wording", () => {
    assert.deepEqual(parseAmazonSubject("Ordered: 1 Lawn & Garden item"), {
      type: "summary",
      count: 1,
      categories: ["Lawn & Garden"],
      more: false,
    });
  });

  test("product names from delivery updates and returns, ellipsis stripped", () => {
    assert.deepEqual(parseAmazonSubject('Delivery update: "Weize Floor Mats for Tesla..."'), {
      type: "product",
      productName: "Weize Floor Mats for Tesla",
    });
    assert.deepEqual(parseAmazonSubject("Advance refund issued for OHP FORScan ELM327 OBD2 to USB...."), {
      type: "product",
      productName: "OHP FORScan ELM327 OBD2 to USB",
    });
    assert.deepEqual(parseAmazonSubject("Return request confirmed for Foronetry Floor Mats for 2025..."), {
      type: "product",
      productName: "Foronetry Floor Mats for 2025",
    });
  });

  test("anything else is null", () => {
    assert.equal(parseAmazonSubject("We found something you might like"), null);
    assert.equal(parseAmazonSubject("Refund on order 113-9163440-8640235"), null);
  });
});

describe("amazon helpers", () => {
  test("sender and order number", () => {
    assert.equal(isAmazonSender("Amazon.com <auto-confirm@amazon.com>"), true);
    assert.equal(isAmazonSender("shipment-tracking@amazon.com"), true);
    assert.equal(isAmazonSender("deals@notamazon.com.example"), false);
    assert.equal(amazonOrderNumber("Order #\n113-4817318-6197835\nView"), "113-4817318-6197835");
    assert.equal(amazonOrderNumber("no order here"), null);
  });

  test("summary items: one category carries count and total; several list each", () => {
    assert.deepEqual(amazonSummaryItems({ type: "summary", count: 2, categories: ["Automotive"], more: false }, 2183), [
      { description: "Automotive", qty: 2, totalCents: 2183, unitPriceCents: null },
    ]);
    assert.deepEqual(
      amazonSummaryItems({ type: "summary", count: 3, categories: ["Electronics", "Toys"], more: true }, 5000).map(
        (i) => i.description,
      ),
      ["Electronics", "Toys", "More Items"],
    );
  });
});

describe("mergeAmazonProductNames", () => {
  test("a lone product replaces a lone category line and keeps its amount", () => {
    assert.deepEqual(mergeAmazonProductNames([{ description: "Automotive", qty: 1, totalCents: 4942 }], ["Floor Mats"]), [
      { description: "Floor Mats", qty: 1, totalCents: 4942, unitPriceCents: null },
    ]);
  });

  test("fewer names than lines keeps the remaining lines after the names", () => {
    const merged = mergeAmazonProductNames(
      [{ description: "Automotive" }, { description: "Electronics" }, { description: "More Items" }],
      ["Floor Mats"],
    );
    assert.deepEqual(
      merged?.map((i) => i.description),
      ["Floor Mats", "Automotive", "Electronics", "More Items"],
    );
  });

  test("no change when the names are already there", () => {
    assert.equal(mergeAmazonProductNames([{ description: "Floor Mats" }], ["Floor Mats"]), null);
  });
});
