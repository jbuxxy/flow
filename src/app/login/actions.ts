"use server";

import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { isLocked, recordFailedLogin } from "@/lib/login-lockout";

export type PrecheckResult =
  | { ok: true; offerPasskeySetup: boolean }
  | { ok: false; error: string };

// Validates email+password only — no session, no second factor — so the
// login page can gate opening the authenticator-code step on a real check
// instead of just a UI step. The actual sign-in (src/lib/auth.ts's
// authorize()) is still the sole thing that ever creates a session; this
// duplicates the password check but never records success/resets lockout
// state itself, so it can't be used as a shortcut around the real gate.
//
// Only ever reached via the "sign in with password instead" fallback —
// the primary passkey path (src/app/api/webauthn/login-options +
// login-verify) is fully passwordless and never calls this at all.
export async function precheckLogin(email: string, password: string): Promise<PrecheckResult> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) {
    return { ok: false, error: "Enter your email and password." };
  }

  const user = await db.user.findUnique({ where: { email: normalizedEmail } });
  const genericError = "Couldn't sign in. Check your email and password.";
  // Generic failure for unknown users — avoids revealing which emails exist.
  if (!user) return { ok: false, error: genericError };

  if (isLocked(user)) {
    return { ok: false, error: "Too many failed attempts. Try again in a few minutes." };
  }

  // Invited but hasn't finished setup yet — same generic failure as an
  // unknown email/wrong password (see auth.ts's own identical guard).
  if (!user.passwordHash) return { ok: false, error: genericError };

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    await recordFailedLogin(user.id);
    return { ok: false, error: genericError };
  }

  // Offer to set up a passkey right after this sign-in completes, so a
  // password-only account isn't stuck taking the slow path forever — but
  // only once TOTP enrollment is actually done (registering a passkey needs
  // an authenticated session, which requires having finished that first)
  // and only for an account with zero passkeys already on file.
  const offerPasskeySetup =
    user.totpEnabled &&
    (await db.webAuthnCredential.count({ where: { userId: user.id } })) === 0;

  return { ok: true, offerPasskeySetup };
}
