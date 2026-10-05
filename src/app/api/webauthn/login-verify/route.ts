import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isLocked, recordFailedLogin } from "@/lib/login-lockout";
import { verifyAuthentication } from "@/lib/webauthn";
import { verifyChallengeToken, createLoginVerifiedToken } from "@/lib/webauthn-token";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

// Deliberately unauthenticated — this runs BEFORE any session exists, as
// the second half of a fully passwordless login (see login-options/
// route.ts, which issues the challenge with no idea who's signing in yet —
// a discoverable-credential login never asks for an email first). Checks
// the Face ID / Touch ID / Windows Hello assertion, resolves WHO it belongs
// to from the credential's own `@unique` credentialId (not from anything
// the challenge token knew going in), then hands back a short-lived token
// authorize() (src/lib/auth.ts) accepts as a complete, password-free proof
// of identity. Does NOT itself create a session or touch next-auth.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.token !== "string" || !body.response) {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const payload = verifyChallengeToken(body.token, "login");
  if (!payload) {
    return NextResponse.json({ error: "That sign-in attempt expired. Try again." }, { status: 400 });
  }

  const response = body.response as AuthenticationResponseJSON;
  const credentialRow = await db.webAuthnCredential.findUnique({
    where: { credentialId: response.id },
    include: { user: { select: { id: true, lockedUntil: true } } },
  });
  if (!credentialRow) {
    return NextResponse.json({ error: "That passkey isn't recognized." }, { status: 400 });
  }
  if (isLocked(credentialRow.user)) {
    return NextResponse.json({ error: "Too many failed attempts. Try again in a few minutes." }, { status: 400 });
  }

  // Same lockout counter password login uses (login-lockout.ts) — a failed
  // assertion here counts against the account it claimed to be just like a
  // wrong password would, so this path can't be hammered indefinitely with
  // no backoff just because the credentialId itself isn't a guessable secret.
  let verified;
  try {
    verified = await verifyAuthentication(response, payload.challenge, credentialRow);
  } catch {
    await recordFailedLogin(credentialRow.userId);
    return NextResponse.json({ error: "Couldn't verify that passkey. Try again." }, { status: 400 });
  }
  if (!verified.verified) {
    await recordFailedLogin(credentialRow.userId);
    return NextResponse.json({ error: "Couldn't verify that passkey. Try again." }, { status: 400 });
  }

  await db.webAuthnCredential.update({
    where: { id: credentialRow.id },
    data: { counter: BigInt(verified.authenticationInfo.newCounter), lastUsedAt: new Date() },
  });
  await db.auditLog.create({
    data: {
      userId: credentialRow.userId,
      action: "PASSKEY_LOGIN_SUCCESS",
      detail: { nickname: credentialRow.nickname },
    },
  });

  return NextResponse.json(
    { token: createLoginVerifiedToken(credentialRow.userId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
