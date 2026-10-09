import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isDisallowedIp } from "@/lib/ssrf-guard";

describe("isDisallowedIp", () => {
  test("blocks IPv4 loopback and private ranges", () => {
    assert.equal(isDisallowedIp("127.0.0.1"), true);
    assert.equal(isDisallowedIp("10.0.0.5"), true);
    assert.equal(isDisallowedIp("172.16.0.1"), true);
    assert.equal(isDisallowedIp("172.31.255.255"), true);
    assert.equal(isDisallowedIp("192.168.1.50"), true); // 192.168.0.0/16
  });

  test("blocks link-local (incl. cloud metadata) and CGNAT", () => {
    assert.equal(isDisallowedIp("169.254.169.254"), true);
    assert.equal(isDisallowedIp("100.64.0.1"), true);
    assert.equal(isDisallowedIp("100.127.255.255"), true);
  });

  test("172.x outside the 16-31 second octet is public", () => {
    assert.equal(isDisallowedIp("172.15.0.1"), false);
    assert.equal(isDisallowedIp("172.32.0.1"), false);
  });

  test("allows real public IPv4 addresses", () => {
    assert.equal(isDisallowedIp("8.8.8.8"), false);
    assert.equal(isDisallowedIp("1.1.1.1"), false);
  });

  test("blocks IPv6 loopback, unique-local, and link-local", () => {
    assert.equal(isDisallowedIp("::1"), true);
    assert.equal(isDisallowedIp("fc00::1"), true);
    assert.equal(isDisallowedIp("fd12:3456::1"), true);
    assert.equal(isDisallowedIp("fe80::1"), true);
  });

  test("blocks an IPv4-mapped IPv6 private address", () => {
    assert.equal(isDisallowedIp("::ffff:127.0.0.1"), true);
    assert.equal(isDisallowedIp("::ffff:8.8.8.8"), false);
  });

  // Real finding, 2026-09-12 code review: the old dotted-decimal-only regex
  // never matched this equivalent pure-hex notation of the same addresses,
  // letting it straight through as "allowed."
  test("blocks the pure-hex-group notation of an IPv4-mapped private address", () => {
    assert.equal(isDisallowedIp("::ffff:7f00:1"), true); // = ::ffff:127.0.0.1
    assert.equal(isDisallowedIp("::ffff:a9fe:a9fe"), true); // = 169.254.169.254 (cloud metadata)
    assert.equal(isDisallowedIp("0:0:0:0:0:ffff:7f00:1"), true); // fully expanded, no "::"
    assert.equal(isDisallowedIp("::ffff:808:808"), false); // = ::ffff:8.8.8.8, public
  });

  test("allows a real public IPv6 address", () => {
    assert.equal(isDisallowedIp("2606:4700:4700::1111"), false);
  });

  test("blocks all of fe80::/10, not just the literal fe80 prefix", () => {
    assert.equal(isDisallowedIp("fe90::1"), true);
    assert.equal(isDisallowedIp("febf::1"), true);
    assert.equal(isDisallowedIp("fec0::1"), true); // site-local
    assert.equal(isDisallowedIp("ff02::1"), true); // multicast
  });

  test("checks IPv4 embedded in compatible, NAT64 and 6to4 addresses", () => {
    assert.equal(isDisallowedIp("::10.0.0.5"), true);
    assert.equal(isDisallowedIp("64:ff9b::a00:5"), true);
    assert.equal(isDisallowedIp("64:ff9b::808:808"), false);
    assert.equal(isDisallowedIp("64:ff9b:1::1"), true);
    assert.equal(isDisallowedIp("2002:c0a8:0101::1"), true); // 6to4 of 192.168.1.1
    assert.equal(isDisallowedIp("2001:0:4136:e378::1"), true); // Teredo
  });

  test("blocks IPv4 multicast, broadcast and benchmarking ranges", () => {
    assert.equal(isDisallowedIp("224.0.0.1"), true);
    assert.equal(isDisallowedIp("255.255.255.255"), true);
    assert.equal(isDisallowedIp("198.18.0.1"), true);
  });

  test("allows a real public IPv6 address", () => {
    assert.equal(isDisallowedIp("2606:4700:4700::1111"), false);
  });
});
