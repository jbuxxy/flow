import { sign, verifySignature } from "@/lib/signed-token";

// A minimal HMAC-signed, time-limited token used to carry a userId to the
// account-setup flow (/setup-totp — sets a password if none exists yet,
// then TOTP enrollment when required) before any real NextAuth session
// exists. Never carries a password or grants app access on its own.
//
// 7 days, not the 15 minutes this originally shipped with (2026-08-18) —
// that fit the old flow, where the owner handed over an already-set
// temporary password and this link in the same conversation. Now the
// invitee sets their own password here, asynchronously (the owner just
// copies/sends the link whenever), so it needs to survive them not
// clicking it right away.
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Every token signed with NEXTAUTH_SECRET shares one HMAC key, so each kind
// carries its own `typ` and every verifier rejects any other. Without it a
// setup token ({userId, exp}) was byte-for-byte a valid webauthn
// login-verified token too — a 7-day setup/invite link doubled as a
// password-and-TOTP-free sign-in (2026-10-05 review).
const TYP = "setup";

export function createSetupToken(userId: string): string {
  const payload = JSON.stringify({ typ: TYP, userId, exp: Date.now() + TTL_MS });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifySetupToken(token: string): { userId: string } | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  if (!verifySignature(encoded, signature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    if (payload.typ !== TYP) return null;
    if (typeof payload.userId !== "string" || typeof payload.exp !== "number")
      return null;
    if (Date.now() > payload.exp) return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
