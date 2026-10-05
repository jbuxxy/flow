import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeBillNotice } from "@/lib/receipt-parse";

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
