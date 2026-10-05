import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { verifyRegistration, guessDeviceNickname } from "@/lib/webauthn";
import { verifyChallengeToken } from "@/lib/webauthn-token";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

// Step 2 of "Add a Passkey" — checks the browser's attestation against the
// challenge issued by register-options, then stores the new credential.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.token !== "string" || !body.response) {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const payload = verifyChallengeToken(body.token, "register");
  if (!payload || payload.userId !== session.user.id) {
    return NextResponse.json({ error: "That setup attempt expired. Try again." }, { status: 400 });
  }

  let verified;
  try {
    verified = await verifyRegistration(body.response as RegistrationResponseJSON, payload.challenge);
  } catch {
    return NextResponse.json({ error: "Couldn't verify that passkey. Try again." }, { status: 400 });
  }
  if (!verified.verified || !verified.registrationInfo) {
    return NextResponse.json({ error: "Couldn't verify that passkey. Try again." }, { status: 400 });
  }

  const { credential } = verified.registrationInfo;
  const nickname =
    typeof body.nickname === "string" && body.nickname.trim()
      ? body.nickname.trim().slice(0, 60)
      : guessDeviceNickname(request.headers.get("user-agent"));

  try {
    await db.webAuthnCredential.create({
      data: {
        userId: session.user.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        nickname,
      },
    });
  } catch {
    // credentialId's unique constraint — the same physical authenticator is
    // already registered (to this user or, unusually, a different one).
    // excludeCredentials (webauthn.ts) stops this for the common case;
    // this is the backstop.
    return NextResponse.json({ error: "That passkey is already registered." }, { status: 409 });
  }
  await db.auditLog.create({
    data: { userId: session.user.id, action: "PASSKEY_REGISTERED", detail: { nickname } },
  });

  return NextResponse.json({ ok: true, nickname }, { headers: { "Cache-Control": "no-store" } });
}
