import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.NEXTAUTH_SECRET ??= "test-nextauth-secret-value-1234567890";

const { createSetupToken, verifySetupToken } = await import("@/lib/setup-token");
const { isLocked } = await import("@/lib/login-lockout");
const { hashPassword, verifyPassword } = await import("@/lib/password");
const { generateTotpSecret, verifyTotpCode } = await import("@/lib/totp");
const {
  createChallengeToken,
  verifyChallengeToken,
  createLoginVerifiedToken,
  decodeLoginVerifiedToken,
} = await import("@/lib/webauthn-token");

describe("setup-token", () => {
  test("round-trips a userId through an HMAC-signed token", () => {
    const token = createSetupToken("user-123");
    assert.deepEqual(verifySetupToken(token), { userId: "user-123" });
  });

  test("rejects a tampered payload (signature no longer matches)", () => {
    const [encoded, sig] = createSetupToken("user-123").split(".");
    const forged = Buffer.from(JSON.stringify({ userId: "attacker", exp: Date.now() + 60_000 })).toString("base64url");
    assert.equal(verifySetupToken(`${forged}.${sig}`), null);
    assert.equal(verifySetupToken(`${encoded}.deadbeef`), null);
  });

  test("rejects a malformed token", () => {
    assert.equal(verifySetupToken(""), null);
    assert.equal(verifySetupToken("no-dot"), null);
    assert.equal(verifySetupToken("a.b.c"), null);
  });

  test("rejects an expired token", () => {
    // Forge a correctly-signed but already-expired token using the same secret.
    const encoded = Buffer.from(JSON.stringify({ typ: "setup", userId: "u", exp: Date.now() - 1 })).toString("base64url");
    const sig = createHmac("sha256", process.env.NEXTAUTH_SECRET!).update(encoded).digest("base64url");
    assert.equal(verifySetupToken(`${encoded}.${sig}`), null);
  });
});

describe("login-lockout.isLocked", () => {
  test("locked only while lockedUntil is in the future", () => {
    assert.equal(isLocked({ lockedUntil: null }), false);
    assert.equal(isLocked({ lockedUntil: new Date(Date.now() + 60_000) }), true);
    assert.equal(isLocked({ lockedUntil: new Date(Date.now() - 60_000) }), false);
  });
});

describe("password (argon2id)", () => {
  test("verify accepts the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword(hash, "correct horse battery staple"), true);
    assert.equal(await verifyPassword(hash, "Correct Horse Battery Staple"), false);
  });

  test("each hash is salted (same password -> different hash)", async () => {
    assert.notEqual(await hashPassword("same"), await hashPassword("same"));
  });
});

describe("totp", () => {
  test("a fresh secret is a non-empty base32-ish string", () => {
    const secret = generateTotpSecret();
    assert.equal(typeof secret, "string");
    assert.ok(secret.length > 0);
  });

  test("rejects an obviously-wrong code", async () => {
    const secret = generateTotpSecret();
    assert.equal(await verifyTotpCode(secret, "abc"), false);
    assert.equal(await verifyTotpCode(secret, ""), false);
    assert.equal(await verifyTotpCode(secret, "000000"), false);
  });

  test("accepts a code generated for the same secret", async () => {
    const { generate } = await import("otplib");
    const secret = generateTotpSecret();
    const token = await generate({ secret });
    assert.equal(await verifyTotpCode(secret, token), true);
  });
});

