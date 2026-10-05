import { createHmac, timingSafeEqual } from "node:crypto";

// The shared "sign a payload with NEXTAUTH_SECRET, verify it back later, no
// server-side store" primitive underneath every short-lived token in this
// app (setup-token.ts's TOTP-enrollment link, webauthn-token.ts's challenge/
// login-verified tokens) — extracted so the HMAC algorithm and the
// timing-safe comparison only ever live in one place (real finding,
// 2026-09-22 code review: the two callers had each hand-copied an identical
// secret()/sign()/compare, so a future security fix — a digest change, a key
// rotation — risked landing in only one of them).

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET is not set");
  return s;
}

export function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function verifySignature(payload: string, signature: string): boolean {
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
