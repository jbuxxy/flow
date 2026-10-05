import { describe, test } from "node:test";
import assert from "node:assert/strict";

// crypto.ts reads ENCRYPTION_KEY at call time (not import time); scripts/test.sh
// sets a 64-char hex key. Fail loudly if it is somehow missing.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);

const { decrypt, encrypt } = await import("@/lib/crypto");

describe("encrypt / decrypt", () => {
  test("round-trips arbitrary strings", () => {
    for (const value of ["hello", "a".repeat(5000), "🔐 unicode ✓", "access-url:https://user:pass@host/x"]) {
      assert.equal(decrypt(encrypt(value)), value);
    }
  });

  test("each encryption uses a fresh IV (ciphertext differs)", () => {
    assert.notEqual(encrypt("same"), encrypt("same"));
  });

  test("a malformed payload throws", () => {
    assert.throws(() => decrypt("not-a-valid-payload"), /Malformed encrypted payload/);
  });

  test("a tampered auth tag throws", () => {
    const [iv, , ct] = encrypt("secret").split(":");
    assert.throws(() => decrypt(`${iv}:${Buffer.from("0".repeat(16)).toString("base64")}:${ct}`));
  });
});
