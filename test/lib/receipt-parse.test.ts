import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isMarketingSender, isPromoSubject, looksLikeBillNotice, looksLikeReceipt } from "@/lib/receipt-parse";
import { bodyText, cleanEmailBody, htmlToText, stripLinks } from "@/lib/email-body";

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

describe("isPromoSubject — strong offer language beats a transaction word", () => {
  test("$/% off and countdowns veto even with \"order\" in the subject", () => {
    assert.equal(isPromoSubject("4 Hrs Only! $10 Off Your $20 Order*"), true);
    assert.equal(isPromoSubject("Get $20 off your order, Alex!"), true);
    assert.equal(isPromoSubject("Update: Price drop on women's barrel pants"), true);
  });
  test("real receipt subjects still pass", () => {
    assert.equal(isPromoSubject("Thanks for your delivery order, Alex"), false);
    assert.equal(isPromoSubject("Your refund was issued, Alex"), false);
    assert.equal(isPromoSubject("Here’s your Example Store receipt"), false);
  });
});

describe("isMarketingSender", () => {
  test("marketing subdomain with no transaction word is dropped", () => {
    assert.equal(isMarketingSender("Example Store <shop@em.examplestore.com>", "Halloween home makeover"), true);
    assert.equal(isMarketingSender("hello@mkt.exampleapparel.com", "Fall temps call for new sweatpants"), true);
  });
  test("a transaction subject from a marketing subdomain is kept", () => {
    assert.equal(isMarketingSender("transaction@info.examplestore.com", "Here's your Example Store receipt"), false);
    assert.equal(isMarketingSender("donotreply@e.examplegifts.com", "Your order has shipped"), false);
  });
  test("a marketing mailbox name is dropped whatever the subject", () => {
    assert.equal(isMarketingSender("store-news@amazon.com", "Your $3 reward is within reach"), true);
    assert.equal(isMarketingSender("newsletters@em.examplestore.com", "Ready to complete your order?"), true);
  });
  test("ordinary transactional senders are untouched", () => {
    assert.equal(isMarketingSender("auto-confirm@amazon.com", "Ordered 1 item: Snacks"), false);
    assert.equal(isMarketingSender("capitalone@notification.capitalone.com", "Your AutoPay payment is scheduled"), false);
  });
});

describe("cleanEmailBody", () => {
  test("cuts footer boilerplate and carousels after the last amount", () => {
    const body = "Order number: #1000001\nORDER TOTAL $16.10\nRECENTLY VIEWED ITEMS\nDresser $89.00 ad\n© 2026 Example Store";
    // the carousel has an amount, so the cut lands after it — at the © line
    assert.equal(cleanEmailBody(body), "Order number: #1000001\nORDER TOTAL $16.10\nRECENTLY VIEWED ITEMS\nDresser $89.00 ad");
    assert.equal(cleanEmailBody("Total $5.00\nQuestions? Visit our Help Center\nUnsubscribe"), "Total $5.00");
  });
  test("a footer-looking line above the total never cuts it", () => {
    assert.equal(cleanEmailBody("Customer service order\nTotal $5.00"), "Customer service order\nTotal $5.00");
  });
  test("drops zero-width spacer runs, blank/symbol-only lines, and repeated long lines", () => {
    const body = "You paid Sam Rivera $8.50\n\u200c \u200c \u200c\n---\nYou paid Sam Rivera $8.50\nQty: 1\nQty: 1";
    assert.equal(cleanEmailBody(body), "You paid Sam Rivera $8.50\nQty: 1\nQty: 1");
  });
});

describe("htmlToText / bodyText", () => {
  test("block tags become lines, entities decode, scripts drop", () => {
    assert.equal(
      htmlToText("<style>x{}</style><div>Paid&nbsp;to</div><p>Sam &amp; Co</p><td>A</td><td>B</td>"),
      " Paid to\nSam & Co\nA B ",
    );
  });
  test("html-only mail keeps its lines so the footer can be cut", () => {
    assert.equal(bodyText(undefined, "<div>Total $8.50</div><div>For any issues, contact us</div>"), "Total $8.50");
  });
});
