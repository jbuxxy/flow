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
    const [a, b, c] = address.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    if (a === 0) return true; // "this network"
    if (a >= 224) return true; // multicast, reserved, broadcast
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (RFC2544)
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    return false;
  }
  if (net.isIPv6(address)) {
    // Every check runs on the expanded hex groups, never on a string prefix:
    // a prefix test like startsWith("fe80") missed the rest of fe80::/10
    // (fe90::–febf::), and a dotted-only regex once missed the pure-hex
    // spelling of an IPv4-mapped address (::ffff:7f00:1, 2026-09-12 review).
    const groups = expandIPv6(address.toLowerCase());
    if (!groups) return true; // fail closed
    const g = groups.map((x) => parseInt(x, 16));
    if (g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true;
    const embeddedV4 = (hi: number, lo: number) =>
      `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

    if (g.slice(0, 6).every((x) => x === 0)) {
      // ::, ::1, and the deprecated IPv4-compatible ::a.b.c.d
      if (g[6] === 0) return true;
      return isDisallowedIp(embeddedV4(g[6], g[7]));
    }
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return isDisallowedIp(embeddedV4(g[6], g[7])); // IPv4-mapped
    }
    if (g[0] === 0x64 && g[1] === 0xff9b) {
      if (g[2] !== 0) return true; // 64:ff9b:1::/48 local-use NAT64
      return isDisallowedIp(embeddedV4(g[6], g[7])); // well-known NAT64 prefix
    }
    if (g[0] === 0x2002) return isDisallowedIp(embeddedV4(g[1], g[2])); // 6to4
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo (embeds an obfuscated v4)
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
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

const MAX_REDIRECTS = 5;

// fetch() for a household-supplied URL. Plain fetch follows redirects on
// its own, so checking only the first URL let a public host 30x the server
// onto 127.0.0.1 / the LAN (2026-10-08 review) — this follows them by hand
// and re-runs assertPublicUrl on every hop. Credentials (an Authorization
// header) are dropped on a cross-origin hop, same as fetch's own behavior.
export async function fetchPublic(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let url = rawUrl;
  let reqInit: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, reqInit);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;

    const next = new URL(location, url);
    if (next.origin !== new URL(url).origin && reqInit.headers) {
      const headers = new Headers(reqInit.headers);
      headers.delete("authorization");
      reqInit = { ...reqInit, headers };
    }
    // 307/308 keep the method and body; every other redirect becomes a GET.
    if (res.status !== 307 && res.status !== 308) {
      reqInit = { ...reqInit, method: "GET", body: undefined };
    }
    url = next.toString();
  }
  throw new Error("Too many redirects.");
}
