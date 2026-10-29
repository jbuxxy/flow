import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  amazonOrderNumber,
  amazonSummaryItems,
  isAmazonSender,
  mergeAmazonProductNames,
  parseAmazonOrderEmail,
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

describe("parseAmazonOrderEmail", () => {
  const order = (text: string, from = '"Amazon.com" <auto-confirm@amazon.com>') => ({
    from,
    text,
    // 8:49pm Oct 1 in Denver — already Oct 2 in UTC
    receivedAt: new Date("2026-10-02T02:49:35Z"),
  });

  test("order confirmation: total (raw float), order number, local order date", () => {
    const p = parseAmazonOrderEmail(order("Order #\n111-1234567-7654321\nView or edit order\nGrand Total:\n5.6 USD"));
    assert.deepEqual(p, {
      kind: "ORDER_CONFIRMATION",
      totalCents: 560,
      orderNumber: "111-1234567-7654321",
      occurredOn: new Date("2026-10-01T00:00:00Z"),
    });
  });

  test("shipment: \"Total\" line with float noise rounds to cents", () => {
    const p = parseAmazonOrderEmail(
      order("Order #\n111-2345678-8765432\nTrack package\nTotal\n5.3500000000000005 USD", "shipment-tracking@amazon.com"),
    );
    assert.equal(p?.kind, "SHIPPING");
    assert.equal(p?.totalCents, 535);
  });

  test("one order repeated per delivery group still parses", () => {
    const text = "Order #\n111-3456789-9876543\nArriving Monday\nOrder #\n111-3456789-9876543\nGrand Total:\n484.2 USD";
    assert.equal(parseAmazonOrderEmail(order(text))?.totalCents, 48420);
  });

  test("several orders, a missing total, or another sender go to the AI", () => {
    assert.equal(parseAmazonOrderEmail(order("Order #\n111-1111111-1111111\nOrder #\n111-2222222-2222222\nGrand Total:\n9.99 USD")), null);
    assert.equal(parseAmazonOrderEmail(order("Order #\n111-1111111-1111111\nTrack package")), null);
    assert.equal(parseAmazonOrderEmail(order("Order #\n111-1111111-1111111\nGrand Total:\n9.99 USD", "store-news@amazon.com")), null);
  });
});
