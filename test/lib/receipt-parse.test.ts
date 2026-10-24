import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isPromoSubject, looksLikeBillNotice, looksLikeReceipt } from "@/lib/receipt-parse";
import { stripLinks } from "@/lib/email-provider";

const msg = (o: Partial<{ subject: string; from: string; text: string }> = {}) => ({
  subject: "",
  from: "billing@example.com",
  text: "",
  ...o,
});

describe("looksLikeBillNotice", () => {
  test("positive on a bill-ready notice with an amount", () => {
    assert.equal(
      looksLikeBillNotice(msg({ subject: "Your Verizon bill is ready", text: "Total amount due: $84.12" })),
      true,
    );
  });

  test("positive on a plain amount-due phrase", () => {
    assert.equal(looksLikeBillNotice(msg({ subject: "Payment reminder", text: "Amount Due $84.12 by 10/3." })), true);
  });

  test("negative on an unrelated marketing email", () => {
    assert.equal(
      looksLikeBillNotice(msg({ subject: "50% off everything this weekend", text: "Shop now and save $20 on your order." })),
      false,
    );
  });

  test("negative on a completed-payment receipt that also mentions a future due date", () => {
    assert.equal(
      looksLikeBillNotice(
        msg({
          subject: "Your payment was successful",
          text: "You paid $84.12. Your next statement will be ready around Nov 3.",
        }),
      ),
      false,
    );
  });

  test("negative with a bill-shaped phrase but no money amount", () => {
    assert.equal(looksLikeBillNotice(msg({ subject: "Your bill is ready", text: "Log in to view your statement." })), false);
  });
});

// 2026-10-24: a bare no-reply sender + any "$" sent every retailer promo to
// the AI; tracking links padded every body.
describe("looksLikeReceipt — promos and no-reply senders", () => {
  test("a promo subject is never a receipt candidate", () => {
    assert.equal(
      looksLikeReceipt(msg({ from: "Macy's <no-reply@em.macys.com>", subject: "Up to 60% off bras, PJs & more", text: "Save $20 on your order" })),
      false,
    );
  });
  test("a promo word next to a transaction word still passes", () => {
    assert.equal(isPromoSubject("Your sale order has shipped"), false);
    assert.equal(isPromoSubject("Fall Sale 🍂 up to 50% off"), true);
  });
  test("a no-reply sender needs a receipt phrase or a transaction subject", () => {
    assert.equal(looksLikeReceipt(msg({ from: "noreply@mail.audible.com", subject: "A new listen for you", text: "Only $14.95" })), false);
    assert.equal(looksLikeReceipt(msg({ from: "noreply@intouchpay.com", subject: "Receipt #1937698", text: "Amount $45.00" })), true);
    assert.equal(looksLikeReceipt(msg({ from: "noreply@jackrabbittech.com", subject: "Payment Approved", text: "$120.00" })), true);
  });
});

describe("stripLinks", () => {
  test("drops URLs and the empty brackets they leave", () => {
    assert.equal(stripLinks("Order #123 [https://t.co/abc?x=1]\nTotal $5.00 <https://x.io/y>"), "Order #123 \nTotal $5.00 ");
  });
});
