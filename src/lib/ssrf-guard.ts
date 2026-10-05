// Shared guard for every place this app makes an outbound request to a
// household-supplied host: SimpleFIN setup tokens/access URLs
// (src/lib/simplefin.ts) and IMAP mailbox settings (src/lib/email-provider.ts).
// Without it, a household member (or a crafted "setup token"/mailbox host
// handed to one) could point either integration at an address on the LAN
// this app itself runs on — Postgres, another container, a router admin
// page — turning a bank-sync or email feature into an SSRF pivot. Resolves
// the hostname and checks every returned address, not just the literal
// string, so "localhost" or a DNS name that merely points at an internal IP
// is caught the same as a literal 127.0.0.1. This is DNS-rebinding-aware at
// the granularity of "checked again on every connection" (both the
// setup-token claim and every subsequent SimpleFIN sync re-resolve; the
// IMAP mailbox check runs at save time and again at the start of every
// poll) — not full IP-pinning of the resolved address into the connection,
// which would be substantially more code for a self-hosted single-household
// app where the caller is always an already-authenticated member.

import dns from "node:dns/promises";
import net from "node:net";

// Expands any IPv6 literal net.isIPv6 already accepted into its 8 hex
// groups — handling both `::` zero-compression and a trailing embedded
// dotted-decimal IPv4 tail (`::ffff:127.0.0.1`), so an IPv4-mapped address
// can be recognized regardless of which of the two equivalent notations
// (dotted tail vs. pure hex groups, e.g. `::ffff:7f00:1`) it was written in.
// Returns null on anything that doesn't cleanly parse to 8 groups — callers
// fail closed on null.
function expandIPv6(address: string): string[] | null {
  const addr = address.split("%")[0]; // strip a zone id (fe80::1%eth0), if any
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): string[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const last = parts[parts.length - 1];
    if (last.includes(".")) {
      // A dotted-decimal tail counts as the final two hex groups.
      const octets = last.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
      const hi = ((octets[0] << 8) | octets[1]).toString(16);
      const lo = ((octets[2] << 8) | octets[3]).toString(16);
      return [...parts.slice(0, -1), hi, lo];
    }
    return parts;
  };

  const head = parseSide(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head.map((g) => g.toLowerCase()) : null;

  const tail = parseSide(halves[1] ?? "");
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill("0"), ...tail].map((g) => g.toLowerCase());
}

// Exported for direct unit testing (test/lib/ssrf-guard.test.ts) — the
// rest of this module does real DNS lookups, which a pure-logic unit test
// suite (see scripts/test.sh) deliberately never touches.
export function isDisallowedIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    if (a === 0) return true; // "this network"
    return false;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("fe80")) return true; // link-local
    // IPv4-mapped (::ffff:x.x.x.x) — groups 0-4 all zero, group 5 = ffff.
    // Checked via the expanded hex groups, not a dotted-decimal-only regex,
    // so the equivalent pure-hex notation (::ffff:7f00:1, same address as
    // ::ffff:127.0.0.1) can't slip past this the way it used to (real
    // finding, 2026-09-12 code review: a household member could set the
    // IMAP/SimpleFIN host literal to that hex form and bypass this guard
    // entirely, since net.isIP() accepts it as a valid literal and the old
    // regex never matched it).
    const groups = expandIPv6(lower);
    if (groups && groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
      const g6 = parseInt(groups[6], 16);
      const g7 = parseInt(groups[7], 16);
      const dotted = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
      return isDisallowedIp(dotted);
    }
    return false;
  }
  // Not a literal address we recognize — fail closed.
  return true;
}

// Throws when `hostname` resolves to (or literally is) a non-public
// address. Call this immediately before opening any connection to a
// household-supplied host, not just once at save time.
export async function assertPublicHost(hostname: string): Promise<void> {
  const literal = net.isIP(hostname) ? hostname : null;
  const addresses = literal
    ? [literal]
    : await dns.lookup(hostname, { all: true, verbatim: true }).then(
        (rows) => rows.map((r) => r.address),
        () => {
          throw new Error("Couldn't resolve that host.");
        },
      );
  if (addresses.length === 0 || addresses.some(isDisallowedIp)) {
    throw new Error("That host isn't reachable from this app.");
  }
}

// Same check for a full URL (SimpleFIN's claim/access URLs) — validates the
// scheme too, since a `file:`/`data:` URL has no meaningful "host" to check.
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  await assertPublicHost(u.hostname);
}
