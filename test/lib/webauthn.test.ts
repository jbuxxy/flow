import { describe, test } from "node:test";
import assert from "node:assert/strict";

// rpID()/expectedOrigin() read NEXTAUTH_URL lazily at call time, same
// pattern as webauthn-token.ts's NEXTAUTH_SECRET.
const { rpID, expectedOrigin, guessDeviceNickname } = await import("@/lib/webauthn");

describe("rpID / expectedOrigin", () => {
  test("derives from NEXTAUTH_URL — dev", () => {
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    assert.equal(rpID(), "localhost");
    assert.equal(expectedOrigin(), "http://localhost:3000");
  });

  test("derives from NEXTAUTH_URL — prod", () => {
    process.env.NEXTAUTH_URL = "https://flow.example.com";
    assert.equal(rpID(), "flow.example.com");
    assert.equal(expectedOrigin(), "https://flow.example.com");
  });
});

describe("guessDeviceNickname", () => {
  test("recognizes common device UAs", () => {
    assert.equal(
      guessDeviceNickname(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15",
      ),
      "iPhone",
    );
    assert.equal(
      guessDeviceNickname("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
      "Mac",
    );
    assert.equal(
      guessDeviceNickname("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
      "Windows PC",
    );
    assert.equal(
      guessDeviceNickname("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36"),
      "Android Device",
    );
  });

  test("falls back for null/unrecognized UAs", () => {
    assert.equal(guessDeviceNickname(null), "New Device");
    assert.equal(guessDeviceNickname("some obscure browser string"), "New Device");
  });
});
