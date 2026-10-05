import { randomBytes } from "node:crypto";
import { headers } from "next/headers";

// 6 bytes -> 8 base64url characters (~48 bits) — short enough to survive a
// mobile copy/paste intact (the actual problem this replaced: a ~150+
// character signed token silently truncating under a partial text
// selection, which reads as "expired" with no indication anything was cut
// off), while this alone is never the credential — see the schema's own
// comment on User.inviteCode. /invite/[code] just looks it up and mints a
// fresh signed setup-token server-side before redirecting.
export function generateInviteCode(): string {
  return randomBytes(6).toString("base64url");
}

export const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches setup-token.ts's own TTL

// The origin an invite link should point at — derived from the request the
// household is actually making right now (works whether that's the public
// domain, a local-network IP, a Tailscale hostname, whatever), not a fixed
// NEXTAUTH_URL. A household reached two different ways (public domain from
// outside, bare LAN IP from home) wants the link to match wherever the
// owner issuing it is standing, not always the public one (real request,
// 2026-09-24). Falls back to NEXTAUTH_URL only when headers() genuinely has
// nothing to offer (never expected in a real request, just a safety net).
export async function resolveAppOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  return process.env.NEXTAUTH_URL ?? "";
}
