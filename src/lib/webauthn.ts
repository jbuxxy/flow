// Shared WebAuthn (passkey) configuration and thin wrappers around
// @simplewebauthn/server — Face ID / Touch ID / Windows Hello / a hardware
// key as a fully PASSWORDLESS sign-in (not a second factor bolted onto a
// password — the passkey alone is the whole login). Password + TOTP remain
// as a parallel fallback path (authorize(), src/lib/auth.ts) for the first
// sign-in on a device with no passkey yet, or anyone who never registers
// one; the two paths never mix on a single attempt.
//
// Two ceremonies, each spanning two HTTP requests with no server-side
// session to bridge them on (JWT sessions, no DB adapter) — the challenge
// is instead round-tripped through a short-lived signed token (see
// webauthn-token.ts), the same self-contained-token idiom setup-token.ts
// uses for the TOTP-enrollment link:
//   registration — src/app/api/webauthn/register-options + register-verify,
//     driven from Settings (an already-signed-in user adds a passkey for
//     the browser/device they're currently on; needs an authenticated
//     session, so this is deliberately never part of account creation)
//   authentication — src/app/api/webauthn/login-options (unauthenticated,
//     asks for nothing — a discoverable-credential login lets the browser/
//     OS show its own picker, no email typed first) + login-verify (checks
//     the assertion, resolves WHO it is from the credential's own owner,
//     hands back a token authorize() accepts as a complete, password-free
//     sign-in)
//
// rpID/origin are derived from NEXTAUTH_URL rather than a second env var —
// dev (http://localhost:3000) and a prod domain (https://flow.example.com)
// both just work, since WebAuthn treats "localhost" as a secure context
// even over plain http.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

export const RP_NAME = "Flow";

function nextAuthUrl(): URL {
  const raw = process.env.NEXTAUTH_URL;
  if (!raw) throw new Error("NEXTAUTH_URL is not set");
  return new URL(raw);
}

export function rpID(): string {
  return nextAuthUrl().hostname;
}

export function expectedOrigin(): string {
  return nextAuthUrl().origin;
}

// The subset of WebAuthnCredential (Prisma model) every ceremony needs —
// callers pass their own DB rows in, this file stays DB-agnostic.
export type CredentialForCeremony = {
  credentialId: string;
  publicKey: string; // base64url-encoded COSE public key
  counter: bigint;
  transports: string[];
};

export async function buildRegistrationOptions(
  user: { id: string; email: string; name: string },
  existingCredentials: CredentialForCeremony[],
) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(),
    userName: user.email,
    userDisplayName: user.name,
    // The account picker never shows this — it's the opaque handle a
    // synced passkey uses to tell "same person, different device" apart.
    // The user's own cuid is a fine, already-unique choice.
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // Stops the same physical authenticator being registered twice for one
    // user — the browser sees its own credential in this list and refuses.
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      // "platform" — Face ID / Touch ID / Windows Hello, not a roaming
      // hardware key; residentKey "preferred" so the OS offers an account
      // picker later without needing autofill UI wired up; "required"
      // verification is what actually makes this Face ID and not just
      // "this device was present."
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
  });
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigin(),
    expectedRPID: rpID(),
    requireUserVerification: true,
  });
}

// Empty/omitted `credentials` (the normal case — a passwordless login never
// knows who's signing in yet) leaves `allowCredentials` unset entirely
// (never an empty array — the two aren't guaranteed equivalent across
// authenticators), which is what tells the browser "show me whichever of
// this RP's DISCOVERABLE passkeys are on this device" instead of narrowing
// to a specific list. Every passkey this app registers already asks for a
// resident/discoverable credential (residentKey: "preferred",
// buildRegistrationOptions above), so this just works.
export async function buildAuthenticationOptions(credentials: CredentialForCeremony[] = []) {
  return generateAuthenticationOptions({
    rpID: rpID(),
    ...(credentials.length > 0
      ? {
          allowCredentials: credentials.map((c) => ({
            id: c.credentialId,
            transports: c.transports as AuthenticatorTransportFuture[],
          })),
        }
      : {}),
    // Deliberately "required" — Face ID/Touch ID/Windows Hello specifically,
    // not just "some registered device is present." This IS the entire
    // login, not a second factor layered on a password, so it has to be at
    // least as strong as one.
    userVerification: "required",
  });
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: CredentialForCeremony,
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigin(),
    expectedRPID: rpID(),
    requireUserVerification: true,
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, "base64url"),
      counter: Number(credential.counter),
      transports: credential.transports as AuthenticatorTransportFuture[],
    },
  });
}

// A rough, good-enough device label guessed from the registering browser's
// own User-Agent — shown as the default nickname (editable after) so a
// settings list reads "iPhone" / "Windows PC" instead of a raw credential
// id. Deliberately coarse; precision here isn't worth a UA-parsing
// dependency for a cosmetic default.
export function guessDeviceNickname(userAgent: string | null): string {
  const ua = (userAgent ?? "").toLowerCase();
  if (/iphone/.test(ua)) return "iPhone";
  if (/ipad/.test(ua)) return "iPad";
  if (/macintosh|mac os x/.test(ua) && !/iphone|ipad/.test(ua)) return "Mac";
  if (/android/.test(ua)) return "Android Device";
  if (/windows/.test(ua)) return "Windows PC";
  if (/linux/.test(ua)) return "Linux PC";
  return "New Device";
}
