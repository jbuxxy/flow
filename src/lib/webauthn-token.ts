import { sign, verifySignature } from "@/lib/signed-token";

// Two short-lived, HMAC-signed, self-contained tokens that bridge WebAuthn's
// two-request ceremonies across this app's stateless auth setup (JWT
// sessions, no DB adapter, so there's nowhere server-side to park a
// challenge between requests) — same "sign a payload, no server-side store"
// idiom setup-token.ts uses for the TOTP-enrollment link, generalized to
// carry a WebAuthn challenge or a completed verification instead of a bare
// userId.
//
//   challenge token — issued alongside generateRegistrationOptions'/
//     generateAuthenticationOptions' own `options.challenge`
//     (src/lib/webauthn.ts), round-tripped by the client on the ceremony's
//     second request so the server can confirm it's checking the SAME
//     challenge it issued. `userId` is only ever known for a REGISTER
//     challenge (an authenticated Settings user adding a passkey) — a LOGIN
//     challenge is issued with no idea who's about to sign in (that's the
//     whole point of a passwordless, discoverable-credential login: no
//     email typed first), so it carries `userId: null`.
//   login-verified token — issued once a passkey assertion has been
//     checked (POST /api/webauthn/login-verify, which resolves the userId
//     itself from the credential's OWN owner — the credentialId is
//     `@unique`, so it names exactly one user regardless of what the
//     challenge token knew going in), handed to signIn("credentials",
//     { webauthnToken }) and consumed by authorize() (src/lib/auth.ts) as a
//     complete, PASSWORDLESS proof of identity — not a stand-in for a totp
//     code, a stand-in for the whole password+2FA exchange. 60s TTL: the
//     gap between Face ID succeeding and the following signIn() call is
//     milliseconds.
//
// Neither token is single-use-tracked (no server-side store to track it
// in) — a captured valid token replayed within its TTL isn't
// cryptographically impossible the way a DB-backed one-time challenge would
// be. Acceptable given the 60s TTL on the one that actually grants a
// session, and that grabbing one at all requires already having intercepted
// a real, freshly-verified Face ID/Touch ID/Windows Hello assertion in the
// first place.

const CHALLENGE_TTL_MS = 3 * 60 * 1000; // generous — a slow Face ID prompt / retry
const LOGIN_VERIFIED_TTL_MS = 60 * 1000;

function pack(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function unpack(token: string): unknown {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  if (!verifySignature(encoded, signature)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }
}

export type WebauthnCeremonyPurpose = "register" | "login";

export type ChallengeTokenPayload = {
  purpose: WebauthnCeremonyPurpose;
  userId: string | null;
  challenge: string;
  exp: number;
};

function isChallengePayload(v: unknown): v is ChallengeTokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    (p.purpose === "register" || p.purpose === "login") &&
    (p.userId === null || typeof p.userId === "string") &&
    typeof p.challenge === "string" &&
    typeof p.exp === "number"
  );
}

export function createChallengeToken(
  purpose: WebauthnCeremonyPurpose,
  userId: string | null,
  challenge: string,
): string {
  return pack({ purpose, userId, challenge, exp: Date.now() + CHALLENGE_TTL_MS });
}

// `expectedPurpose` guards against a registration challenge token being
// replayed against the login-verify endpoint, or vice versa.
export function verifyChallengeToken(
  token: string,
  expectedPurpose: WebauthnCeremonyPurpose,
): ChallengeTokenPayload | null {
  const payload = unpack(token);
  if (!isChallengePayload(payload)) return null;
  if (payload.purpose !== expectedPurpose) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

// `typ` keeps this token distinct from every other payload signed with the
// same key — setup-token.ts's {userId, exp} used to pass this exact shape
// check, turning a setup/invite link into a full sign-in (see TYP there).
const LOGIN_VERIFIED_TYP = "webauthn-login-verified";

type LoginVerifiedPayload = { typ: typeof LOGIN_VERIFIED_TYP; userId: string; exp: number };

function isLoginVerifiedPayload(v: unknown): v is LoginVerifiedPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return p.typ === LOGIN_VERIFIED_TYP && typeof p.userId === "string" && typeof p.exp === "number";
}

export function createLoginVerifiedToken(userId: string): string {
  return pack({ typ: LOGIN_VERIFIED_TYP, userId, exp: Date.now() + LOGIN_VERIFIED_TTL_MS });
}

// Consumed by authorize() as a complete, password-free proof of identity —
// the userId comes FROM the token (signed by us, so trustworthy), not from
// anything the client separately claims. Returns null for anything
// missing/expired/tampered.
export function decodeLoginVerifiedToken(token: string): { userId: string } | null {
  const payload = unpack(token);
  if (!isLoginVerifiedPayload(payload)) return null;
  if (Date.now() > payload.exp) return null;
  return { userId: payload.userId };
}
