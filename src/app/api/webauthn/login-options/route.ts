import { NextResponse } from "next/server";
import { buildAuthenticationOptions } from "@/lib/webauthn";
import { createChallengeToken } from "@/lib/webauthn-token";

// Step 1 of a fully passwordless sign-in — deliberately unauthenticated and
// deliberately asks for nothing (no email, no password): a discoverable-
// credential WebAuthn login lets the browser/OS show its OWN picker of
// whichever of this app's passkeys already live on the device, so identity
// resolution happens entirely client-side + at verification, never here.
// See login-verify/route.ts for how "which user is this" actually gets
// answered (from the credential's own owner, not from anything issued
// here).
export async function POST() {
  const options = await buildAuthenticationOptions();
  const token = createChallengeToken("login", null, options.challenge);
  return NextResponse.json({ options, token }, { headers: { "Cache-Control": "no-store" } });
}