// The two self-contained tokens that bridge WebAuthn's two-request
// ceremonies (src/lib/webauthn-token.ts) — same signed-payload idiom as
// setup-token above, so the same tamper/expiry coverage applies.
describe("webauthn-token challenge token", () => {
  test("round-trips purpose, userId and challenge", () => {
    const token = createChallengeToken("register", "user-1", "the-challenge");
    assert.deepEqual(verifyChallengeToken(token, "register"), {
      purpose: "register",
      userId: "user-1",
      challenge: "the-challenge",
      exp: verifyChallengeToken(token, "register")!.exp,
    });
  });

  test("rejects a purpose mismatch (a register token can't login-verify)", () => {
    const token = createChallengeToken("register", "user-1", "c");
    assert.equal(verifyChallengeToken(token, "login"), null);
  });

  test("rejects a tampered payload (signature no longer matches)", () => {
    const [, sig] = createChallengeToken("login", "user-1", "c").split(".");
    const forged = Buffer.from(
      JSON.stringify({ purpose: "login", userId: "attacker", challenge: "c", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    assert.equal(verifyChallengeToken(`${forged}.${sig}`, "login"), null);
  });

  test("rejects an expired token", () => {
    const encoded = Buffer.from(
      JSON.stringify({ purpose: "login", userId: "user-1", challenge: "c", exp: Date.now() - 1 }),
    ).toString("base64url");
    const sig = createHmac("sha256", process.env.NEXTAUTH_SECRET!).update(encoded).digest("base64url");
    assert.equal(verifyChallengeToken(`${encoded}.${sig}`, "login"), null);
  });

  test("rejects a malformed token", () => {
    assert.equal(verifyChallengeToken("", "login"), null);
    assert.equal(verifyChallengeToken("no-dot", "login"), null);
  });

  test("a login challenge carries userId: null (identity isn't known until login-verify resolves it)", () => {
    const token = createChallengeToken("login", null, "c");
    assert.deepEqual(verifyChallengeToken(token, "login"), {
      purpose: "login",
      userId: null,
      challenge: "c",
      exp: verifyChallengeToken(token, "login")!.exp,
    });
  });
});

describe("webauthn-token login-verified token", () => {
  test("decodes back to the exact userId it was issued for", () => {
    const token = createLoginVerifiedToken("user-1");
    assert.deepEqual(decodeLoginVerifiedToken(token), { userId: "user-1" });
  });

  test("rejects an expired token", () => {
    const encoded = Buffer.from(
      JSON.stringify({ typ: "webauthn-login-verified", userId: "user-1", exp: Date.now() - 1 }),
    ).toString("base64url");
    const sig = createHmac("sha256", process.env.NEXTAUTH_SECRET!).update(encoded).digest("base64url");
    assert.equal(decodeLoginVerifiedToken(`${encoded}.${sig}`), null);
  });

  test("rejects a tampered payload (signature no longer matches)", () => {
    const [, sig] = createLoginVerifiedToken("user-1").split(".");
    const forged = Buffer.from(JSON.stringify({ userId: "attacker", exp: Date.now() + 60_000 })).toString(
      "base64url",
    );
    assert.equal(decodeLoginVerifiedToken(`${forged}.${sig}`), null);
  });

  test("rejects a malformed token", () => {
    assert.equal(decodeLoginVerifiedToken("garbage"), null);
  });
});

// Every token kind is signed with the same NEXTAUTH_SECRET, so a valid token
// of one kind must never verify as another — 2026-10-05: a setup/invite link
// ({userId, exp}, 7-day TTL) decoded as a login-verified token, i.e. a full
// sign-in with no password and no TOTP.
describe("signed tokens don't cross-verify", () => {
  test("a setup token is not a login-verified token", () => {
    assert.equal(decodeLoginVerifiedToken(createSetupToken("user-1")), null);
  });

  test("a login-verified token is not a setup token", () => {
    assert.equal(verifySetupToken(createLoginVerifiedToken("user-1")), null);
  });

  test("a legacy untyped {userId, exp} payload verifies as neither", () => {
    const encoded = Buffer.from(JSON.stringify({ userId: "user-1", exp: Date.now() + 60_000 })).toString("base64url");
    const sig = createHmac("sha256", process.env.NEXTAUTH_SECRET!).update(encoded).digest("base64url");
    assert.equal(decodeLoginVerifiedToken(`${encoded}.${sig}`), null);
    assert.equal(verifySetupToken(`${encoded}.${sig}`), null);
  });

  test("challenge tokens are neither", () => {
    const token = createChallengeToken("login", "user-1", "c");
    assert.equal(decodeLoginVerifiedToken(token), null);
    assert.equal(verifySetupToken(token), null);
  });
});
