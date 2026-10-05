// Browser-side halves of WebAuthn's two ceremonies — registration (Settings'
// "Add a Passkey" button, and the login page's post-sign-in "Set Up Face
// ID?" offer) and the fully passwordless login itself (the login page's
// primary "Sign In with Passkey" button). Client-only (imports
// @simplewebauthn/browser); only ever imported from components already
// marked "use client".

import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

export type WebauthnResult<T> = { ok: true; value: T } | { ok: false; error: string; cancelled: boolean };

// A `NotAllowedError` covers both "the person tapped Cancel" and "the
// browser/OS declined without asking" (no biometric enrolled, a non-
// user-gesture call, an unsupported browser, no discoverable passkey found
// for this login) — there's no finer signal than that from the API, so
// callers treat it uniformly as "not this time," never as a hard failure
// worth alarming over.
function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "NotAllowedError";
}

export async function registerPasskey(nickname?: string): Promise<WebauthnResult<{ nickname: string }>> {
  const optionsRes = await fetch("/api/webauthn/register-options", { method: "POST" });
  if (!optionsRes.ok) {
    return { ok: false, error: "Couldn't start passkey setup. Try again.", cancelled: false };
  }
  const { options, token }: { options: PublicKeyCredentialCreationOptionsJSON; token: string } =
    await optionsRes.json();

  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    return {
      ok: false,
      error: isCancelled(err) ? "Cancelled." : "Couldn't set up that passkey on this device.",
      cancelled: isCancelled(err),
    };
  }

  const verifyRes = await fetch("/api/webauthn/register-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response, token, nickname }),
  });
  const data = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok) {
    return { ok: false, error: data.error ?? "Couldn't set up that passkey.", cancelled: false };
  }
  return { ok: true, value: { nickname: data.nickname } };
}

// The whole passwordless login, start to finish: fetch a discoverable-
// credential challenge (no email needed — the browser/OS shows its own
// picker of whichever of this app's passkeys already live on the device),
// run Face ID / Touch ID / Windows Hello, then trade the verified assertion
// for the short-lived token authorize() (src/lib/auth.ts) accepts as a
// complete, password-free proof of identity. Never calls signIn() itself —
// the login page still owns that, passing the returned webauthnToken
// straight through.
export async function signInWithPasskey(): Promise<WebauthnResult<{ webauthnToken: string }>> {
  const optionsRes = await fetch("/api/webauthn/login-options", { method: "POST" });
  if (!optionsRes.ok) {
    return { ok: false, error: "Couldn't start passkey sign-in. Try again.", cancelled: false };
  }
  const { options, token: challengeToken } = await optionsRes.json();

  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    return {
      ok: false,
      error: isCancelled(err) ? "Cancelled." : "Couldn't sign in with a passkey on this device.",
      cancelled: isCancelled(err),
    };
  }

  const verifyRes = await fetch("/api/webauthn/login-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response, token: challengeToken }),
  });
  const data = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok) {
    return { ok: false, error: data.error ?? "Couldn't verify with that passkey.", cancelled: false };
  }
  return { ok: true, value: { webauthnToken: data.token } };
}
