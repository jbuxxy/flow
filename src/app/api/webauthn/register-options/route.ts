import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildRegistrationOptions } from "@/lib/webauthn";
import { createChallengeToken } from "@/lib/webauthn-token";

// Step 1 of "Add a Passkey" (Settings) — issues a fresh WebAuthn
// registration challenge for the CURRENT session's user, scoped to a
// browser that's already fully signed in (this never runs pre-login;
// enrollment is deliberately settings-only, not part of account creation).
export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Can't happen in practice — a session only exists once its own name/
  // email/passwordHash were all set together (see the schema's own
  // comment on User.name) — but the schema allows null, so TypeScript
  // needs the explicit guard. Re-bound to fresh consts (not just narrowed
  // in place) since property narrowing on `user.email`/`user.name`
  // wouldn't survive the `await` below.
  const { id, email, name } = user;
  if (!email || !name) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const existing = await db.webAuthnCredential.findMany({
    where: { userId: id },
    select: { credentialId: true, publicKey: true, counter: true, transports: true },
  });

  const options = await buildRegistrationOptions({ id, email, name }, existing);
  const token = createChallengeToken("register", id, options.challenge);

  return NextResponse.json({ options, token }, { headers: { "Cache-Control": "no-store" } });
}
